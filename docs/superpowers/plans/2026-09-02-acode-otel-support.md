# AStudio OTLP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `ai-otel-setup` with an AStudio integration that archives `~/.acode` rollout records and workspace snapshots through the existing CC full-data OSS infrastructure.

**Architecture:** Add a pure AStudio transcript parser/OTLP envelope builder under `templates/acode`, and a command-hook runner that safely queues completed turns and dispatches the shared snapshot engine. Extend `cli.js` with idempotent `~/.acode/hooks.json` installation and full-upload configuration. Route Acode records through the Collector full pipeline and Forwarder WAL into `acode_records`; route uploaded Acode files into `acode_snapshot_files` or `acode_body_files`.

**Tech Stack:** Node.js CommonJS scripts, Node built-ins (`fs`, `crypto`, `http`, `https`), JSONL transcript parsing, OTLP/HTTP JSON logs, Node built-in test runner.

---

### Task 1: Add failing parser and OTLP contract tests

**Files:**
- Create: `test/acode-transcript.test.js`
- Test: `templates/acode/transcript-parser.js` (not yet present)

- [ ] **Step 1: Write failing tests** for session metadata, current-turn selection, user/assistant messages, function call/result, token usage, abort status, deterministic IDs, and OTLP resource/event fields. Use a small in-memory transcript fixture matching AStudio's observed `{timestamp,type,payload}` JSONL shape.

- [ ] **Step 2: Run the focused test**

Run: `node --test test/acode-transcript.test.js`
Expected: FAIL because `templates/acode/transcript-parser.js` does not exist.

- [ ] **Step 3: Commit the red tests**

```bash
git add test/acode-transcript.test.js
git commit -m "test: define AStudio transcript telemetry contract"
```

### Task 2: Implement the pure AStudio transcript parser

**Files:**
- Create: `templates/acode/transcript-parser.js`
- Test: `test/acode-transcript.test.js`

- [ ] **Step 1: Implement the minimal parser**

Implement exported functions:

```js
parseTranscript(textOrLines, hookInput)
buildOtlpLogs(parsed, options)
```

Parse `session_meta`, `task_started`/`turn_started`, `turn_context`, `response_item`, token-count events, tool lifecycle events, and completion/abort events. Select `hookInput.turn_id` when available, otherwise the final turn. Produce `agent.turn`, `llm.request`, and `tool.call` records with bounded JSON-safe values and deterministic SHA-256 trace/span IDs.

- [ ] **Step 2: Run the focused tests**

Run: `node --test test/acode-transcript.test.js`
Expected: PASS for all parser and envelope tests.

- [ ] **Step 3: Refactor only after green**

Keep parser code independent of network, filesystem, process environment, and AStudio installation paths. Re-run the focused tests after any cleanup.

- [ ] **Step 4: Commit the parser**

```bash
git add templates/acode/transcript-parser.js test/acode-transcript.test.js
git commit -m "feat: parse AStudio rollout telemetry"
```

### Task 3: Add the AStudio command hook and queue worker

**Files:**
- Create: `templates/acode/on-session-start.js`
- Create: `templates/acode/logging.js`
- Test: `test/acode-transcript.test.js`

- [ ] **Step 1: Add failing hook behavior tests** for valid Stop-hook JSON output, endpoint resolution from `endpoint.json`, and worker command construction without blocking the hook.

- [ ] **Step 2: Run the focused test**

Run: `node --test test/acode-transcript.test.js`
Expected: FAIL for the missing hook runtime.

- [ ] **Step 3: Implement the hook**

Read AStudio hook JSON from stdin. Under `fullUpload=true`, `UserPromptSubmit` dispatches the shared snapshot engine and `Stop` dispatches a snapshot plus a small transcript job. A detached `--worker` process atomically claims pending jobs, parses the transcript, posts JSON OTLP Logs to `/v1/logs`, and returns failed jobs with retry metadata. Use `endpoint.json`, optional `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, and optional configured headers; never copy provider credentials automatically.

- [ ] **Step 4: Run the focused tests**

Run: `node --test test/acode-transcript.test.js`
Expected: PASS.

- [ ] **Step 5: Commit the hook runtime**

```bash
git add templates/acode/on-session-start.js templates/acode/logging.js test/acode-transcript.test.js
git commit -m "feat: add non-blocking AStudio telemetry hook"
```

### Task 4: Add idempotent AStudio installer support

**Files:**
- Modify: `cli.js` near the existing Codex installer and main installation flow
- Create: `test/acode-config.test.js`

- [ ] **Step 1: Write failing installer tests** for `installAcode`:

  - detects a temporary `~/.acode` directory;
  - writes endpoint metadata and copies the Acode templates;
  - creates `hooks.json` with `UserPromptSubmit` and `Stop` command hooks;
  - preserves unrelated user hooks;
  - repeated installation produces one managed hook per event;
  - writes Acode-specific `tool_kind`/service metadata without changing Codex config.

- [ ] **Step 2: Run the focused test**

Run: `node --test test/acode-config.test.js`
Expected: FAIL because `installAcode` is not defined/exported.

- [ ] **Step 3: Implement `installAcode`**

Use the existing endpoint normalization helpers and hook command builder. Put AStudio files under `home/.acode/ai-otel`, copy the shared `git-snapshot.js`, write `fullUpload`, `machineId`, `rawBodiesDir` and snapshot limits to `endpoint.json`, use the Acode nested hook schema (`hooks.Event = [{ hooks: [{ type: "command", command }] }]`), and merge only installer-managed command signatures. Add the result to the installation summary. Reuse the existing Claude raw-body uploader/timer instead of installing another uploader.

- [ ] **Step 4: Call the installer from `main()`** when `~/.acode` exists, catching failures in the same way as the existing optional tool installers.

- [ ] **Step 5: Run focused installer tests**

Run: `node --test test/acode-config.test.js`
Expected: PASS.

- [ ] **Step 6: Commit installer support**

```bash
git add cli.js test/acode-config.test.js
git commit -m "feat: install AStudio OTLP hooks"
```

### Task 5: Run regression tests and static checks

Before final verification, update the server repository:

- allow `tool_kind=acode` with `agent.turn`, `llm.request`, `tool.call` and `hook_git_snapshot` only in Collector `logs/full_mongo`;
- preserve Acode identity in shared normalization;
- route Acode WAL files to `acode_records`;
- route Acode snapshot/body uploads to `acode_snapshot_files` / `acode_body_files`;
- update both the Helm-mounted K8s Collector config and the production deployment config mirror;
- add focused Collector, OSS archive and raw upload tests.

**Files:**
- Test: `test/*.js`
- Verify: `cli.js`, `templates/acode/*.js`

- [ ] **Step 1: Run all tests**

Run: `node --test test/*.js`
Expected: all tests pass with zero failures.

- [ ] **Step 2: Run syntax checks**

Run: `node --check cli.js; node --check templates/acode/transcript-parser.js; node --check templates/acode/on-session-start.js; node --check templates/acode/logging.js`
Expected: exit code 0 for every file.

- [ ] **Step 3: Run a dry installation against a temporary HOME**

Use a temporary directory with `.acode` and a temporary Git identity, invoke the exported installer test helper or CLI in a controlled environment, and verify only the temporary directory changed. Do not run against the user's real `C:\Users\zhousheng2\.acode`.

- [ ] **Step 4: Review the final diff**

Run: `git diff main...HEAD --stat; git diff main...HEAD --check; git status --short`
Expected: only the design/plan docs, AStudio templates, CLI integration, and tests are changed; no credentials or user data are present.

- [ ] **Step 5: Commit verification fixes if needed**

```bash
git add cli.js templates/acode test
git commit -m "test: verify AStudio OTLP integration"
```
