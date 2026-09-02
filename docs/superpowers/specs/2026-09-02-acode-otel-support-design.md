# AStudio OTLP Support Design

## Goal

Extend `ai-otel-setup` so one installation can collect AStudio (`~/.acode`) model interaction data and send it to the team's existing OTLP Logs endpoint, without modifying the AStudio installation.

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
- avoid modifying `D:\Programs\AStudio` or any AStudio packaged resource.

The new integration will be enabled by AStudio detection by default, consistent with the existing automatic tool detection. A future opt-out can be added if needed, but is not part of this change.

### Runtime data flow

`UserPromptSubmit` records a lightweight lifecycle event and returns promptly. `Stop` starts a detached worker so the hook does not delay the AStudio turn. The worker reads the hook JSON from stdin, uses `transcript_path` and `turn_id` to select the completed turn, parses only stable JSONL records, converts them to OTLP Logs, and posts to `/v1/logs`.

The logical records are:

```text
agent.turn
├── llm.request
└── tool.call
```

The OTLP payload will use JSON encoding, matching the existing custom hook senders in this repository. Each record will carry structured fields for session/turn identity, model/provider, input/output messages, token usage, tool arguments/results, timing, status, cwd, and source metadata. The implementation will preserve the transcript's raw JSON values inside bounded structured fields and will not send credentials from the AStudio config.

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

The Acode hook will read an endpoint file beside the installed hook, with an optional environment override for local testing. It will send `Content-Type: application/json` to the team's OTLP HTTP Logs endpoint. Authentication will be configurable through an optional `OTEL_EXPORTER_OTLP_HEADERS`-style value in the Acode endpoint configuration, but the initial installer will not copy or expose provider bearer tokens from `~/.acode/config.toml`.

The installer will reuse `resolveEndpoint` and `logsEndpointFromGrpc` so AStudio, Codex, Claude, and Gemini resolve the same team address. Metrics and raw-body upload are outside this change; the current Acode transcript provides structured interaction data but not the provider's original HTTP request/response body.

### Failure handling and privacy

Hook failures are best effort and must not block the user's AStudio turn. Network failures are logged locally with bounded messages. No raw credential fields, authorization headers, or full provider configuration will be copied into telemetry. Message/tool content is intentionally enabled because collecting model interaction data is the requested behavior; the hook will document this and keep transport bounded per event.

### Tests

Tests will be added before implementation for:

- endpoint and Acode path configuration;
- idempotent merge of Acode hooks while preserving user hooks;
- parsing and mapping session/turn/message/tool/token records;
- selecting the current turn and handling completion/abort;
- valid Stop-hook JSON output and non-blocking failure behavior;
- generating an OTLP Logs envelope with `tool_kind=acode` and expected model fields.

Existing Claude/Codex/Gemini tests will continue to run unchanged.

## Alternatives considered

### Reconfigure AStudio's bundled Storage TLS integration

This would minimize new parser code, but couples the installer to AStudio's private packaged resources and version-specific runtime behavior. It also does not solve the observed Windows `Storage TLS startup unavailable` state independently.

### Capture AStudio's provider HTTP traffic with a proxy

This could preserve raw request and response bodies, but is more invasive, depends on provider routing and TLS behavior, and misses AStudio-level tool lifecycle semantics. It is deferred to a separate raw-capture feature.

## Non-goals

- changing AStudio binaries or packaged resources;
- modifying the team's Collector, Forward service, or dashboard;
- collecting provider raw HTTP bodies;
- changing the existing Claude, Codex, or Gemini data contracts;
- installing or enabling the bundled AStudio Storage TLS plugin.
