"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test__ } = require("../cli");

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-acode-install-"));
  fs.mkdirSync(path.join(home, ".acode"), { recursive: true });
  return home;
}

function managedHook(command) {
  return {
    hooks: [{ type: "command", command }],
  };
}

test("installAcode writes endpoint and AStudio hooks while preserving user hooks", () => {
  const home = tempHome();
  const hooksPath = path.join(home, ".acode", "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [managedHook("node C:/user/custom-stop.js")],
      Notification: [managedHook("node C:/user/notification.js")],
    },
  }));

  const result = __test__.installAcode(
    home,
    "http://127.0.0.1:4317",
    "http",
    { email: "alice@example.invalid" },
  );

  assert.equal(result.status, "installed");
  const installDir = path.join(home, ".acode", "ai-otel");
  const endpoint = JSON.parse(fs.readFileSync(path.join(installDir, "endpoint.json"), "utf8"));
  assert.equal(endpoint.logsEndpoint, "http://127.0.0.1:4318/v1/logs");
  assert.equal(endpoint.toolKind, "acode");
  assert.ok(fs.existsSync(path.join(installDir, "on-session-start.js")));
  assert.ok(fs.existsSync(path.join(installDir, "transcript-parser.js")));

  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(hooks.hooks.Notification.length, 1);
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  const managed = [...hooks.hooks.Stop, ...hooks.hooks.UserPromptSubmit]
    .flatMap((group) => group.hooks || [])
    .filter((entry) => entry.command.includes(".acode/ai-otel") || entry.command.includes(".acode\\ai-otel"));
  assert.equal(managed.length, 2);
});

test("installAcode is idempotent and replaces only its managed hooks", () => {
  const home = tempHome();
  const args = [home, "https://collector.example.invalid:24317", "http", { email: "a@example.invalid" }];

  __test__.installAcode(...args);
  __test__.installAcode(...args);

  const hooks = JSON.parse(fs.readFileSync(path.join(home, ".acode", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(hooks.hooks.Stop[0].hooks.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks.length, 1);
});
