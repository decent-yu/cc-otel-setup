"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const { __test__: uploaderTest } = require("../templates/raw-body-uploader");

function git(cwd, args, env = process.env) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("raw uploader identifies Codex snapshot bundles without changing CC defaults", () => {
  assert.equal(uploaderTest.fileToolKind("snapshot-codex-session-1-stop.snapshot.bundle"), "codex");
  assert.equal(uploaderTest.fileToolKind("snapshot-session-1-stop.snapshot.bundle"), "cc");
  assert.equal(uploaderTest.fileToolKind("abc.request.json"), "cc");
});

test("Codex Stop hook returns valid JSON when snapshot upload is disabled", () => {
  const hook = path.resolve(__dirname, "../templates/codex/on-session-start.js");
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: "session-stop-test",
      turn_id: "turn-stop-test",
      hook_event_name: "Stop",
      cwd: process.cwd(),
    }),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("Codex git snapshot creates a codex bundle and hidden ref", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-codex-snapshot-"));
  const repo = path.join(tmp, "repo");
  const install = path.join(tmp, "install");
  const rawBodiesDir = path.join(tmp, "raw-bodies");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "../templates/git-snapshot.js"), path.join(install, "git-snapshot.js"));
  fs.writeFileSync(path.join(install, "endpoint.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:1",
    fullUpload: true,
    rawBodiesDir,
  }));

  git(repo, ["init"]);
  git(repo, ["config", "user.email", "snapshot-test@example.invalid"]);
  git(repo, ["config", "user.name", "Snapshot Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "baseline"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");

  const result = spawnSync(process.execPath, [path.join(install, "git-snapshot.js"),
    "--session-id=codex-session-test",
    "--hook-kind=session_start",
    "--event-kind=user_prompt",
    "--tool-kind=codex",
    "--prompt-id=turn-1",
    "--turn-id=turn-1",
    `--cwd=${repo}`,
  ], {
    encoding: "utf8",
    timeout: 20000,
  });

  assert.equal(result.status, 0, result.stderr);
  const bundles = fs.readdirSync(rawBodiesDir);
  assert.equal(bundles.length, 1);
  assert.match(bundles[0], /^snapshot-codex-codex-session-test-\d+-user_prompt\.snapshot\.bundle$/);
  const refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/snapshots/codex-session-test/"]);
  assert.match(refs, /-user_prompt$/);
});
