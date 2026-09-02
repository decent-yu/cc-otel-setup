"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTranscript,
  buildOtlpLogs,
  traceIdFor,
  spanIdFor,
} = require("../templates/acode/transcript-parser");

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function fixture() {
  return [
    line("2026-09-02T01:00:00.000Z", "session_meta", {
      id: "session-1",
      cwd: "C:\\work\\demo",
      model_provider: "astron-spark",
      conversation_id: "conversation-1",
    }),
    line("2026-09-02T01:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
    }),
    line("2026-09-02T01:00:02.000Z", "turn_context", {
      turn_id: "turn-1",
      model: "spark-x2.5-harness",
    }),
    line("2026-09-02T01:00:03.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Inspect this project" }],
    }),
    line("2026-09-02T01:00:04.000Z", "response_item", {
      type: "function_call",
      name: "shell_exec",
      call_id: "call-1",
      arguments: JSON.stringify({ command: "dir" }),
    }),
    line("2026-09-02T01:00:05.000Z", "response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: "file.txt",
    }),
    line("2026-09-02T01:00:06.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I found the file." }],
    }),
    line("2026-09-02T01:00:07.000Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 120,
        },
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 120,
        },
      },
    }),
    line("2026-09-02T01:00:08.000Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "I found the file.",
    }),
  ].join("\n") + "\n";
}

test("parses AStudio session metadata, current turn messages, tool call, and token usage", () => {
  const parsed = parseTranscript(fixture(), {
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "C:\\work\\demo",
  });

  assert.equal(parsed.session.session_id, "session-1");
  assert.equal(parsed.session.conversation_id, "conversation-1");
  assert.equal(parsed.session.model_provider, "astron-spark");
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].turn_id, "turn-1");
  assert.equal(parsed.turns[0].status, "completed");
  assert.equal(parsed.turns[0].model, "spark-x2.5-harness");
  assert.equal(parsed.turns[0].messages[0].role, "user");
  assert.equal(parsed.turns[0].messages[0].content, "Inspect this project");
  assert.equal(parsed.turns[0].messages.at(-1).content, "I found the file.");
  assert.equal(parsed.turns[0].tool_calls[0].name, "shell_exec");
  assert.deepEqual(parsed.turns[0].tool_calls[0].arguments, { command: "dir" });
  assert.equal(parsed.turns[0].tool_calls[0].result, "file.txt");
  assert.deepEqual(parsed.turns[0].usage, {
    input_tokens: 100,
    cached_input_tokens: 40,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  });
});

test("selects the requested turn and falls back to the final turn", () => {
  const text = [
    fixture().trim(),
    line("2026-09-02T01:01:00.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-2",
    }),
    line("2026-09-02T01:01:01.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Second answer" }],
    }),
    line("2026-09-02T01:01:02.000Z", "event_msg", {
      type: "turn_aborted",
      turn_id: "turn-2",
    }),
  ].join("\n") + "\n";

  assert.equal(parseTranscript(text, { turn_id: "turn-1" }).turns[0].turn_id, "turn-1");
  const fallback = parseTranscript(text, {}).turns;
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].turn_id, "turn-2");
  assert.equal(fallback[0].status, "aborted");
});

test("builds deterministic OTLP Logs with Acode identity and GenAI fields", () => {
  const parsed = parseTranscript(fixture(), { session_id: "session-1", turn_id: "turn-1" });
  const first = buildOtlpLogs(parsed, { serviceName: "acode", serviceVersion: "test" });
  const second = buildOtlpLogs(parsed, { serviceName: "acode", serviceVersion: "test" });

  assert.deepEqual(first, second);
  assert.equal(first.resourceLogs[0].resource.attributes.find((x) => x.key === "service.name").value.stringValue, "acode");
  assert.equal(first.resourceLogs[0].resource.attributes.find((x) => x.key === "tool_kind").value.stringValue, "acode");
  const records = first.resourceLogs[0].scopeLogs[0].logRecords;
  assert.deepEqual(records.map((record) => record.body.stringValue), ["agent.turn", "llm.request", "tool.call"]);
  const llm = records.find((record) => record.body.stringValue === "llm.request");
  const attrs = Object.fromEntries(llm.attributes.map((x) => [x.key, x.value.stringValue]));
  assert.equal(attrs["gen_ai.request.model"], "spark-x2.5-harness");
  assert.equal(attrs["gen_ai.provider.name"], "astron-spark");
  assert.equal(attrs["gen_ai.usage.input_tokens"], "100");
  assert.match(attrs["gen_ai.input.messages"], /Inspect this project/);
  assert.match(attrs["gen_ai.output.messages"], /I found the file/);
  assert.equal(records[0].traceId, traceIdFor("session-1", "turn-1"));
  assert.equal(records[0].spanId, spanIdFor("session-1", "turn-1", "turn"));
});
