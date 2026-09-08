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
const PROCESSING_DIR = path.join(INSTALL_DIR, "processing");
const SENT_DIR = path.join(INSTALL_DIR, "sent");
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_JOB_FILES = 10;
const DEFAULT_MAX_BATCH_BYTES = 1500000;
const DEFAULT_STABILIZE_TIMEOUT_MS = 2000;
const DEFAULT_STABILIZE_INTERVAL_MS = 50;
const DEFAULT_WORKER_MAX_RUNTIME_MS = 25 * 1000;
const PROCESSING_STALE_MS = 5 * 60 * 1000;
const SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [5000, 30000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];

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

function transcriptHasCompletion(text, turnId) {
  let requestedTurnStarted = !turnId;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let record;
    try {
      record = JSON.parse(rawLine);
    } catch (_) {
      continue;
    }
    const payload = record && record.type === "event_msg" ? record.payload : null;
    if (payload && ["task_started", "turn_started"].includes(payload.type) && payload.turn_id === turnId) {
      requestedTurnStarted = true;
    }
    if (!payload || !["task_complete", "turn_complete", "turn_aborted"].includes(payload.type)) continue;
    if (!turnId || payload.turn_id === turnId || (!payload.turn_id && requestedTurnStarted)) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStableTranscript(filePath, turnId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_STABILIZE_TIMEOUT_MS;
  const intervalMs = Math.max(1, Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_STABILIZE_INTERVAL_MS);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latest = "";
  do {
    latest = await fsp.readFile(filePath, "utf8");
    if (transcriptHasCompletion(latest, turnId)) return latest;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  } while (Date.now() <= deadline);
  const error = new Error(`AStudio transcript did not complete turn ${turnId || "(unknown)"} within ${timeoutMs}ms`);
  error.code = "ACODE_TRANSCRIPT_INCOMPLETE";
  throw error;
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

function snapshotArgs(input = {}, config = {}) {
  if (config.fullUpload !== true) return [];
  const conversation = input.conversation || {};
  const sessionId = conversation.id || input.conversation_id || input.session_id || "";
  if (!sessionId) return [];
  const kind = eventKind(input);
  const turnId = input.turn_id || "";
  const args = [
    path.join(INSTALL_DIR, "git-snapshot.js"),
    `--session-id=${sessionId}`,
    `--hook-kind=${kind === "stop" ? "session_end" : "session_start"}`,
    `--event-kind=${kind}`,
    "--tool-kind=acode",
    `--cwd=${input.cwd || process.cwd()}`,
  ];
  if (turnId) args.push(`--prompt-id=${turnId}`, `--turn-id=${turnId}`);
  return args;
}

function spawnGitSnapshot(input, config) {
  const args = snapshotArgs(input, config);
  if (args.length === 0 || !fs.existsSync(args[0])) return false;
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (error) {
    logEvent("acode_git_snapshot_spawn_failed", { error: error.message });
    return false;
  }
}

async function spawnWorker() {
  const child = spawn(process.execPath, [__filename, "--worker"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function moveJob(jobPath, directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.rename(jobPath, path.join(directory, path.basename(jobPath)));
}

function retryDelay(attempts) {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1)];
}

async function requeueJob(jobPath, input, error) {
  const attempts = Number(input._attempts || 0) + 1;
  const nextAttemptAt = Date.now() + retryDelay(attempts);
  const updated = {
    ...input,
    _attempts: attempts,
    _next_attempt_at: nextAttemptAt,
    _last_error: String(error && error.message ? error.message : error || "unknown").slice(0, 500),
  };
  await fsp.writeFile(jobPath, `${JSON.stringify(updated)}\n`, { encoding: "utf8", mode: 0o600 });
  await moveJob(jobPath, PENDING_DIR);
  return nextAttemptAt;
}

async function processJob(jobPath) {
  let input;
  try {
    input = JSON.parse(await fsp.readFile(jobPath, "utf8"));
  } catch (error) {
    logEvent("acode_job_invalid", { error: error.message });
    await moveJob(jobPath, SENT_DIR).catch(() => undefined);
    return;
  }
  if (!input.transcript_path) {
    logEvent("acode_job_skip", { reason: "missing_transcript_path" });
    await moveJob(jobPath, SENT_DIR).catch(() => undefined);
    return;
  }
  try {
    const transcript = await readStableTranscript(input.transcript_path, input.turn_id, {
      timeoutMs: Number(process.env.ACODE_TRANSCRIPT_STABILIZE_TIMEOUT_MS) || DEFAULT_STABILIZE_TIMEOUT_MS,
      intervalMs: Number(process.env.ACODE_TRANSCRIPT_STABILIZE_INTERVAL_MS) || DEFAULT_STABILIZE_INTERVAL_MS,
    });
    const parsed = parseTranscript(transcript, input);
    const payload = buildOtlpLogs(parsed, {
      serviceName: "acode",
      serviceVersion: readConfig().installerVersion || "unknown",
      machineId: readConfig().machineId || "",
    });
    const config = readConfig();
    const batches = splitOtlpLogs(payload, Number(config.maxBatchBytes) || DEFAULT_MAX_BATCH_BYTES);
    let result = { statusCode: 200 };
    for (const batch of batches) {
      result = await postJson(resolveEndpoint(config), batch, config);
      if (result.statusCode < 200 || result.statusCode >= 300) break;
    }
    if (result.statusCode >= 200 && result.statusCode < 300) {
      await moveJob(jobPath, SENT_DIR);
      logEvent("acode_transcript_sent", { statusCode: result.statusCode, batchCount: batches.length, sessionId: input.session_id || "" });
    } else {
      logEvent("acode_transcript_failed", { statusCode: result.statusCode, error: result.error || "http error" });
      await requeueJob(jobPath, input, new Error(result.error || `HTTP ${result.statusCode}`));
    }
  } catch (error) {
    logEvent(error.code === "ACODE_TRANSCRIPT_INCOMPLETE" ? "acode_transcript_incomplete" : "acode_transcript_error", {
      error: error.message,
      turnId: input.turn_id || "",
    });
    await requeueJob(jobPath, input, error).catch((requeueError) => {
      logEvent("acode_job_requeue_failed", { error: requeueError.message });
    });
  }
}

async function recoverProcessingJobs(now = Date.now()) {
  let names = [];
  try { names = await fsp.readdir(PROCESSING_DIR); } catch (_) { return; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const jobPath = path.join(PROCESSING_DIR, name);
    try {
      const stat = await fsp.stat(jobPath);
      if (now - stat.mtimeMs >= PROCESSING_STALE_MS) await moveJob(jobPath, PENDING_DIR);
    } catch (_) {}
  }
}

async function cleanupSentJobs(now = Date.now()) {
  let names = [];
  try { names = await fsp.readdir(SENT_DIR); } catch (_) { return; }
  for (const name of names) {
    const jobPath = path.join(SENT_DIR, name);
    try {
      const stat = await fsp.stat(jobPath);
      if (now - stat.mtimeMs >= SENT_RETENTION_MS) await fsp.unlink(jobPath);
    } catch (_) {}
  }
}

async function claimJob(name, now = Date.now()) {
  const pendingPath = path.join(PENDING_DIR, name);
  let input;
  try {
    input = JSON.parse(await fsp.readFile(pendingPath, "utf8"));
  } catch (_) {
    input = {};
  }
  if (Number(input._next_attempt_at || 0) > now) return "";
  await fsp.mkdir(PROCESSING_DIR, { recursive: true, mode: 0o700 });
  const processingPath = path.join(PROCESSING_DIR, name);
  try {
    await fsp.rename(pendingPath, processingPath);
    const claimedAt = new Date();
    await fsp.utimes(processingPath, claimedAt, claimedAt);
    return processingPath;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function runWorker() {
  const config = readConfig();
  if (config.fullUpload !== true) return;
  await recoverProcessingJobs();
  await cleanupSentJobs();
  const maxRuntimeMs = Number(config.workerMaxRuntimeMs) || DEFAULT_WORKER_MAX_RUNTIME_MS;
  const deadline = Date.now() + maxRuntimeMs;
  let processed = 0;
  while (processed < MAX_JOB_FILES && Date.now() < deadline) {
    let names = [];
    try { names = (await fsp.readdir(PENDING_DIR)).filter((name) => name.endsWith(".json")).sort(); }
    catch (_) { return; }
    let claimed = false;
    let earliestRetryAt = Infinity;
    for (const name of names) {
      try {
        const pending = JSON.parse(await fsp.readFile(path.join(PENDING_DIR, name), "utf8"));
        const retryAt = Number(pending._next_attempt_at || 0);
        if (retryAt > Date.now()) {
          earliestRetryAt = Math.min(earliestRetryAt, retryAt);
          continue;
        }
      } catch (_) {
        // Invalid jobs are claimed and quarantined by processJob.
      }
      const jobPath = await claimJob(name);
      if (!jobPath) continue;
      claimed = true;
      processed += 1;
      await processJob(jobPath);
      break;
    }
    if (claimed) continue;
    if (!Number.isFinite(earliestRetryAt)) break;
    const waitMs = Math.max(1, earliestRetryAt - Date.now());
    if (Date.now() + waitMs > deadline) break;
    await delay(waitMs);
  }
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
  const config = readConfig();
  if (config.fullUpload !== true) {
    process.stdout.write("{}\n");
    return;
  }
  if (kind === "user_prompt" || kind === "stop" || kind === "session_start") {
    spawnGitSnapshot(input, config);
  }
  // Only Stop queues a completed transcript so a prompt cannot upload a partial duplicate turn.
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
  __test__: {
    resolveEndpoint,
    eventKind,
    splitOtlpLogs,
    transcriptHasCompletion,
    readStableTranscript,
    snapshotArgs,
    retryDelay,
    claimJob,
  },
};
