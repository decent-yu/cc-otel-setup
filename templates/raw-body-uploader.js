#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging is best effort only.
}

const INSTALL_DIR = __dirname;
const ENDPOINT_FILE = path.join(INSTALL_DIR, "endpoint.json");
const TOKEN_FILE = path.join(INSTALL_DIR, "raw-upload-token");
const UPLOADER_DIR = path.join(INSTALL_DIR, "raw-uploader");
const STATE_FILE = path.join(UPLOADER_DIR, "state.json");
const LOCK_FILE = path.join(UPLOADER_DIR, "lock");

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RUNTIME_MS = 25 * 1000;
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_STABLE_AGE_MS = 15 * 1000;
const DEFAULT_SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SOFT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_HARD_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_TARGET_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const LOCK_STALE_MS = 30 * 60 * 1000;

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === "--once") out.once = true;
    else if (arg.startsWith("--max-runtime=")) out.maxRuntimeSec = Number(arg.slice("--max-runtime=".length));
    else if (arg.startsWith("--max-files=")) out.maxFiles = Number(arg.slice("--max-files=".length));
    else if (arg.startsWith("--max-bytes=")) out.maxBytes = Number(arg.slice("--max-bytes=".length));
  }
  return out;
}

function cfgBytes(cfg, key, defaultVal) {
  const n = Number(cfg && cfg[key]);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256String(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function fileBodyKind(fileName) {
  if (/\.request\.json$/i.test(fileName)) return "request";
  if (/\.response\.json$/i.test(fileName)) return "response";
  if (/\.snapshot\.bundle$/i.test(fileName)) return "snapshot"; // git-snapshot.js 落的 git bundle
  return "";
}

function fileToolKind(fileName) {
  // CC 旧文件名保持 snapshot-<session>-...；Codex 快照由通用 snapshot
  // 引擎写成 snapshot-codex-<session>-...。request/response 仍只来自 CC。
  if (/^snapshot-codex-/i.test(fileName)) return "codex";
  return "cc";
}

function isRawBodyFile(fileName) {
  return /\.request\.json$/i.test(fileName) || /\.response\.json$/i.test(fileName) || /\.snapshot\.bundle$/i.test(fileName);
}

function readUploadToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch (_) {
    return "";
  }
}

function requestJson(method, targetUrl, body, token, timeoutMs) {
  return requestRaw(method, targetUrl, Buffer.from(JSON.stringify(body || {}), "utf8"), token, {
    "Content-Type": "application/json",
  }, timeoutMs).then((res) => {
    let json = {};
    try {
      json = res.body.length ? JSON.parse(res.body.toString("utf8")) : {};
    } catch (_) {
      json = {};
    }
    return { ...res, json };
  });
}

function requestRaw(method, targetUrl, body, token, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname || "/") + (url.search || ""),
        headers: {
          ...(headers || {}),
          "Content-Length": body.length,
          "X-AI-OTEL-Timestamp": timestamp,
          "X-AI-OTEL-Nonce": nonce,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            resolve({ statusCode: res.statusCode || 0, body: responseBody });
            return;
          }
          const message = responseBody.toString("utf8").slice(0, 500);
          reject(new Error(`HTTP ${res.statusCode || 0}: ${message}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

function rawUploadBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

function readLockInfo() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

function processAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function removeLockFile() {
  try {
    fs.unlinkSync(LOCK_FILE);
    return true;
  } catch (_) {
    return false;
  }
}

function maybeRecoverStaleLock() {
  const info = readLockInfo();
  const now = Date.now();
  const startedAtMs = Date.parse(info && info.startedAt ? info.startedAt : "");
  const ageMs = Number.isFinite(startedAtMs) ? now - startedAtMs : null;
  const alive = info && info.pid ? processAlive(info.pid) : false;

  if (info && info.pid && !alive) {
    if (removeLockFile()) {
      logEvent("raw_uploader_lock_recovered", {
        reason: "pid_not_alive",
        stalePid: info.pid,
        ageMs: ageMs === null ? "" : ageMs,
      });
      return true;
    }
  }

  if (ageMs !== null && ageMs > LOCK_STALE_MS) {
    if (removeLockFile()) {
      logEvent("raw_uploader_lock_recovered", {
        reason: alive ? "lock_too_old_process_alive" : "lock_too_old",
        stalePid: info && info.pid ? info.pid : "",
        ageMs,
      });
      return true;
    }
  }

  return false;
}

function acquireLock() {
  fs.mkdirSync(UPLOADER_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return fd;
  } catch (e) {
    if (e && e.code === "EEXIST" && maybeRecoverStaleLock()) {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return fd;
    }
    throw e;
  }
}

function releaseLock(fd) {
  try {
    fs.closeSync(fd);
  } catch (_) {}
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

async function* walkRawFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.opendir(dir);
  } catch (_) {
    return;
  }
  for await (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkRawFiles(fullPath);
    } else if (entry.isFile() && isRawBodyFile(entry.name)) {
      yield fullPath;
    }
  }
}

async function stableStat(file) {
  let first;
  try {
    first = await fs.promises.stat(file);
  } catch (_) {
    return null;
  }
  if (!first.isFile() || first.size <= 0) return null;
  if (Date.now() - first.mtimeMs < DEFAULT_STABLE_AGE_MS) return null;
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    const second = await fs.promises.stat(file);
    if (!second.isFile() || second.size !== first.size) return null;
    return second;
  } catch (_) {
    return null;
  }
}

function sourceFileKey(machineId, file, stat) {
  return sha256String(`${machineId}|${path.basename(file)}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
}

function sentPathFor(file) {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(UPLOADER_DIR, "sent", d, path.basename(file));
}

async function moveToSent(file) {
  const dest = sentPathFor(file);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(file, dest);
  } catch (_) {
    await fs.promises.copyFile(file, dest);
    await fs.promises.unlink(file);
  }
  return dest;
}

function discardedPathFor(file, reason) {
  const d = new Date().toISOString().slice(0, 10);
  const safeReason = String(reason || "disk_guard").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return path.join(UPLOADER_DIR, "discarded", d, safeReason, path.basename(file));
}

async function moveToDiscarded(file, reason) {
  const dest = discardedPathFor(file, reason);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(file, dest);
  } catch (_) {
    await fs.promises.copyFile(file, dest);
    await fs.promises.unlink(file);
  }
  return dest;
}

async function discardRawFile(file, reason) {
  await fs.promises.unlink(file);
  return "";
}

function backoffMs(failures) {
  const steps = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60];
  return steps[Math.min(Math.max(failures - 1, 0), steps.length - 1)] * 1000;
}

function errorText(err) {
  if (!err) return "unknown";
  return String(err.stack || err.message || err).slice(0, 500);
}

function isServerCapabilityError(err) {
  return /inline raw body upload only supports single chunk/i.test(errorText(err));
}

function isDiscardableUploadError(err) {
  const text = errorText(err);
  return /HTTP 413\b/.test(text) ||
    /file_size exceeds max/i.test(text) ||
    /chunk_count exceeds max/i.test(text);
}

function nextBackoffMs(err, failures) {
  if (isServerCapabilityError(err)) return 24 * 60 * 60 * 1000;
  return backoffMs(failures);
}

async function uploadFile(file, stat, cfg, token) {
  const base = rawUploadBase(cfg.rawUploadUrl);
  const machineId = cfg.machineId || cfg.machine_id || "";
  if (!base || !machineId) throw new Error("missing rawUploadUrl or machineId");

  const fileName = path.basename(file);
  const key = sourceFileKey(machineId, file, stat);
  const metadata = {
    machine_id: machineId,
    tool_kind: fileToolKind(fileName),
    file_name: fileName,
    body_kind: fileBodyKind(fileName),
    file_size: stat.size,
    mtime_ms: Math.floor(stat.mtimeMs),
    source_file_key: key,
    installer_version: cfg.installerVersion || cfg.version || "",
    hostname: os.hostname() || "",
    git_user_email: cfg.gitUserEmail || "",
  };

  const init = await requestJson("POST", `${base}/init`, metadata, token, 10000);
  const uploadId = init.json.upload_id;
  const chunkSize = Number(init.json.chunk_size || cfg.rawUploadChunkBytes || DEFAULT_CHUNK_BYTES);
  if (!uploadId) throw new Error("raw upload init missing upload_id");

  const fd = await fs.promises.open(file, "r");
  const hash = crypto.createHash("sha256");
  let index = 0;
  let offset = 0;
  try {
    while (offset < stat.size) {
      const size = Math.min(chunkSize, stat.size - offset);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await fd.read(buffer, 0, size, offset);
      const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const chunkSha = sha256Buffer(chunk);
      await requestRaw(
        "PUT",
        `${base}/${uploadId}/chunks/${index}`,
        chunk,
        token,
        {
          "Content-Type": "application/octet-stream",
          "X-Chunk-SHA256": chunkSha,
        },
        30000
      );
      offset += bytesRead;
      index += 1;
    }
  } finally {
    await fd.close();
  }

  const contentSha = hash.digest("hex");
  await requestJson("POST", `${base}/${uploadId}/complete`, { content_sha256: contentSha }, token, 30000);
  return { sourceFileKey: key, contentSha256: contentSha, bytes: stat.size };
}

async function cleanupSent(now) {
  const root = path.join(UPLOADER_DIR, "sent");
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    let files = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch (_) {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (now - st.mtimeMs > DEFAULT_SENT_RETENTION_MS) await fs.promises.unlink(file);
      } catch (_) {}
    }
  }
}

async function cleanupDiscarded(now) {
  const root = path.join(UPLOADER_DIR, "discarded");
  let dateDirs;
  try {
    dateDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const dateDir of dateDirs) {
    if (!dateDir.isDirectory()) continue;
    const datePath = path.join(root, dateDir.name);
    let reasonDirs = [];
    try {
      reasonDirs = await fs.promises.readdir(datePath, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const reasonDir of reasonDirs) {
      if (!reasonDir.isDirectory()) continue;
      const dir = path.join(datePath, reasonDir.name);
      let names = [];
      try {
        names = await fs.promises.readdir(dir);
      } catch (_) {
        continue;
      }
      const items = [];
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const st = await fs.promises.stat(file);
          items.push({ file, mtimeMs: st.mtimeMs });
        } catch (_) {}
      }
      items.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (let i = 0; i < items.length; i++) {
        try {
          if (now - items[i].mtimeMs > DEFAULT_SENT_RETENTION_MS) await fs.promises.unlink(items[i].file);
        } catch (_) {}
      }
    }
  }
}

async function rawDirInventory(dir) {
  let total = 0;
  const files = [];
  for await (const file of walkRawFiles(dir)) {
    try {
      const st = await fs.promises.stat(file);
      total += st.size;
      files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  return { total, files };
}

async function freeBytesFor(dir) {
  if (!fs.promises.statfs) return null;
  try {
    const st = await fs.promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) {
    return null;
  }
}

async function applyDiskGuard(rawBodiesDir, cfg, state, phase) {
  const softLimit = cfgBytes(cfg, "rawBodiesSoftLimitBytes", DEFAULT_SOFT_LIMIT_BYTES);
  const hardLimit = cfgBytes(cfg, "rawBodiesHardLimitBytes", DEFAULT_HARD_LIMIT_BYTES);
  const targetLimit = Math.min(cfgBytes(cfg, "rawBodiesTargetLimitBytes", DEFAULT_TARGET_LIMIT_BYTES), hardLimit);
  const minFree = cfgBytes(cfg, "rawBodiesMinFreeBytes", DEFAULT_MIN_FREE_BYTES);
  const inventory = await rawDirInventory(rawBodiesDir);
  const freeBytes = await freeBytesFor(rawBodiesDir);
  const lowFree = freeBytes !== null && freeBytes < minFree;

  state.diskGuard = {
    ...(state.diskGuard || {}),
    lastCheckedAt: new Date().toISOString(),
    rawBodiesBytes: inventory.total,
    freeBytes: freeBytes === null ? "" : freeBytes,
    softLimitBytes: softLimit,
    hardLimitBytes: hardLimit,
    targetLimitBytes: targetLimit,
    minFreeBytes: minFree,
  };

  if (inventory.total > softLimit) {
    logEvent("raw_uploader_soft_limit_exceeded", {
      phase,
      bytes: inventory.total,
      freeBytes: freeBytes === null ? "" : freeBytes,
      softLimitBytes: softLimit,
    });
  }

  if (inventory.total <= hardLimit && !lowFree) {
    return { rawBodiesBytes: inventory.total, discardedFiles: 0, discardedBytes: 0 };
  }

  inventory.files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let current = inventory.total;
  let discardedFiles = 0;
  let discardedBytes = 0;
  const reason = lowFree ? "low_free_space" : "raw_bodies_hard_limit";
  const examples = [];

  const stopAtBytes = lowFree ? 0 : targetLimit;
  for (const item of inventory.files) {
    if (current <= stopAtBytes) break;
    const fileName = path.basename(item.file);
    const key = sourceFileKey(cfg.machineId || "", item.file, { size: item.size, mtimeMs: item.mtimeMs });
    try {
      const dest = await discardRawFile(item.file, reason);
      current -= item.size;
      discardedFiles += 1;
      discardedBytes += item.size;
      state.files[key] = {
        ...(state.files[key] || {}),
        uploaded: false,
        discarded: true,
        discardedAt: new Date().toISOString(),
        discardReason: reason,
        fileName,
        bodyKind: fileBodyKind(fileName),
        bytes: item.size,
        mtimeMs: Math.floor(item.mtimeMs),
        discardedPath: dest,
      };
      if (examples.length < 5) examples.push(`${fileName}:${item.size}`);
    } catch (e) {
      logEvent("raw_uploader_discard_failed", {
        file: fileName,
        bytes: item.size,
        reason,
        error: errorText(e),
      });
    }
  }

  if (discardedFiles) {
    state.diskGuard = {
      ...(state.diskGuard || {}),
      lastDiscardAt: new Date().toISOString(),
      lastDiscardReason: reason,
      lastDiscardedFiles: discardedFiles,
      lastDiscardedBytes: discardedBytes,
      rawBodiesBytesAfterDiscard: current,
    };
    logEvent("raw_uploader_disk_guard_discarded", {
      phase,
      reason,
      discardedFiles,
      discardedBytes,
      rawBodiesBytesBefore: inventory.total,
      rawBodiesBytesAfter: current,
      examples: examples.join(","),
    });
  }

  return { rawBodiesBytes: current, discardedFiles, discardedBytes };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const maxRuntimeMs = Number.isFinite(args.maxRuntimeSec)
    ? args.maxRuntimeSec * 1000
    : DEFAULT_MAX_RUNTIME_MS;
  const maxFiles = Number.isFinite(args.maxFiles) ? args.maxFiles : DEFAULT_MAX_FILES;
  const maxBytes = Number.isFinite(args.maxBytes) ? args.maxBytes : DEFAULT_MAX_BYTES;
  const startedAt = Date.now();

  let lockFd;
  try {
    lockFd = acquireLock();
  } catch (_) {
    logEvent("raw_uploader_skip", { reason: "locked" });
    return;
  }

  try {
    const cfg = readJSONSafe(ENDPOINT_FILE);
    const rawBodiesDir = cfg.rawBodiesDir || path.join(INSTALL_DIR, "raw-bodies");
    const token = readUploadToken();
    if (!cfg.rawUploadUrl) {
      logEvent("raw_uploader_skip", { reason: "missing_raw_upload_url" });
      return;
    }

    const state = readJSONSafe(STATE_FILE);
    state.files = state.files || {};
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    let failedFiles = 0;
    let discardedFiles = 0;
    let discardedBytes = 0;

    const preGuard = await applyDiskGuard(rawBodiesDir, cfg, state, "before_upload");
    discardedFiles += preGuard.discardedFiles;
    discardedBytes += preGuard.discardedBytes;
    if (preGuard.discardedFiles) writeJSONAtomic(STATE_FILE, state);

    for await (const file of walkRawFiles(rawBodiesDir)) {
      if (Date.now() - startedAt > maxRuntimeMs) break;
      if (uploadedFiles >= maxFiles || uploadedBytes >= maxBytes) break;

      const stat = await stableStat(file);
      if (!stat) continue;
      const fileName = path.basename(file);
      const bodyKind = fileBodyKind(fileName);
      if (Date.now() - stat.mtimeMs > DEFAULT_RAW_RETENTION_MS && state.files[path.basename(file)]?.uploaded) {
        try {
          await fs.promises.unlink(file);
        } catch (_) {}
        continue;
      }

      const key = sourceFileKey(cfg.machineId || "", file, stat);
      const item = state.files[key] || {};
      if (item.uploaded) {
        try {
          await moveToSent(file);
        } catch (_) {}
        continue;
      }
      const nextAttemptAt = Number(item.nextAttemptAt || 0);
      if (nextAttemptAt && Date.now() < nextAttemptAt) {
        if (!(cfg.rawUploadMultipart && item.blockedByServerCapability)) continue;
      }

      try {
        const result = await uploadFile(file, stat, cfg, token);
        await moveToSent(file);
        state.files[key] = {
          uploaded: true,
          uploadedAt: new Date().toISOString(),
          fileName,
          bodyKind,
          bytes: result.bytes,
          mtimeMs: Math.floor(stat.mtimeMs),
          contentSha256: result.contentSha256,
        };
        uploadedFiles += 1;
        uploadedBytes += stat.size;
        logEvent("raw_uploader_file_uploaded", { file: fileName, bytes: stat.size });
      } catch (e) {
        failedFiles += 1;
        const failures = Number(item.failures || 0) + 1;
        const entry = {
          ...item,
          uploaded: false,
          fileName,
          bodyKind,
          bytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs),
          failures,
          lastError: errorText(e),
          lastAttemptAt: new Date().toISOString(),
          nextAttemptAt: Date.now() + nextBackoffMs(e, failures),
        };
        if (isServerCapabilityError(e)) entry.blockedByServerCapability = true;
        state.files[key] = entry;
        logEvent("raw_uploader_file_failed", {
          file: fileName,
          bytes: stat.size,
          failures,
          error: state.files[key].lastError,
        });
        if (isDiscardableUploadError(e)) {
          try {
            const dest = await discardRawFile(file, "upload_rejected");
            state.files[key] = {
              ...state.files[key],
              discarded: true,
              discardedAt: new Date().toISOString(),
              discardReason: "upload_rejected",
              discardedPath: dest,
            };
            discardedFiles += 1;
            discardedBytes += stat.size;
            logEvent("raw_uploader_file_discarded", {
              file: fileName,
              bytes: stat.size,
              reason: "upload_rejected",
            });
          } catch (discardErr) {
            logEvent("raw_uploader_discard_failed", {
              file: fileName,
              bytes: stat.size,
              reason: "upload_rejected",
              error: errorText(discardErr),
            });
          }
        }
      }

      writeJSONAtomic(STATE_FILE, state);
    }

    await cleanupSent(Date.now());
    await cleanupDiscarded(Date.now());
    const postGuard = await applyDiskGuard(rawBodiesDir, cfg, state, "after_upload");
    discardedFiles += postGuard.discardedFiles;
    discardedBytes += postGuard.discardedBytes;
    writeJSONAtomic(STATE_FILE, {
      ...state,
      lastRunAt: new Date().toISOString(),
      lastResult: failedFiles ? "partial_failed" : "ok",
      lastUploadedFiles: uploadedFiles,
      lastUploadedBytes: uploadedBytes,
      lastFailedFiles: failedFiles,
      lastDiscardedFiles: discardedFiles,
      lastDiscardedBytes: discardedBytes,
    });
    logEvent("raw_uploader_done", { uploadedFiles, uploadedBytes, failedFiles, discardedFiles, discardedBytes });
  } finally {
    releaseLock(lockFd);
  }
}

if (require.main === module) {
  run().catch((e) => {
    logEvent("raw_uploader_failed", {
      error: e && e.message ? e.message : "unknown",
    });
    process.exit(1);
  });
}

module.exports.__test__ = {
  fileBodyKind,
  fileToolKind,
};
