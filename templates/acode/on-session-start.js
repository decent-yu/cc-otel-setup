#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { parseTranscript, buildOtlpLogs } = require("./transcript-parser");
const { logEvent } = require("./logging");

const INSTALL_DIR = __dirname;
const PENDING_DIR = path.join(INSTALL_DIR, "pending");
const SENT_DIR = path.join(INSTALL_DIR, "sent");
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_JOB_FILES = 10;
const DEFAULT_MAX_BATCH_BYTES = 1500000;

function configPath() {
  return path.join(INSTALL_DIR, "endpoint.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch (_) {
    return {};
  }
}

function resolveEndpoint(config = {}) {
  if (process.env.ACODE_OTEL_LOGS_ENDPOINT) return process.env.ACODE_OTEL_LOGS_ENDPOINT;
  if (config.logsEndpoint) return config.logsEndpoint;
  if (config.endpoint) {
    try {
      const url = new URL(config.endpoint);
      if (url.port === "4317") url.port = "4318";
      if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
      return url.toString();
    } catch (_) {
      // Fall through to the local default.
    }
  }
  return "http://localhost:4318/v1/logs";
}

function eventKind(input = {}) {
  if (input.hook_event_name === "Stop") return "stop";
  if (input.hook_event_name === "UserPromptSubmit") return "user_prompt";
  return "session_start";
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes <= MAX_STDIN_BYTES) data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function parseHeaders(value) {
  const result = {};
  for (const pair of String(value || "").split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const headerValue = pair.slice(index + 1).trim();
    if (key && headerValue) result[key] = headerValue;
  }
  return result;
}

function payloadWithRecords(payload, records) {
  const resourceLog = payload.resourceLogs[0];
  const scopeLog = resourceLog.scopeLogs[0];
  return {
    resourceLogs: [{
      ...resourceLog,
      scopeLogs: [{ ...scopeLog, logRecords: records }],
    }],
  };
}

function splitOtlpLogs(payload, maxBytes = DEFAULT_MAX_BATCH_BYTES) {
  const resourceLog = payload.resourceLogs?.[0];
  const scopeLog = resourceLog?.scopeLogs?.[0];
  const records = scopeLog?.logRecords || [];
  if (records.length === 0) return [payload];
  const batches = [];
  let current = [];
  for (const record of records) {
    const candidate = [...current, record];
    if (Buffer.byteLength(JSON.stringify(payloadWithRecords(payload, candidate))) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new Error(`single OTLP log record exceeds ${maxBytes} bytes`);
    batches.push(payloadWithRecords(payload, current));
    current = [record];
    if (Buffer.byteLength(JSON.stringify(payloadWithRecords(payload, current))) > maxBytes) {
      throw new Error(`single OTLP log record exceeds ${maxBytes} bytes`);
    }
  }
  if (current.length > 0) batches.push(payloadWithRecords(payload, current));
  return batches;
}

function postJson(endpoint, payload, config) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_) {
      resolve({ statusCode: 0, error: "invalid endpoint" });
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": body.length,
      ...(config.headers || {}),
      ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "POST",
      headers,
      timeout: 8000,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ statusCode: response.statusCode || 0 }));
      response.on("error", (error) => resolve({ statusCode: 0, error: error.message }));
    });
    request.on("error", (error) => resolve({ statusCode: 0, error: error.message }));
    request.on("timeout", () => {
      request.destroy();
      resolve({ statusCode: 0, error: "timeout" });
    });
    request.end(body);
  });
}

async function enqueue(input) {
  await fsp.mkdir(PENDING_DIR, { recursive: true, mode: 0o700 });
  const jobPath = path.join(PENDING_DIR, `${Date.now()}-${randomUUID()}.json`);
  await fsp.writeFile(jobPath, `${JSON.stringify(input)}\n`, { encoding: "utf8", mode: 0o600 });
  return jobPath;
}

async function spawnWorker() {
  const child = spawn(process.execPath, [__filename, "--worker"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function processJob(jobPath) {
  let input;
  try {
    input = JSON.parse(await fsp.readFile(jobPath, "utf8"));
  } catch (error) {
    logEvent("acode_job_invalid", { error: error.message });
    await fsp.rename(jobPath, path.join(SENT_DIR, path.basename(jobPath))).catch(() => undefined);
    return;
  }
  if (!input.transcript_path) {
    logEvent("acode_job_skip", { reason: "missing_transcript_path" });
    await fsp.rename(jobPath, path.join(SENT_DIR, path.basename(jobPath))).catch(() => undefined);
    return;
  }
  try {
    const transcript = await fsp.readFile(input.transcript_path, "utf8");
    const parsed = parseTranscript(transcript, input);
    const payload = buildOtlpLogs(parsed, {
      serviceName: "acode",
      serviceVersion: readConfig().installerVersion || "unknown",
    });
    const config = readConfig();
    const batches = splitOtlpLogs(payload, Number(config.maxBatchBytes) || DEFAULT_MAX_BATCH_BYTES);
    let result = { statusCode: 200 };
    for (const batch of batches) {
      result = await postJson(resolveEndpoint(config), batch, config);
      if (result.statusCode < 200 || result.statusCode >= 300) break;
    }
    if (result.statusCode >= 200 && result.statusCode < 300) {
      await fsp.mkdir(SENT_DIR, { recursive: true, mode: 0o700 });
      await fsp.rename(jobPath, path.join(SENT_DIR, path.basename(jobPath)));
      logEvent("acode_transcript_sent", { statusCode: result.statusCode, batchCount: batches.length, sessionId: input.session_id || "" });
    } else {
      logEvent("acode_transcript_failed", { statusCode: result.statusCode, error: result.error || "http error" });
    }
  } catch (error) {
    logEvent("acode_transcript_error", { error: error.message });
  }
}

async function runWorker() {
  let names;
  try {
    names = (await fsp.readdir(PENDING_DIR)).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_JOB_FILES);
  } catch (_) {
    return;
  }
  for (const name of names) await processJob(path.join(PENDING_DIR, name));
}

async function main() {
  if (process.argv.includes("--worker")) {
    await runWorker();
    return;
  }
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch (_) {
    logEvent("acode_hook_invalid_input");
  }
  const kind = eventKind(input);
  // UserPromptSubmit is registered for lifecycle coverage; only Stop queues a
  // completed transcript so a prompt cannot upload a partial duplicate turn.
  if (kind === "stop") {
    try {
      await enqueue(input);
      await spawnWorker();
    } catch (error) {
      logEvent("acode_hook_queue_failed", { error: error.message });
    }
  }
  process.stdout.write("{}\n");
}

if (require.main === module) main().catch((error) => {
  logEvent("acode_hook_error", { error: error.message });
  process.stdout.write("{}\n");
});

module.exports = {
  resolveEndpoint,
  eventKind,
  enqueue,
  runWorker,
  __test__: { resolveEndpoint, eventKind, splitOtlpLogs },
};
