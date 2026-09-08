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
  const configPath = path.join(home, ".acode", "config.toml");
  fs.writeFileSync(configPath, [
    "[model_providers.example]",
    'name = "Example"',
    "",
    "[features]",
    "hooks = false",
    "rmcp_client = true",
    "",
  ].join("\n"));
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
    {
      machineId: "machine-acode",
      fullUpload: true,
      rawBodiesDir: path.join(home, ".claude", "cc-otel", "raw-bodies"),
    },
  );

  assert.equal(result.status, "installed");
  const installDir = path.join(home, ".acode", "ai-otel");
  const endpoint = JSON.parse(fs.readFileSync(path.join(installDir, "endpoint.json"), "utf8"));
  assert.equal(endpoint.logsEndpoint, "http://127.0.0.1:4318/v1/logs");
  assert.equal(endpoint.toolKind, "acode");
  assert.equal(endpoint.machineId, "machine-acode");
  assert.equal(endpoint.fullUpload, true);
  assert.match(endpoint.rawBodiesDir, /raw-bodies$/);
  assert.ok(fs.existsSync(path.join(installDir, "on-session-start.js")));
  assert.ok(fs.existsSync(path.join(installDir, "transcript-parser.js")));
  assert.ok(fs.existsSync(path.join(installDir, "git-snapshot.js")));

  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /\[model_providers\.example\]/);
  assert.match(config, /rmcp_client = true/);
  assert.match(config, /^hooks = true$/m);
  assert.match(config, /hooks\.state\..*user_prompt_submit:0:0/);
  assert.match(config, /hooks\.state\..*stop:\d+:0/);
  assert.equal((config.match(/trusted_hash = "sha256:[0-9a-f]{64}"/g) || []).length, 2);
  assert.equal((config.match(/enabled = true/g) || []).length, 2);

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
  fs.mkdirSync(path.join(home, ".acode", "acode", "acode-home-overlay"), { recursive: true });
  const args = [home, "https://collector.example.invalid:24317", "http", { email: "a@example.invalid" }];

  __test__.installAcode(...args);
  __test__.installAcode(...args);

  const hooks = JSON.parse(fs.readFileSync(path.join(home, ".acode", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(hooks.hooks.Stop[0].hooks.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks.length, 1);
  const config = fs.readFileSync(path.join(home, ".acode", "config.toml"), "utf8");
  assert.equal((config.match(/hooks\.state\..*user_prompt_submit:0:0/g) || []).length, 2);
  assert.equal((config.match(/hooks\.state\..*stop:0:0/g) || []).length, 2);
  assert.match(config, /acode-home-overlay(?:\\\\|\/)hooks\.json:user_prompt_submit:0:0/);
  assert.match(config, /acode-home-overlay(?:\\\\|\/)hooks\.json:stop:0:0/);
});

test("installAcode persists the full-upload opt-out", () => {
  const home = tempHome();
  __test__.installAcode(home, "http://127.0.0.1:4317", "http", { email: "a@example.invalid" }, {
    machineId: "machine-opt-out",
    fullUpload: false,
    rawBodiesDir: "",
  });
  const endpoint = JSON.parse(fs.readFileSync(path.join(home, ".acode", "ai-otel", "endpoint.json"), "utf8"));
  assert.equal(endpoint.fullUpload, false);
  assert.equal(endpoint.rawBodiesDir, "");
});
