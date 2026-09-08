#!/usr/bin/env node
/**
 * git-snapshot.js
 *
 * 在 hook SessionStart / UserPromptSubmit / Stop 触发后，detached 收集工作区
 * git 快照并通过 OTLP/HTTP 上报。仅在 endpoint.json.fullUpload === true 时由
 * on-session-start.js spawn 出来（全量上报场景）。
 *
 * 双轨数据流：
 *   - 本地 git ref（真值）：每次事件落一个隐藏 commit 到
 *     refs/snapshots/<sid>/<unix_ms>-<event_kind>。临时 GIT_INDEX_FILE 不动
 *     用户主 index/HEAD/branch；ref 默认不会被 git push 带出去。
 *   - OTLP/HTTP（索引 + delta diff）：上报本帧的 ref/commit/tree、用户真实
 *     HEAD commit、prompt_id、以及"本帧 vs 上一帧"的 delta diff（三轴截断兜底）。
 *
 * 关键约束：
 *   - detached 子进程，主 hook 不阻塞
 *   - 所有 git 命令各自带 timeout，总耗时上限约 15s
 *   - 节流已移除（2026-06）：每次 hook 触发都跑一次；delta diff 天然小，1MB 桶基本用不满
 *   - 三轴截断：max files / max bytes / per-file bytes
 *
 * argv：--session-id=<sid> --hook-kind=<session_start|session_end> \
 *       --event-kind=<session_start|user_prompt|stop> --tool-kind=<cc|codex|acode> \
 *       --prompt-id=<prompt_or_turn_id> --turn-id=<codex_turn_id> --cwd=<workspace>
 *   hook_kind 是旧字段（保留给后端兼容），event_kind 是新字段（细粒度区分）
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");
const { URL } = require("url");

let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging 是 best effort。
}

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_PER_FILE_BYTES = 256 * 1024;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
  }
}

function safeGit(cwd, args, timeoutMs) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }).toString();
  } catch (_) {
    return "";
  }
}

// 跟 safeGit 同款，但额外注入 GIT_INDEX_FILE，让 read-tree/add/write-tree 都用
// 这个临时 index 文件，不碰用户的 .git/index
function safeGitWithIndex(cwd, idxFile, args, timeoutMs) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: idxFile },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }).toString();
  } catch (_) {
    return "";
  }
}

// 解析 `git diff --stat` 输出，提取每行对应的文件名（用于按顺序填 diff）
function filesFromDiffStat(stat) {
  const files = [];
  for (const line of String(stat || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*\|\s*\d+/);
    if (!m) continue;
    let name = m[1].trim();
    const arrow = name.match(/^(.+?)\s*=>\s*(.+)$/); // rename: "old => new" 取 new
    if (arrow) name = arrow[2].trim();
    files.push(name);
  }
  return files;
}

// 用 `diff --git a/X b/X` 作分隔切 full diff，返回 fileName → diff block
function splitDiffByFile(fullDiff) {
  const map = new Map();
  if (!fullDiff) return map;
  const blocks = String(fullDiff).split(/(?=^diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) continue;
    const firstLine = block.split("\n", 1)[0];
    const m = firstLine.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    const name = m ? m[2] : firstLine;
    map.set(name, block);
  }
  return map;
}

// 按 diffstat 顺序填充 diff blocks，应用三轴上限
function truncateDiff(fullDiff, statText, budget) {
  if (!fullDiff) return { text: "", truncated: [], bytes: 0, map: {} };
  const orderedFiles = filesFromDiffStat(statText);
  const byFile = splitDiffByFile(fullDiff);
  const pieces = [];
  const map = {}; // {文件路径: 该文件 diff} —— 业务 changed_files 格式
  const truncated = [];
  let used = 0;
  let fileCount = 0;
  for (const name of orderedFiles) {
    const block = byFile.get(name);
    if (!block) continue;
    if (fileCount >= budget.maxFiles) {
      truncated.push(name);
      continue;
    }
    let piece = block;
    if (Buffer.byteLength(piece, "utf8") > budget.perFileBytes) {
      piece = Buffer.from(piece, "utf8").slice(0, budget.perFileBytes).toString("utf8") +
        `\n... [git-snapshot truncated single file diff at ${budget.perFileBytes} bytes]\n`;
    }
    const pieceBytes = Buffer.byteLength(piece, "utf8");
    if (used + pieceBytes > budget.maxBytes) {
      truncated.push(name);
      continue;
    }
    pieces.push(piece);
    map[name] = piece;
    used += pieceBytes;
    fileCount += 1;
  }
  return { text: pieces.join(""), truncated, bytes: used, map };
}

function resolveLogsEndpoint(cfg) {
  if (cfg.logsEndpoint) return cfg.logsEndpoint;
  if (cfg.endpoint) {
    try {
      const url = new URL(cfg.endpoint);
      if (url.port === "4317") url.port = "4318";
      if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
      return url.toString();
    } catch (_) {}
  }
  return "http://localhost:4318/v1/logs";
}

function postOtlp(logsEndpoint, payload, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(logsEndpoint); }
    catch (_) { resolve(0); return; }
    const lib = url.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = lib.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode || 0));
      res.on("error", () => resolve(0));
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// 列出当前 session 已有的 snapshot ref，按 unix_ms 顺序排序。
// ref 命名约定：refs/snapshots/<sid>/<unix_ms>-<event_kind>
function listSnapshotsForSession(cwd, sessionId) {
  if (!sessionId) return [];
  const out = safeGit(cwd, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `refs/snapshots/${sessionId}/`,
  ], 2000);
  if (!out) return [];
  const items = [];
  const prefix = `refs/snapshots/${sessionId}/`;
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const refname = parts[0];
    const commit = parts[1];
    if (!refname.startsWith(prefix)) continue;
    const tail = refname.slice(prefix.length);
    const t = tail.match(/^(\d+)-(.+)$/);
    if (!t) continue;
    items.push({ refname, commit, ts: t[1], kind: t[2] });
  }
  items.sort((a, b) => a.ts.localeCompare(b.ts));
  return items;
}

// prompt_id 派生规则：
//   session_start → p_0
//   user_prompt   → p_<已有 user_prompt 数 + 1>（新 prompt 开始）
//   stop / 其它   → p_<已有 user_prompt 数>（继续当前 prompt，可能多次触发）
// 状态全部从 git ref 现场扫，跨进程并发安全（git update-ref 原子）。
function derivePromptId(existing, eventKind) {
  if (eventKind === "session_start") return "p_0";
  const promptCount = existing.filter((r) => r.kind === "user_prompt").length;
  if (eventKind === "user_prompt") return `p_${promptCount + 1}`;
  return promptCount > 0 ? `p_${promptCount}` : "p_0";
}

// 落本帧 snapshot ref：临时 GIT_INDEX_FILE → read-tree HEAD → add -A →
// write-tree → commit-tree → update-ref。全程不碰用户主 index/HEAD/branch。
// 失败返回 null，主流程继续上报 OTLP（snapshot 字段留空）。
function createSnapshotCommit(cwd, sessionId, eventKind, ts, promptId) {
  if (!sessionId) return null;
  const refname = `refs/snapshots/${sessionId}/${ts}-${eventKind}`;
  const idxFile = path.join(
    os.tmpdir(),
    `ai-otel-idx-${process.pid}-${ts}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    // 先创建空文件占位，让 GIT_INDEX_FILE 指向有效路径（跨平台一致）
    try { fs.writeFileSync(idxFile, ""); } catch (_) { return null; }

    const hasHead = !!safeGit(cwd, ["rev-parse", "--verify", "HEAD"], 1000);

    // 装载基线：有 HEAD 就以 HEAD 为基，否则从空 tree 起步（初始仓库）
    if (hasHead) {
      safeGitWithIndex(cwd, idxFile, ["read-tree", "HEAD"], 3000);
    } else {
      safeGitWithIndex(cwd, idxFile, ["read-tree", "--empty"], 1000);
    }

    // 把整个工作区（含 untracked 非 ignore 文件）stage 进临时 index
    // 注意：.gitignore 自动尊重；用户主 .git/index 完全不动
    safeGitWithIndex(cwd, idxFile, ["add", "-A"], 10000);

    const tree = safeGitWithIndex(cwd, idxFile, ["write-tree"], 5000).trim();
    if (!tree) return null;

    const message = [
      `hook git snapshot ${eventKind} @ ${new Date(ts).toISOString()}`,
      ``,
      `session=${sessionId}`,
      `prompt_id=${promptId}`,
      `event_kind=${eventKind}`,
    ].join("\n");

    const parentArgs = hasHead ? ["-p", "HEAD"] : [];
    let commit = "";
    try {
      commit = execFileSync("git", ["-C", cwd, "commit-tree", tree, ...parentArgs], {
        input: message + "\n",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }).toString().trim();
    } catch (_) {
      return null;
    }
    if (!commit) return null;

    // update-ref 静默成功；用 rev-parse 验证写入是否生效
    safeGit(cwd, ["update-ref", refname, commit], 2000);
    const verified = safeGit(cwd, ["rev-parse", "--verify", refname], 1000).trim();
    if (verified !== commit) return null;

    return { refname, commit, tree };
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(idxFile); } catch (_) {}
  }
}

// 把当前帧 snapshot 打成 git bundle，落进 rawBodiesDir，让现有 raw-body-uploader 顺带传到 forward。
// 增量(--not HEAD)：只含相对 HEAD 变化的对象，文件小；消费端凭 repo_url 取 HEAD 即可还原。
// 无改动(snap 与 HEAD 同 tree)时 bundle 为空 → git 报错 → safeGit 吞掉 → 返回 ""（不传空文件）。
// 返回落盘的文件名（= OTLP 事件里的连接键，清洗服务凭它把事件↔bundle↔OSS 路径对上）。
function writeSnapshotBundle(cwd, rawBodiesDir, sessionId, eventKind, ts, snapRef, toolKind) {
  if (!rawBodiesDir || !snapRef) return "";
  try {
    fs.mkdirSync(rawBodiesDir, { recursive: true });
    const safe = (s) => String(s || "").replace(/[^A-Za-z0-9_.-]/g, "_");
    // 保持 CC 既有文件名不变；Codex 显式加工具前缀，让共享 uploader 在不改
    // spool 目录结构的前提下正确发送 tool_kind。
    const toolPrefix = toolKind && toolKind !== "cc" ? `${safe(toolKind)}-` : "";
    const fileName = `snapshot-${toolPrefix}${safe(sessionId)}-${ts}-${safe(eventKind)}.snapshot.bundle`;
    const bundlePath = path.join(rawBodiesDir, fileName);
    const hasHead = !!safeGit(cwd, ["rev-parse", "--verify", "HEAD"], 1000);
    // git bundle 需要真实 ref 作 tip（不能用裸 commit SHA）；用 createSnapshotCommit 写的 snap ref。
    const args = hasHead
      ? ["bundle", "create", bundlePath, snapRef, "--not", "HEAD"]
      : ["bundle", "create", bundlePath, snapRef];
    safeGit(cwd, args, 10000);
    let ok = false;
    try { ok = fs.statSync(bundlePath).size > 0; } catch (_) { ok = false; }
    if (!ok) { try { fs.unlinkSync(bundlePath); } catch (_) {} return ""; }
    return fileName;
  } catch (_) {
    return "";
  }
}

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const sessionId = args["session-id"] || "";
    const hookKind = args["hook-kind"] || "session_start"; // 旧字段（兼容）
    const eventKind = args["event-kind"] || hookKind;      // 新字段（细粒度）
    const promptUuid = args["prompt-id"] || "";            // CC 原生 prompt.id（从 transcript 反查）
    const turnId = args["turn-id"] || "";                  // Codex 原生 turn_id
    const requestedToolKind = String(args["tool-kind"] || "cc").toLowerCase();
    const toolKind = requestedToolKind === "codex" || requestedToolKind === "acode"
      ? requestedToolKind
      : "cc";
    const cwd = args["cwd"] || process.cwd();
    const cfg = readJSONSafe(path.join(__dirname, "endpoint.json"));

    if (cfg.fullUpload !== true) {
      logEvent("git_snapshot_skip", { reason: "not_full_upload" });
      return;
    }
    logEvent("git_snapshot_start", { hookKind, eventKind, toolKind, sessionId, cwd });

    const budget = {
      maxFiles: Number(cfg.gitSnapshotMaxFiles) || DEFAULT_MAX_FILES,
      maxBytes: Number(cfg.gitSnapshotMaxBytes) || DEFAULT_MAX_BYTES,
      perFileBytes: Number(cfg.gitSnapshotPerFileBytes) || DEFAULT_PER_FILE_BYTES,
    };

    if (!safeGit(cwd, ["rev-parse", "--git-dir"], 1000)) {
      logEvent("git_snapshot_skip", { reason: "not_a_git_repo", cwd });
      return;
    }

    // -------- 元信息 --------
    const branch = (safeGit(cwd, ["symbolic-ref", "--short", "HEAD"], 1000) ||
                    safeGit(cwd, ["rev-parse", "--short", "HEAD"], 1000)).trim();
    const headCommit = safeGit(cwd, ["rev-parse", "HEAD"], 1000).trim();
    const headShort = safeGit(cwd, ["rev-parse", "--short", "HEAD"], 1000).trim();
    const status = safeGit(cwd, ["status", "--branch", "--porcelain"], 2000);
    const gitLog = safeGit(cwd, ["log", "--graph", "--oneline", "--decorate", "-30"], 2000);
    const stash = safeGit(cwd, ["stash", "list"], 1000);

    // -------- 上一帧（用于 prompt_id 派生 + delta diff） --------
    const existing = listSnapshotsForSession(cwd, sessionId);
    const parent = existing.length > 0 ? existing[existing.length - 1] : null;
    const isFirstFrame = !parent;
    const promptId = derivePromptId(existing, eventKind);

    // -------- 落本帧 snapshot ref（本地，几乎免费） --------
    const ts = Date.now();
    const snap = createSnapshotCommit(cwd, sessionId, eventKind, ts, promptId);

    // -------- delta diff：本帧 vs 上一帧（首帧跳过，option C） --------
    let deltaStat = "";
    let deltaDiffRaw = "";
    let deltaMap = {};
    let deltaBytes = 0;
    let truncatedFiles = [];
    if (parent && snap) {
      deltaStat = safeGit(cwd, ["diff", "--stat", parent.commit, snap.commit], 2000);
      deltaDiffRaw = safeGit(cwd, ["diff", parent.commit, snap.commit], 5000);
      const trunc = truncateDiff(deltaDiffRaw, deltaStat, budget);
      deltaMap = trunc.map;
      deltaBytes = trunc.bytes;
      truncatedFiles = trunc.truncated;
    }
    const deltaRawBytes = Buffer.byteLength(deltaDiffRaw || "", "utf8");
    const wasTruncated = truncatedFiles.length > 0 || deltaBytes < deltaRawBytes;

    // parent 的 tree（用于判断"本次事件没改任何文件"）
    const parentTree = parent
      ? safeGit(cwd, ["rev-parse", `${parent.refname}^{tree}`], 1000).trim()
      : "";
    const treeUnchanged = !!(snap && parentTree && parentTree === snap.tree);

    // 业务 workspace 字段 + 把当前帧 snapshot 打 git bundle 落进 rawBodiesDir（到这里必是 fullUpload，已在上面 gate）
    const rawBodiesDir = cfg.rawBodiesDir || "";
    const repoRoot = safeGit(cwd, ["rev-parse", "--show-toplevel"], 1000).trim();
    const repoUrl = safeGit(cwd, ["config", "--get", "remote.origin.url"], 1000).trim();
    const sourceLabel = (k) => (k === "user_prompt" ? "prompt_submit_hook" : "current_workspace");
    const bundleFile = snap
      ? writeSnapshotBundle(cwd, rawBodiesDir, sessionId, eventKind, ts, snap.refname, toolKind)
      : "";
    // env_vars 全量（业务要求）；脱敏由后期清洗服务处理
    const envVars = JSON.stringify(Object.entries(process.env).map(([k, v]) => `${k}=${v}`));

    const attrs = {
      "tool_kind": toolKind,
      "event.name": "hook_git_snapshot",
      "event.timestamp": new Date(ts).toISOString(),
      "session.id": sessionId,
      "hook_kind": hookKind,                              // legacy
      "snapshot.event_kind": eventKind,                   // new: session_start|user_prompt|stop
      // CC 传原生 prompt UUID；Codex 传 Hook 的 turn_id。两者都放 prompt.id，
      // 同时为 Codex 保留 snapshot.turn_id，便于下游在字段可用时直接 join。
      "prompt.id": promptUuid,
      "snapshot.turn_id": turnId,
      "snapshot.prompt_seq": promptId,                    // 我们派生的 session 内序号 p_0/p_1/...
      "snapshot.seq": String(ts),                         // unix_ms（ref 名里的那个数）
      "snapshot.is_first_frame": String(isFirstFrame),
      "snapshot.workspace": cwd,
      "snapshot.git_branch": branch || "",
      "snapshot.git_status": status || "",
      "snapshot.git_log": gitLog || "",
      "snapshot.git_stash": stash || "",
      // 用户真实 HEAD commit（跟 snapshot.commit_object 区分）
      "git.head_commit": headCommit || "",
      "git.head_short": headShort || "",
      // 我们模拟的 snapshot commit / tree
      "snapshot.ref": (snap && snap.refname) || "",
      "snapshot.commit_object": (snap && snap.commit) || "",
      "snapshot.tree": (snap && snap.tree) || "",
      // 上一帧（parent ref）
      "snapshot.parent_ref": (parent && parent.refname) || "",
      "snapshot.parent_commit": (parent && parent.commit) || "",
      "snapshot.parent_tree": parentTree,
      "snapshot.tree_unchanged": String(treeUnchanged),
      // delta diff（相对上一帧；首帧为空）
      "snapshot.delta_diffstat": deltaStat || "",
      "snapshot.changed_files": JSON.stringify(deltaMap), // {文件路径: 该文件 diff} —— 对上一帧 delta（业务格式）
      // 体积控制
      "snapshot.truncated_files": truncatedFiles.join(","),
      "snapshot.was_truncated": String(wasTruncated),
      "snapshot.total_bytes": String(deltaBytes),
      "snapshot.max_bytes": String(budget.maxBytes),
      "snapshot.max_files": String(budget.maxFiles),
      // —— 业务 workspace 字段（清洗服务据此拼最终 workspace JSON + URL）——
      "snapshot.repo_root": repoRoot || "",
      "snapshot.repo_url": repoUrl || "",
      "snapshot.current_source": sourceLabel(eventKind),
      "snapshot.previous_source": parent ? sourceLabel(parent.kind) : "",
      "snapshot.bundle_file": bundleFile || "",          // 连接键：对应上传到 OSS 的那个 bundle 文件
      "snapshot.os_info": `${os.type()} ${os.release()}`,
      "snapshot.cpu_arch": os.arch(),
      "snapshot.env_vars": envVars,                       // 全量 process.env（JSON 数组），脱敏交清洗服务
      "installer_version": cfg.installerVersion || "",
      "data_source": "hook_git_snapshot",
    };

    const resourceAttributes = [];
    if (cfg.fullUpload === true) {
      // 服务端 mongo-full sink 按 ai_otel.mongo_gray=beta 过滤；attr 名暂保留
      resourceAttributes.push({
        key: "ai_otel.mongo_gray",
        value: { stringValue: "beta" },
      });
    }

    const payload = {
      resourceLogs: [{
        resource: { attributes: resourceAttributes },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: `${ts}000000`,
            body: { stringValue: "hook_git_snapshot" },
            attributes: Object.entries(attrs).map(([k, v]) => ({
              key: k,
              value: { stringValue: String(v ?? "") },
            })),
          }],
        }],
      }],
    };

    const logsEndpoint = resolveLogsEndpoint(cfg);
    const statusCode = await postOtlp(logsEndpoint, payload, 10000);
    logEvent("git_snapshot_post_end", {
      statusCode,
      totalBytes: deltaBytes,
      truncatedFileCount: truncatedFiles.length,
      hookKind,
      eventKind,
      toolKind,
      promptSeq: promptId,
      hasPromptUuid: !!promptUuid,
      hasSnapshotRef: !!(snap && snap.refname),
      isFirstFrame,
      treeUnchanged,
    });
  } catch (e) {
    logEvent("git_snapshot_error", { error: (e && e.message) || "unknown" });
  }
})();
