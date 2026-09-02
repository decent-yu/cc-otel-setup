"use strict";

const crypto = require("node:crypto");

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
  "web_fetch_call",
  "browser_call",
  "code_interpreter_call",
]);

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
  "web_search_output",
  "browser_output",
  "web_fetch_output",
  "code_interpreter_output",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function safeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function jsonText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function timestampMs(value, fallback = Date.now()) {
  const result = Date.parse(value || "");
  return Number.isFinite(result) ? result : fallback;
}

function traceIdFor(sessionId, turnId) {
  return crypto.createHash("sha256").update(`acode:${sessionId || "session"}:${turnId || "turn"}`).digest("hex").slice(0, 32);
}

function spanIdFor(sessionId, turnId, kind, index = "") {
  return crypto.createHash("sha256").update(`acode:${sessionId || "session"}:${turnId || "turn"}:${kind}:${index}`).digest("hex").slice(0, 16);
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part && typeof part === "object") return firstValue(part.text, part.content, "") || "";
    return typeof part === "string" ? part : "";
  }).join("");
}

function normalizeMessage(payload) {
  const value = asObject(payload);
  if (value.type === "function_call" || value.type === "custom_tool_call") {
    return {
      role: "assistant",
      type: "tool_call",
      content: "",
      tool_call_id: firstValue(value.call_id, value.id, ""),
      tool_name: firstValue(value.name, value.type, ""),
      arguments: safeJson(firstValue(value.arguments, value.input, {})),
      raw_type: value.type,
    };
  }
  if (TOOL_OUTPUT_TYPES.has(value.type)) {
    return {
      role: "tool",
      type: "tool_result",
      content: jsonText(firstValue(value.output, value.result, value.tools, "")),
      tool_call_id: firstValue(value.call_id, value.id, ""),
      raw_type: value.type,
    };
  }
  if (value.type === "reasoning") {
    return {
      role: "assistant",
      type: "reasoning",
      content: textFromContent(value.summary) || jsonText(value.summary) || jsonText(value.content),
      raw_type: value.type,
    };
  }
  if (value.type === "message") {
    return {
      role: value.role || "unknown",
      type: "message",
      content: textFromContent(value.content),
      raw_type: value.type,
    };
  }
  return {
    role: value.role || "unknown",
    type: value.type || "unknown",
    content: textFromContent(value.content) || jsonText(value.text),
    raw_type: value.type || "unknown",
  };
}

function createTurn(id, startedAt) {
  return {
    turn_id: id || null,
    status: "in_progress",
    started_at: startedAt || null,
    completed_at: null,
    model: null,
    messages: [],
    tool_calls: [],
    usage: null,
  };
}

function toolFor(turn, id) {
  if (!id) return null;
  let tool = turn.tool_calls.find((entry) => entry.call_id === id);
  if (!tool) {
    tool = { call_id: id, name: "unknown", namespace: null, arguments: null, result: null, status: null };
    turn.tool_calls.push(tool);
  }
  return tool;
}

function applyToolMessage(turn, message, timestamp) {
  const id = message.tool_call_id;
  const tool = toolFor(turn, id);
  if (!tool) return;
  if (message.type === "tool_call") {
    tool.name = message.tool_name || tool.name;
    tool.arguments = message.arguments;
    tool.started_at = tool.started_at || timestamp;
  } else {
    tool.result = message.content;
    tool.ended_at = timestamp;
  }
}

function parseTranscript(input, hookInput = {}) {
  const sourceLines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  const lines = [];
  const parseErrors = [];
  sourceLines.forEach((raw, index) => {
    if (!String(raw).trim()) return;
    try {
      lines.push({ ...JSON.parse(raw), _line: index + 1 });
    } catch (error) {
      parseErrors.push({ line: index + 1, message: error.message });
    }
  });

  const session = {
    session_id: firstValue(hookInput.session_id, hookInput.sessionId, hookInput.conversation?.id, null),
    thread_id: firstValue(hookInput.thread_id, hookInput.threadId, null),
    conversation_id: firstValue(hookInput.conversation_id, hookInput.conversationId, null),
    cwd: firstValue(hookInput.cwd, null),
    model_provider: firstValue(hookInput.model_provider, hookInput.modelProvider, null),
    model: firstValue(hookInput.model, null),
    transcript_path: firstValue(hookInput.transcript_path, null),
  };
  const allTurns = [];
  let current = null;

  function ensureTurn(timestamp, id) {
    if (!current) current = createTurn(id || null, timestamp);
    if (!current.turn_id && id) current.turn_id = id;
    return current;
  }

  function finishTurn(status, timestamp, lastMessage) {
    if (!current) return;
    current.status = status || current.status;
    current.completed_at = timestamp || current.completed_at;
    if (lastMessage && !current.messages.some((message) => message.content === lastMessage)) {
      current.messages.push({ role: "assistant", type: "message", content: lastMessage, timestamp });
    }
    allTurns.push(current);
    current = null;
  }

  for (const line of lines) {
    const payload = asObject(line.payload);
    const timestamp = line.timestamp || null;
    if (line.type === "session_meta") {
      session.session_id = firstValue(payload.id, payload.session_id, payload.sessionId, session.session_id);
      session.thread_id = firstValue(payload.thread_id, payload.threadId, session.thread_id);
      session.conversation_id = firstValue(payload.conversation_id, payload.conversationId, session.conversation_id);
      session.cwd = firstValue(payload.cwd, session.cwd);
      session.model_provider = firstValue(payload.model_provider, payload.modelProvider, session.model_provider);
      session.model = firstValue(payload.model, session.model);
      continue;
    }
    if (line.type === "turn_context") {
      const turn = ensureTurn(timestamp, payload.turn_id);
      turn.model = firstValue(payload.model, turn.model);
      session.model = firstValue(session.model, payload.model);
      continue;
    }
    if (line.type === "response_item") {
      const turn = ensureTurn(timestamp, null);
      const message = normalizeMessage(payload);
      turn.messages.push({ ...message, timestamp, line: line._line });
      if (message.type === "tool_call" || message.type === "tool_result") applyToolMessage(turn, message, timestamp);
      continue;
    }
    if (line.type !== "event_msg") continue;
    const eventType = payload.type || "";
    if (eventType === "task_started" || eventType === "turn_started") {
      if (current && current.messages.length > 0) allTurns.push(current);
      current = createTurn(payload.turn_id || null, timestamp);
      current.model = firstValue(payload.model, current.model);
      current.start_line = line._line;
      continue;
    }
    if (eventType === "token_count") {
      const turn = ensureTurn(timestamp, null);
      const info = asObject(payload.info);
      const usage = asObject(firstValue(info.last_token_usage, info.total_token_usage, null));
      if (Object.keys(usage).length > 0) turn.usage = usage;
      continue;
    }
    if (typeof payload.call_id === "string") {
      const turn = ensureTurn(timestamp, null);
      const tool = toolFor(turn, payload.call_id);
      const event = payload.type || "";
      if (event.endsWith("_begin")) {
        tool.name = firstValue(payload.name, payload.tool_name, event.slice(0, -6), tool.name);
        tool.arguments = firstValue(payload.arguments, payload.input, payload.query, tool.arguments);
        tool.started_at = timestamp;
        tool.status = "started";
      }
      if (event.endsWith("_end")) {
        tool.result = firstValue(payload.result, payload.output, payload.aggregated_output, payload.invocation, tool.result);
        tool.ended_at = timestamp;
        tool.status = firstValue(payload.status, tool.status);
        tool.error = firstValue(payload.error, payload.stderr, null);
      }
      continue;
    }
    if (eventType === "task_complete" || eventType === "turn_complete") {
      finishTurn("completed", timestamp, payload.last_agent_message);
      continue;
    }
    if (eventType === "turn_aborted") finishTurn("aborted", timestamp, null);
  }
  if (current) {
    if (current.status === "in_progress" && current.messages.some((message) => message.role === "assistant")) current.status = "completed";
    allTurns.push(current);
  }

  const requestedTurnId = firstValue(hookInput.turn_id, hookInput.turnId, null);
  const selected = requestedTurnId ? allTurns.find((turn) => turn.turn_id === requestedTurnId) : allTurns.at(-1);
  return {
    session,
    turns: selected ? [selected] : [],
    parse_errors: parseErrors,
    line_count: lines.length,
  };
}

function attr(key, value) {
  if (value === undefined || value === null || value === "") return null;
  return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
}

function attrs(values) {
  return Object.entries(values).map(([key, value]) => attr(key, value)).filter(Boolean);
}

function nano(timestamp) {
  return String(Math.max(0, timestampMs(timestamp)) * 1e6);
}

function messagesJson(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    type: message.type,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
}

function buildOtlpLogs(parsed, options = {}) {
  const serviceName = options.serviceName || "acode";
  const serviceVersion = options.serviceVersion || "unknown";
  const session = parsed.session || {};
  const turn = parsed.turns?.[0];
  if (!turn) return { resourceLogs: [] };
  const traceId = traceIdFor(session.session_id, turn.turn_id);
  const records = [];
  const common = {
    tool_kind: "acode",
    data_source: "acode_transcript_hook",
    "session.id": session.session_id,
    "gen_ai.conversation.id": session.conversation_id || session.session_id,
    "gen_ai.request.model": turn.model || session.model,
    "gen_ai.provider.name": session.model_provider,
    cwd: session.cwd,
    "turn.id": turn.turn_id,
    "turn.status": turn.status,
  };
  const userMessages = turn.messages.filter((message) => message.role === "user");
  const assistantMessages = turn.messages.filter((message) => message.role === "assistant");
  const start = turn.started_at || turn.messages[0]?.timestamp;
  const end = turn.completed_at || turn.messages.at(-1)?.timestamp || start;
  records.push({
    timeUnixNano: nano(end),
    traceId,
    spanId: spanIdFor(session.session_id, turn.turn_id, "turn"),
    body: { stringValue: "agent.turn" },
    attributes: attrs({
      ...common,
      "event.name": "agent.turn",
      "gen_ai.operation.name": "agent",
      "gen_ai.input.messages": messagesJson(userMessages),
      "gen_ai.output.messages": messagesJson(assistantMessages),
      "gen_ai.usage.input_tokens": turn.usage?.input_tokens,
      "gen_ai.usage.output_tokens": turn.usage?.output_tokens,
      "gen_ai.usage.total_tokens": turn.usage?.total_tokens,
      "gen_ai.usage.reasoning.output_tokens": turn.usage?.reasoning_output_tokens,
      "start.time": start,
    }),
  });
  records.push({
    timeUnixNano: nano(end),
    traceId,
    spanId: spanIdFor(session.session_id, turn.turn_id, "llm"),
    parentSpanId: spanIdFor(session.session_id, turn.turn_id, "turn"),
    body: { stringValue: "llm.request" },
    attributes: attrs({
      ...common,
      "event.name": "llm.request",
      "gen_ai.operation.name": "chat",
      "gen_ai.input.messages": messagesJson(turn.messages.slice(0, Math.max(0, turn.messages.findIndex((message) => message.role === "assistant")))),
      "gen_ai.output.messages": messagesJson(assistantMessages),
      "gen_ai.usage.input_tokens": turn.usage?.input_tokens,
      "gen_ai.usage.output_tokens": turn.usage?.output_tokens,
      "gen_ai.usage.total_tokens": turn.usage?.total_tokens,
      "gen_ai.usage.reasoning.output_tokens": turn.usage?.reasoning_output_tokens,
    }),
  });
  turn.tool_calls.forEach((tool, index) => {
    records.push({
      timeUnixNano: nano(tool.ended_at || tool.started_at || end),
      traceId,
      spanId: spanIdFor(session.session_id, turn.turn_id, "tool", index),
      parentSpanId: spanIdFor(session.session_id, turn.turn_id, "turn"),
      body: { stringValue: "tool.call" },
      attributes: attrs({
        ...common,
        "event.name": "tool.call",
        "tool.name": tool.name,
        "gen_ai.tool.name": tool.name,
        "gen_ai.tool.call.id": tool.call_id,
        "gen_ai.tool.call.arguments": tool.arguments,
        "gen_ai.tool.call.result": tool.result,
        "tool.status": tool.status,
        "tool.error": tool.error,
        "tool.start_time": tool.started_at,
        "tool.end_time": tool.ended_at,
      }),
    });
  });
  return {
    resourceLogs: [{
      resource: { attributes: attrs({
        "service.name": serviceName,
        "service.version": serviceVersion,
        "telemetry.sdk.name": "ai-otel-setup",
        "telemetry.sdk.language": "nodejs",
        tool_kind: "acode",
      }) },
      scopeLogs: [{ scope: { name: "ai-otel-setup.acode" }, logRecords: records }],
    }],
  };
}

module.exports = {
  parseTranscript,
  buildOtlpLogs,
  traceIdFor,
  spanIdFor,
};
