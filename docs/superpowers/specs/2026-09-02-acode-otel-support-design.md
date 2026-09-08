# AStudio OTLP Support Design

## Goal

Extend `ai-otel-setup` so one installation can collect AStudio (`~/.acode`) model interaction data and workspace snapshots without modifying the AStudio installation. Full records must reuse the team's Collector -> Forwarder -> OSS archive path, while snapshot bundles reuse the existing raw-body uploader path.

## Context

The current installer configures Claude Code, Codex CLI, and Gemini CLI. AStudio stores provider interaction events in `~/.acode/sessions/**/rollout-*.jsonl` and invokes command hooks from `~/.acode/hooks.json`. The transcript format includes session metadata, turn contexts, assistant/user messages, reasoning, tool calls/results, and token usage snapshots.

The AStudio installation examined locally contains a separate Storage TLS integration, but the requested change is limited to this repository. The new integration therefore owns its hook and transcript conversion rather than depending on files under `D:\Programs\AStudio`.

## Design

### Installation and configuration

`cli.js` will detect `~/.acode` and call a new `installAcode` path. The path will:

- create `~/.acode/ai-otel/` with the AStudio hook, launcher, endpoint configuration, and best-effort logger;
- preserve and idempotently merge the user's `~/.acode/hooks.json`;
- register `UserPromptSubmit` and `Stop` command hooks using AStudio's command-hook schema;
- write the same normalized OTLP Logs endpoint derived by the existing installer;
- add a distinct `tool_kind=acode` identity so server-side data can be separated from Codex CLI data;
- install the shared `git-snapshot.js` and write its bundle into the existing Claude raw-body spool;
- persist `fullUpload`, machine identity, raw upload and snapshot limits in `endpoint.json`;
- avoid modifying `D:\Programs\AStudio` or any AStudio packaged resource.

The integration is installed when AStudio is detected. Transcript and snapshot collection only run when `fullUpload=true`; `--no-full-upload` disables both, matching Claude Code and Codex privacy semantics.

### Runtime data flow

`UserPromptSubmit` dispatches a detached workspace snapshot. `Stop` dispatches a detached snapshot and enqueues the completed transcript turn. A single claimed worker reads the hook JSON, uses `transcript_path` and `turn_id` to select the completed turn, parses only stable JSONL records, converts them to OTLP Logs, and posts to `/v1/logs`.

The logical records are:

```text
agent.turn
├── llm.request
└── tool.call
```

The OTLP payload uses JSON encoding, matching the existing custom hook senders in this repository. Each record carries structured fields for session/turn identity, model/provider, input/output messages, token usage, tool arguments/results, timing, status, cwd, machine identity, and source metadata. The implementation preserves the transcript's raw JSON values inside bounded batches and does not read credentials from the AStudio config.

The server-side record route is:

```text
AStudio hook -> Collector /v1/logs -> logs/full_mongo -> Forwarder :8081
  -> state/oss-wal/<date>__<HHMM>__acode.ndjson
  -> OSS cc_otel/<date>/acode_records/<HHMM>-<instance>.json
```

Only the Collector full pipeline accepts the Acode record events. The ordinary iData pipeline remains unchanged so prompt, reasoning, tool input, command, code and raw transcript content never enter the general analysis path.

Workspace snapshots use the existing file route:

```text
git-snapshot.js -> snapshot-acode-*.snapshot.bundle -> shared raw-body spool
  -> raw-body-uploader -> Forwarder :8090 init/chunk/complete
  -> OSS cc_otel/<date>/acode_snapshot_files/<filename>
```

If AStudio provider request/response body capture is added later, the same upload protocol routes files carrying `tool_kind=acode` to `cc_otel/<date>/acode_body_files/`. This change does not invent a provider raw-body source.

### Transcript mapping

The parser will support the observed AStudio/Codex-compatible records:

- `session_meta` → session, provider, conversation, cwd metadata;
- `task_started` / `turn_started` and completion events → turn boundaries and status;
- `turn_context` → model and turn metadata;
- `response_item` messages → user, assistant, tool, reasoning, and normalized message parts;
- `event_msg` tool lifecycle events → tool timing, status, and error details;
- `event_msg` `token_count` → input/output/cache/reasoning token usage;
- `task_complete`, `turn_complete`, `turn_aborted` → final turn status.

The parser will emit only the current turn when `turn_id` is available, with a fallback to the final turn. This prevents duplicate full-session uploads on every Stop hook. Repeated token snapshots will be treated as cumulative usage snapshots and de-duplicated or converted to the current turn's delta where the format permits.

### Endpoint and authentication

The Acode hook reads an endpoint file beside the installed hook, with an optional environment override for local testing. It sends `Content-Type: application/json` to the team's OTLP HTTP Logs endpoint. Authentication is configurable through an optional `OTEL_EXPORTER_OTLP_HEADERS`-style value in the Acode endpoint configuration, but the installer does not copy or expose provider bearer tokens from `~/.acode/config.toml`.

The installer reuses `resolveEndpoint` and `logsEndpointFromGrpc` so AStudio, Codex, Claude, and Gemini resolve the same team address. Snapshot bundles reuse the existing raw upload URL, timer and multipart protocol. The current Acode transcript provides structured interaction data but not the provider's original HTTP request/response body.

### Failure handling and privacy

Hook failures are best effort and must not block the user's AStudio turn. Network failures are logged locally with bounded messages. No raw credential fields, authorization headers, or full provider configuration are copied into telemetry. Message/tool content is intentionally enabled only under `fullUpload=true` and is routed exclusively through the controlled full-data archive path.

Pending transcript jobs are atomically claimed before processing so overlapping Stop hooks cannot send the same turn concurrently. Failed jobs return to the pending queue, retries use backoff timestamps, and a permanently failing old job cannot starve newer turns. Sent job markers have bounded retention.

### Tests

Tests will be added before implementation for:

- endpoint and Acode path configuration;
- idempotent merge of Acode hooks while preserving user hooks;
- parsing and mapping session/turn/message/tool/token records;
- selecting the current turn and handling completion/abort;
- valid Stop-hook JSON output and non-blocking failure behavior;
- generating an OTLP Logs envelope with `tool_kind=acode` and expected model fields.
- `--no-full-upload` suppressing transcript and snapshot capture;
- Acode snapshot naming and uploader tool identity;
- Collector full-only allowlisting and Forwarder `acode_records` routing;
- raw upload routing to `acode_snapshot_files` and `acode_body_files`;
- concurrent worker claiming and failed-job retry behavior.

Existing Claude/Codex/Gemini tests will continue to run unchanged.

## Alternatives considered

### Reconfigure AStudio's bundled Storage TLS integration

This would minimize new parser code, but couples the installer to AStudio's private packaged resources and version-specific runtime behavior. It also does not solve the observed Windows `Storage TLS startup unavailable` state independently.

### Capture AStudio's provider HTTP traffic with a proxy

This could preserve raw request and response bodies, but is more invasive, depends on provider routing and TLS behavior, and misses AStudio-level tool lifecycle semantics. It is deferred to a separate raw-capture feature.

## Non-goals

- changing AStudio binaries or packaged resources;
- collecting provider raw HTTP bodies;
- adding Acode records to the ordinary iData/dashboard pipeline;
- changing the existing Claude, Codex, or Gemini data contracts;
- installing or enabling the bundled AStudio Storage TLS plugin.
