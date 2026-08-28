"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test__ } = require("../cli");

test("Codex HTTP exporters all carry the normalized Git email header", () => {
  const lines = __test__.buildCodexOtelBlock(
    "https://collector.example.invalid:24317",
    "http",
    { email: " Alice@Example.Invalid " },
  );
  const header = 'headers = { "x-ai-otel-git-email" = "alice@example.invalid" }';
  assert.equal(lines.filter((line) => line === header).length, 3);
});

test("Codex gRPC exporters all carry the Git email header", () => {
  const lines = __test__.buildCodexOtelBlock(
    "https://collector.example.invalid:24317",
    "grpc",
    { email: "alice@example.invalid" },
  );
  const header = 'headers = { "x-ai-otel-git-email" = "alice@example.invalid" }';
  assert.equal(lines.filter((line) => line === header).length, 3);
});

test("Codex exporters omit identity header when global Git email is unavailable", () => {
  const lines = __test__.buildCodexOtelBlock(
    "https://collector.example.invalid:24317",
    "http",
    { email: "" },
  );
  assert.equal(lines.some((line) => line.includes("x-ai-otel-git-email")), false);
});

test("Codex managed block installs SessionStart, UserPromptSubmit and Stop hooks", () => {
  const block = __test__.buildCodexOtelHookBlock(
    "https://collector.example.invalid:24317",
    "/tmp/ai-otel/on-session-start.js",
    "/tmp/ai-otel/launch-hook.js",
    "http",
    { email: "alice@example.invalid" },
  );
  assert.match(block, /\[\[hooks\.SessionStart\]\]/);
  assert.match(block, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(block, /\[\[hooks\.Stop\]\]/);
  assert.equal((block.match(/timeout = 3/g) || []).length, 3);
});

test("Codex hook cleanup removes only ai-otel lifecycle hooks", () => {
  const managedCommand = 'command = "node /home/u/.codex/ai-otel/launch-hook.js /home/u/.codex/ai-otel/on-session-start.js"';
  const input = [
    "[[hooks.SessionStart]]",
    "[[hooks.SessionStart.hooks]]",
    managedCommand,
    "",
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    managedCommand,
    "",
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    managedCommand,
    "",
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    'command = "node /home/u/custom-stop.js"',
    "",
    "[model_providers.custom]",
    'name = "custom"',
  ].join("\n");

  const output = __test__.stripAiOtelCodexHooks(input);
  assert.doesNotMatch(output, /ai-otel\/launch-hook\.js/);
  assert.match(output, /custom-stop\.js/);
  assert.match(output, /\[model_providers\.custom\]/);
});

test("Codex install writes full snapshot config and shared snapshot engine", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-codex-install-"));
  const codexDir = path.join(home, ".codex");
  const rawBodiesDir = path.join(home, ".claude", "cc-otel", "raw-bodies");
  fs.mkdirSync(codexDir, { recursive: true });

  const result = __test__.installCodex(
    home,
    "http://127.0.0.1:4317",
    "http",
    { email: "alice@example.invalid" },
    { fullUpload: true, rawBodiesDir },
  );

  assert.equal(result.status, "installed");
  const installDir = path.join(codexDir, "ai-otel");
  const cfg = JSON.parse(fs.readFileSync(path.join(installDir, "endpoint.json"), "utf8"));
  assert.equal(cfg.fullUpload, true);
  assert.equal(cfg.rawBodiesDir, rawBodiesDir);
  assert.equal(cfg.logsEndpoint, "http://127.0.0.1:4318/v1/logs");
  assert.ok(fs.existsSync(path.join(installDir, "git-snapshot.js")));

  const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  assert.equal((config.match(/\[\[hooks\.SessionStart\]\]/g) || []).length, 1);
  assert.equal((config.match(/\[\[hooks\.UserPromptSubmit\]\]/g) || []).length, 1);
  assert.equal((config.match(/\[\[hooks\.Stop\]\]/g) || []).length, 1);

  __test__.installCodex(
    home,
    "http://127.0.0.1:4317",
    "http",
    { email: "alice@example.invalid" },
    { fullUpload: true, rawBodiesDir },
  );
  const reinstalled = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  assert.equal((reinstalled.match(/\[\[hooks\.SessionStart\]\]/g) || []).length, 1);
  assert.equal((reinstalled.match(/\[\[hooks\.UserPromptSubmit\]\]/g) || []).length, 1);
  assert.equal((reinstalled.match(/\[\[hooks\.Stop\]\]/g) || []).length, 1);
});
