#!/usr/bin/env node
/**
 * ai-otel-setup
 *
 * 一行命令配置 Claude Code OTel 上报：
 *   npx -y ai-otel-setup url=COLLECTOR_HOST
 *
 * 该 installer **不走 CC plugin 机制**：直接把 hook 脚本铺到
 * ~/.claude/cc-otel/，并把 12 个 OTel env + SessionStart hook 注入
 * 用户的 ~/.claude/settings.json。安装后 `claude` 立即生效，无需 /plugin install。
 *
 * 关键约束：
 *   - 失败时尽量给出可操作信息，不静默
 *   - settings.json 写之前会备份到 settings.json.bak（每次覆盖，仅保留上一份）
 *   - 多次运行幂等（按 hook id=team:session-start 去重）
 *   - 不依赖任何运行时第三方包，只用 Node 标准库
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { execFileSync, spawn, spawnSync } = require("child_process");

const PKG_VERSION = require("./package.json").version;

// 安装时这台机器的 node 绝对路径，POSIX 上拿来构造 hook command 用。
// Windows 上不再写 node 绝对路径（见 buildHookCommand 注释）。
const NODE_BIN = process.execPath;

// 跨平台 hook 命令构造。
//
// **Windows 上的关键决策（v1.0.9 重构）**：不再写 node 绝对路径，也不再加引号，
// 让 shell 自己按空白 split + 用 PATH lookup node。原因：
//   - 写绝对路径如 "C:\Program Files\nodejs\node.exe"，PowerShell 5.1（cc/gemini
//     在 Windows 默认 shell）解析时会把外层引号脱掉，按空白把 "C:\Program" 切成
//     一个 token，"Files\nodejs\..." 切成另一个，hook 进程起不来，exit code 1。
//   - 用 8.3 短路径 (C:\Progra~1\...) 在 NTFS 8dot3name 禁用的卷上失效，
//     更糟的是 cmd /c for 在某些 locale 下输出会带额外引号，被 installer
//     二次拼装成 ""\"C:\\\"C:\\Program Files\\nodejs\\node.exe\\\"\"" 这种
//     非法嵌套，比原 bug 更难修。
//   - 改写 wrapper .cmd / .sh 让用户用别的 shell 接管 → 整体复杂度+30 行，
//     而且 wrapper 路径本身仍可能带空格，治标不治本。
//
// 务实最稳的解：让 shell 自己 PATH 找 node；两个 JS 路径作为 node 参数传入。
// Windows 下统一把反斜杠改成正斜杠：
//   - cmd / PowerShell / Node 都能识别 C:/Users/... 路径
//   - Git Bash / bash 不会再把 C:\Users\... 里的反斜杠当转义字符吃掉
// 参数路径加双引号，兼容用户名含空格的常见场景。
//
// launch-hook.js 内部还会再做一次 PATH 上探 node、失败时 fallback baked
// execPath 的兜底，所以 PATH 上 node 临时失踪也能起来。
//
// POSIX：保持 quoted 三段格式，shell 行为统一，路径有空格也安全。
function windowsNodeArg(p) {
  return `"${String(p).replace(/\\/g, "/")}"`;
}

function buildHookCommand(launcherPath, scriptPath) {
  if (process.platform === "win32") {
    return `node ${windowsNodeArg(launcherPath)} ${windowsNodeArg(scriptPath)}`;
  }
  return `"${NODE_BIN}" "${launcherPath}" "${scriptPath}"`;
}

// 把 launcher 模板拷到 hook 同目录，返回 launcher 的绝对路径
function installLauncher(installDir) {
  const launcherDest = path.join(installDir, "launch-hook.js");
  fs.copyFileSync(path.join(__dirname, "templates", "launch-hook.js"), launcherDest);
  fs.chmodSync(launcherDest, 0o755);
  fs.copyFileSync(path.join(__dirname, "templates", "logging.js"), path.join(installDir, "logging.js"));
  return launcherDest;
}

function writeInstallLog(installDir, tool, endpoint, otelTransport) {
  try {
    const { logEvent } = require(path.join(installDir, "logging.js"));
    logEvent("installer_complete", {
      tool,
      installerVersion: PKG_VERSION,
      endpoint: displayEndpoint(endpoint),
      otelTransport,
    });
  } catch (_) {
    // Logging must never break installation.
  }
}

const REQUIRED_KEYS = ["url"];
const HOOK_ID = "team:session-start";
// UserPromptSubmit 兜底 hook：复用同一脚本，靠 stdin.hook_event_name 分流；
// 单独 id 是为了让 settings.json 的 SessionStart / UserPromptSubmit 数组各自能按 id 去重
const PROMPT_HOOK_ID = "team:user-prompt-submit";
// Stop hook：CC 每轮返回结束触发，灰度场景用来发 git_snapshot session_end；
// 仍复用 on-session-start.js（按 hook_event_name=Stop 分流），便于幂等去重
const STOP_HOOK_ID = "team:stop";
const OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRICS_INCLUDE_VERSION",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES",
];

// ---------- argv 解析 ----------

function parseArgs(argv) {
  const out = {};
  const flat = [];
  for (const a of argv) {
    if (/^--?[a-z][a-z0-9-]*$/i.test(a)) {
      flat.push(a.replace(/^--?/, "") + "=true");
      continue;
    }
    // 兼容 url=x 单 argv 与 url=x 多 argv（保留逗号分隔，便于未来扩展）
    for (const part of a.split(",")) {
      if (part.trim()) flat.push(part.trim());
    }
  }
  for (const part of flat) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function validateArgs(args) {
  const errs = [];
  if (truthyFlag(args.http) && truthyFlag(args.grpc)) {
    errs.push("--http 与 --grpc 不能同时使用");
  }
  if (
    Object.prototype.hasOwnProperty.call(args, "beta") ||
    Object.prototype.hasOwnProperty.call(args, "full-upload") ||
    Object.prototype.hasOwnProperty.call(args, "--beta") ||
    Object.prototype.hasOwnProperty.call(args, "--full-upload") ||
    Object.prototype.hasOwnProperty.call(args, "-beta") ||
    Object.prototype.hasOwnProperty.call(args, "-full-upload")
  ) {
    errs.push("--beta / --full-upload 已不再支持：全量数据上报默认开启；如需关闭请使用 --no-full-upload");
  }
  for (const k of REQUIRED_KEYS) {
    if (!args[k]) {
      errs.push(`missing required: ${k}`);
      continue;
    }
    if (/\s/.test(args[k])) errs.push(`${k} 不允许包含空格: "${args[k]}"`);
    if (args[k].includes(",")) errs.push(`${k} 不允许包含逗号: "${args[k]}"`);
  }
  return errs;
}

function truthyFlag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function resolveOtelTransport(args) {
  if (truthyFlag(args.http)) return "http";
  if (truthyFlag(args.grpc)) return "grpc";
  return "http";
}

function normalizeOptionalUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function normalizeOptionalTag(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value;
}

function deriveRawUploadHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (!host || isIpHost(host) || isLocalHost(host)) return host;
  const parts = host.split(".");
  if (!parts.length) return host;
  if (parts[0].endsWith("-raw-upload")) {
    parts[0] = parts[0].replace(/-raw-upload$/, "-upload");
  } else if (!parts[0].endsWith("-upload")) {
    parts[0] = `${parts[0]}-upload`;
  }
  return parts.join(".");
}

// local-usage-scanner POST 目标：直接从主 endpoint 派生，独立于 rawUploadUrl
// （历史上 v1.0.31 用 rawUploadUrl 派生 + 端口 8082，导致没传 mongoGrayTag/upload-token 时
// rawUploadUrl 为空 → localUsageUrl 也为空 → scanner 静默 skip。v1.0.32 解耦，让全量装机都可用。）
//
// 派生规则：
//   - 域名应用 deriveRawUploadHost 改写（ai-otel.xxx → ai-otel-upload.xxx，与 rawUpload 同 host）
//   - 非 IP / 非 localhost：清掉端口（走 ingress 默认 443/80，服务端 8090 在 ingress 后面）
//   - IP / localhost：端口固定 8090（直连 raw-upload-server listener，与生产 ingress 同 port）
//   - 路径固定 /v1/local-usage
function deriveLocalUsageUrl(endpoint) {
  try {
    const u = new URL(logsEndpointFromGrpc(endpoint));
    u.hostname = deriveRawUploadHost(u.hostname);
    if (!isIpHost(u.hostname) && !isLocalHost(u.hostname)) {
      u.port = "";
    } else {
      u.port = "8090";
    }
    u.pathname = "/v1/local-usage";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

function rawUploadUrlFromEndpoint(endpoint) {
  try {
    const logsUrl = new URL(logsEndpointFromGrpc(endpoint));
    logsUrl.hostname = deriveRawUploadHost(logsUrl.hostname);
    if (!isIpHost(logsUrl.hostname) && !isLocalHost(logsUrl.hostname)) {
      logsUrl.port = "";
    }
    logsUrl.pathname = "/v1/raw-bodies";
    logsUrl.search = "";
    logsUrl.hash = "";
    return logsUrl.toString().replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

// ---------- url → endpoint ----------

function isIpHost(host) {
  return net.isIP(String(host || "").replace(/^\[|\]$/g, "")) !== 0;
}

function isLocalHost(host) {
  const value = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function bracketIpv6Host(host) {
  const normalized = String(host || "").replace(/^\[|\]$/g, "");
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function formatRootUrl(protocol, host, port) {
  return `${protocol}//${bracketIpv6Host(host)}${port ? ":" + port : ""}`;
}

function resolveEndpoint(rawUrl) {
  const input = String(rawUrl || "").trim();

  // 用户传完整 URL：保留显式 protocol/port/path；仅在未写 port 时按 IP/域名补默认 gRPC 端口。
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (!url.port) url.port = isIpHost(url.hostname) ? "4317" : "24317";
    if (url.pathname === "/" && !url.search && !url.hash) {
      return formatRootUrl(url.protocol, url.hostname, url.port);
    }
    return url.toString();
  }

  // 用户传裸地址：
  //   - IP：本地/内网测试形态，OTLP/gRPC = http://IP:4317
  //   - 域名：生产公网形态，OTLP/gRPC = https://DOMAIN:24317
  // 判断只看地址形态，不写入任何具体 host。
  const url = new URL(`http://${input}`);
  const localOrIp = isIpHost(url.hostname) || isLocalHost(url.hostname);
  const port = url.port || (localOrIp ? "4317" : "24317");
  return formatRootUrl(localOrIp ? "http:" : "https:", url.hostname, port);
}

function httpRootEndpointFromLogs(logsEndpoint) {
  const url = new URL(logsEndpoint);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function metricsEndpointFromLogs(logsEndpoint) {
  const url = new URL(logsEndpoint);
  url.pathname = "/v1/metrics";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function tracesEndpointFromLogs(logsEndpoint) {
  const url = new URL(logsEndpoint);
  url.pathname = "/v1/traces";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function extractHost(endpoint) {
  // 从已 resolve 的 endpoint 取 host（不带端口），用于 NO_PROXY
  try {
    return new URL(endpoint).hostname;
  } catch (_) {
    return endpoint.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  }
}

function displayEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (!isIpHost(url.hostname)) {
      // 生产域名的真实 gRPC 端口只写入配置，不在安装完成日志里暴露。
      url.port = "";
      if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
      return url.toString();
    }
  } catch (_) {
    // 展示失败时沿用原值，不影响安装。
  }
  return endpoint;
}

function appendNoProxyUrlEntries(entries, endpoint) {
  try {
    const url = new URL(endpoint);
    if (!entries.includes(url.hostname)) entries.push(url.hostname);
    const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    const hostPort = port ? `${url.hostname}:${port}` : "";
    if (hostPort && !entries.includes(hostPort)) entries.push(hostPort);
  } catch (_) {
    const host = extractHost(endpoint);
    if (host && !entries.includes(host)) entries.push(host);
  }
}

function buildNoProxyEntries(endpoint, otelTransport) {
  const entries = [];
  appendNoProxyUrlEntries(entries, endpoint);
  if (otelTransport === "http") {
    appendNoProxyUrlEntries(entries, logsEndpointFromGrpc(endpoint));
  }
  return entries;
}

function mergeNoProxy(existing, entries) {
  // 合并保留用户已有 NO_PROXY 值，仅追加 collector host，去重保序
  const list = (existing || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries || []) {
    if (entry && !list.includes(entry)) list.push(entry);
  }
  return list.join(",");
}

// ---------- git config 兜底 (跨平台) ----------
//
// hook 进程偶有"压根没跑"的场景（网络/超时/进程崩溃），导致 git.user.email/name 永久丢失。
// 装机时把全局 git config 写到 OTEL_RESOURCE_ATTRIBUTES，CC SDK 自动把 resource attr
// 带到每条 metric/log，service 端在 SessionStore miss 时用它兜底（参见 translator.js
// 的 RESOURCE_FALLBACK_KEYS）。
//
// 跨平台细节：
//   - execFileSync(cmd, args)：不经过 shell，Win/Mac 行为一致
//   - windowsHide:true：Windows 上不弹 cmd 黑窗
//   - stdio[2]="ignore"：屏蔽 stderr，避免 git 报错刷屏
//   - timeout:1000：超时直接当成"读不到"，不让 installer 卡住
//   - ENOENT (git 没装) / 退出码非 0 (key 没设) 都吞掉返回空串
function readGlobalGitUser() {
  function readGitVal(key) {
    try {
      return execFileSync("git", ["config", "--global", "--get", key], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (_) {
      return "";
    }
  }
  return {
    name: readGitVal("user.name"),
    email: readGitVal("user.email"),
  };
}

// ---------- 装机上报：走同一条 OTel 管线 ----------
//
// 历史：原 POST 到 cc-view-server :8081/api/installer/report 直写 Doris。
// otel-prod 部署到公网、cc-view-web 留在内网后，installer 只能跟 OTel collector
// 说话；改成发一条 OTLP/HTTP log（event.name = installer_register），由 forwarder
// 走同一条管线落到 iData，cc-view-server 端从事件表 reduce 出装机记录。
// 这样 installer 命令依旧只暴露一个 url，跟数据上报完全同源。
//
// 设计原则：
//   - fire-and-forget：2.5s 超时、不重试、任何失败绝不让安装本身退出非 0
//   - 复用 logsEndpointFromGrpc：4317 → 4318，path 自动补 /v1/logs
//   - debug 模式下才打错误，正常运行不污染 stdout

function postJsonWithTimeout(targetUrl, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? require("https") : require("http");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: (u.pathname || "/") + (u.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        // 排空 body，让 socket 进入 keepalive/释放
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode || 0));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function reportInstall(otelEndpoint, gitUser, allResults, debug, fullUpload) {
  if (!gitUser || !gitUser.email) {
    if (debug) console.error("[ai-otel-setup] 跳过装机上报：无 git user.email");
    return;
  }
  const logsUrl = logsEndpointFromGrpc(otelEndpoint);
  if (!logsUrl) return;
  const findOk = (tool) =>
    allResults.find((r) => r.tool === tool)?.status === "installed";

  // OTLP/HTTP log record。translator (lib/translate/installer_register.js) 按
  // event.name = "installer_register" 路由到对应 eid，把 git.user.* / hostname
  // 经 contextBlocksFromAttrs 落进 user 块，installer_* / os_* / node_version /
  // *_cli_detected 走 phase1UdmapFields 白名单进 udmap。
  const sessionId = `installer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const attrs = {
    "tool_kind": "installer",
    "event.name": "installer_register",
    "event.timestamp": new Date().toISOString(),
    "session.id": sessionId,
    "git.user.email": gitUser.email,
    "git.user.name": gitUser.name || "",
    "hostname": os.hostname() || "",
    "installer_version": PKG_VERSION,
    "os_platform": os.platform(),
    "os_arch": os.arch(),
    "node_version": process.version,
    "cc_cli_detected": findOk("claude") ? "1" : "0",
    "codex_cli_detected": findOk("codex") ? "1" : "0",
    "full_upload": fullUpload ? "1" : "0",
  };
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: `${Date.now()}000000`,
                body: { stringValue: "installer_register" },
                attributes: Object.entries(attrs).map(([k, v]) => ({
                  key: k,
                  value: { stringValue: String(v ?? "") },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    await postJsonWithTimeout(logsUrl, payload, 2500);
    if (debug) console.error("[ai-otel-setup] 装机上报已发送 →", logsUrl);
  } catch (e) {
    if (debug) {
      console.error("[ai-otel-setup] 装机上报失败（不影响安装）:", e.message || e);
    }
  }
}

// ---------- OTEL_RESOURCE_ATTRIBUTES (W3C baggage 风格) ----------

// "k1=urlencoded,k2=urlencoded2" → { k1: "decoded", k2: "decoded2" }
function parseResourceAttrs(s) {
  const out = {};
  if (!s || typeof s !== "string") return out;
  for (const pair of s.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    if (!k) continue;
    const raw = pair.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(raw);
    } catch (_) {
      out[k] = raw; // decode 失败原样保留，不抛
    }
  }
  return out;
}

function serializeResourceAttrs(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === "" || v === null || v === undefined) continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.join(",");
}

// parse-merge-serialize：保留用户自定义 attr（如 region=us-east），仅注入/覆盖 git.user.*
function mergeResourceAttrs(existing, gitUser) {
  const attrs = parseResourceAttrs(existing || "");
  if (gitUser.email) attrs["git.user.email"] = gitUser.email;
  if (gitUser.name) attrs["git.user.name"] = gitUser.name;
  attrs["installer_version"] = PKG_VERSION; // CC SDK 自动挂到每条 native OTel 事件的 resource attr
  return serializeResourceAttrs(attrs);
}

// ---------- 文件操作 ----------

function readJSONSafe(p) {
  try {
    if (!fs.existsSync(p)) return {};
    const txt = fs.readFileSync(p, "utf8");
    if (!txt.trim()) return {};
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`读取 ${p} 失败：${e.message}`);
  }
}

function writeJSONAtomic(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const bak = `${p}.bak`;
  fs.copyFileSync(p, bak);
  return bak;
}

function removeSessionSeenMarkers(installDir) {
  try {
    if (!fs.existsSync(installDir)) return 0;
    let count = 0;
    for (const name of fs.readdirSync(installDir)) {
      if (!name.startsWith(".session-seen.")) continue;
      try {
        fs.unlinkSync(path.join(installDir, name));
        count++;
      } catch (_) {
        // Best effort cleanup.
      }
    }
    return count;
  } catch (_) {
    return 0;
  }
}

// ---------- 合并逻辑 ----------

function buildEnv(template, args, endpoint, otelTransport, rawBodiesDir, fullUpload) {
  const env = { ...template.env };
  if (otelTransport === "http") {
    const logsEndpoint = logsEndpointFromGrpc(endpoint);
    env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    env.OTEL_EXPORTER_OTLP_ENDPOINT = httpRootEndpointFromLogs(logsEndpoint);
    env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf";
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = logsEndpoint;
    env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/protobuf";
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsEndpointFromLogs(logsEndpoint);
  } else {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  }
  // fullUpload 默认开启；显式 --no-full-upload 时由 settings.template.json 的安全默认值兜底
  // （USER_PROMPTS=0 / TOOL_CONTENT=0 / 不写 RAW_API_BODIES）。
  // OTEL_KEYS 在 mergeSettings 里走 "has → overwrite，没有 → delete" 语义，所以
  // 切回非 fullUpload 时上一轮残留的 RAW_API_BODIES 会被自动清掉。
  if (fullUpload) {
    env.OTEL_LOG_USER_PROMPTS = "1";
    env.OTEL_LOG_TOOL_CONTENT = "1";
    env.OTEL_LOG_RAW_API_BODIES = `file:${rawBodiesDir}`;
  }
  // OTEL_RESOURCE_ATTRIBUTES 由 mergeSettings 单独处理（parse-merge 用户已有 + 注入 git.user.*）
  return env;
}

function mergeSettings(existing, newEnv, hookEntry, promptHookEntry, stopHookEntry, noProxyEntries, gitUser, machineId, fullUpload) {
  const merged = { ...existing };

  // env：plugin 优先（组织规范不允许个人改红线），但保留用户独有的 env
  merged.env = { ...(existing.env || {}) };
  for (const k of OTEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(newEnv, k)) merged.env[k] = newEnv[k];
    else delete merged.env[k];
  }

  // OTEL_RESOURCE_ATTRIBUTES：parse-merge 用户已有 attr + 注入 git.user.email/name。
  // 不进 OTEL_KEYS（OTEL_KEYS 走 overwrite，会丢掉用户自定义如 region=us-east）。
  // 只在 readGlobalGitUser 拿到非空值时写；全空时保持用户已有值不动（包括不删）。
  if (gitUser && (gitUser.name || gitUser.email)) {
    const ra = mergeResourceAttrs(merged.env.OTEL_RESOURCE_ATTRIBUTES, gitUser);
    if (ra) merged.env.OTEL_RESOURCE_ATTRIBUTES = ra;
  }
  if (machineId) {
    const attrs = parseResourceAttrs(merged.env.OTEL_RESOURCE_ATTRIBUTES || "");
    attrs["ai_otel.machine_id"] = machineId;
    // 全量上报开启：写 ai_otel.mongo_gray=beta（服务端 mongo-full sink 当前仍按此 attr
    // 过滤，故 attr 名暂保留）。关闭：显式 delete，让 --no-full-upload 能彻底卸下。
    if (fullUpload) attrs["ai_otel.mongo_gray"] = "beta";
    else delete attrs["ai_otel.mongo_gray"];
    merged.env.OTEL_RESOURCE_ATTRIBUTES = serializeResourceAttrs(attrs);
  }

  // 兜底用户写坏的 HTTP(S)_PROXY：把 collector host 与 host:port 加进 NO_PROXY，让 OTel gRPC 绕过代理
  // 仅追加，不动用户原有的 NO_PROXY 值，也不动 HTTP_PROXY / HTTPS_PROXY
  if (noProxyEntries && noProxyEntries.length) {
    merged.env.NO_PROXY = mergeNoProxy(merged.env.NO_PROXY, noProxyEntries);
    merged.env.no_proxy = mergeNoProxy(merged.env.no_proxy, noProxyEntries);
  }

  merged.hooks = { ...(existing.hooks || {}) };

  const isManagedClaudeHook = (h, expectedId) => {
    if (!h) return false;
    if (h.id === expectedId) return true;
    const hooks = Array.isArray(h.hooks) ? h.hooks : [];
    return hooks.some((item) => {
      const command = String(item && item.command ? item.command : "");
      return command.includes("cc-otel") && command.includes("launch-hook.js") && command.includes("on-session-start.js");
    });
  };

  // hooks.SessionStart：按 id 去重，存在则覆盖，不存在则追加
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const keptSessionStart = sessionStart.filter((h) => !isManagedClaudeHook(h, HOOK_ID));
  keptSessionStart.push(hookEntry);
  merged.hooks.SessionStart = keptSessionStart;

  // hooks.UserPromptSubmit：兜底 hook，按 PROMPT_HOOK_ID 去重，规则同上
  if (promptHookEntry) {
    const userPromptSubmit = Array.isArray(merged.hooks.UserPromptSubmit)
      ? [...merged.hooks.UserPromptSubmit]
      : [];
    const keptUserPromptSubmit = userPromptSubmit.filter((h) => !isManagedClaudeHook(h, PROMPT_HOOK_ID));
    keptUserPromptSubmit.push(promptHookEntry);
    merged.hooks.UserPromptSubmit = keptUserPromptSubmit;
  }

  // hooks.Stop：每轮返回结束触发，灰度发 git_snapshot session_end，按 STOP_HOOK_ID 去重
  if (stopHookEntry) {
    const stop = Array.isArray(merged.hooks.Stop)
      ? [...merged.hooks.Stop]
      : [];
    const keptStop = stop.filter((h) => !isManagedClaudeHook(h, STOP_HOOK_ID));
    keptStop.push(stopHookEntry);
    merged.hooks.Stop = keptStop;
  }

  return merged;
}

function logsEndpointFromGrpc(endpoint) {
  try {
    const grpcUrl = new URL(endpoint);
    const localOrIp = isIpHost(grpcUrl.hostname) || isLocalHost(grpcUrl.hostname);
    const logsUrl = new URL(`${localOrIp ? "http:" : "https:"}//${bracketIpv6Host(grpcUrl.hostname)}`);

    if (localOrIp) {
      logsUrl.port = !grpcUrl.port || grpcUrl.port === "4317" ? "4318" : grpcUrl.port;
    } else if (grpcUrl.port && grpcUrl.port !== "24317") {
      logsUrl.port = grpcUrl.port;
    }

    logsUrl.pathname =
      !grpcUrl.pathname || grpcUrl.pathname === "/" ? "/v1/logs" : grpcUrl.pathname;
    logsUrl.search = grpcUrl.search;
    return logsUrl.toString();
  } catch (_) {
    return "http://localhost:4318/v1/logs";
  }
}

function buildEndpointConfig(endpoint, otelTransport) {
  return {
    endpoint,
    logsEndpoint: logsEndpointFromGrpc(endpoint),
    otelTransport,
    installerVersion: PKG_VERSION,
    packageName: "ai-otel-setup",
  };
}

function getOrCreateMachineId(installDir) {
  const p = path.join(installDir, "machine-id");
  try {
    if (fs.existsSync(p)) {
      const existing = fs.readFileSync(p, "utf8").trim();
      if (existing) return existing;
    }
  } catch (_) {
    // Regenerate below.
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(p, id + "\n", { mode: 0o600 });
  return id;
}

function buildFullEndpointConfig(endpoint, otelTransport, extra = {}) {
  return {
    ...buildEndpointConfig(endpoint, otelTransport),
    ...extra,
  };
}

function installRawUploader(installDir, uploadToken) {
  const uploaderDir = path.join(installDir, "raw-uploader");
  fs.mkdirSync(uploaderDir, { recursive: true });
  const uploaderDest = path.join(installDir, "raw-body-uploader.js");
  fs.copyFileSync(path.join(__dirname, "templates", "raw-body-uploader.js"), uploaderDest);
  fs.chmodSync(uploaderDest, 0o755);
  const tokenPath = path.join(installDir, "raw-upload-token");
  if (uploadToken) {
    fs.writeFileSync(tokenPath, String(uploadToken).trim() + "\n", { mode: 0o600 });
  } else if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
  }
}

function launchctlPath() {
  try {
    return execFileSync("/usr/bin/which", ["launchctl"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch (_) {
    return "";
  }
}

function installMacRawUploaderTimer(installDir) {
  if (process.platform !== "darwin") return { status: "skipped" };
  const launchctl = launchctlPath();
  if (!launchctl) return { status: "skipped", reason: "launchctl not found" };
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const plistPath = path.join(agentsDir, "com.ai-otel.raw-uploader.plist");
  const uploaderPath = path.join(installDir, "raw-body-uploader.js");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-otel.raw-uploader</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(NODE_BIN)}</string>
    <string>${escapeXml(uploaderPath)}</string>
    <string>--once</string>
    <string>--max-runtime=25</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(installDir, "raw-uploader.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(installDir, "raw-uploader.err.log"))}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, "utf8");
  try {
    spawnSync(launchctl, ["unload", plistPath], {
      stdio: "ignore",
      timeout: 3000,
    });
  } catch (_) {}
  const r = spawnSync(launchctl, ["load", plistPath], {
    stdio: "ignore",
    timeout: 3000,
  });
  return {
    status: r.status === 0 ? "installed" : "written",
    path: plistPath,
  };
}

function systemdQuoteArg(arg) {
  return `"${String(arg).replace(/(["\\$`])/g, "\\$1")}"`;
}

function installLinuxRawUploaderTimer(installDir) {
  if (process.platform !== "linux") return { status: "skipped" };
  const systemctl = (() => {
    try {
      return execFileSync("/usr/bin/which", ["systemctl"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
    } catch (_) {
      return "";
    }
  })();

  const uploaderPath = path.join(installDir, "raw-body-uploader.js");
  const unitName = "ai-otel-raw-uploader";
  const userSystemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(userSystemdDir, `${unitName}.service`);
  const timerPath = path.join(userSystemdDir, `${unitName}.timer`);

  if (systemctl) {
    fs.mkdirSync(userSystemdDir, { recursive: true });
    const service = `[Unit]
Description=AI OTEL raw body uploader

[Service]
Type=oneshot
ExecStart=${systemdQuoteArg(NODE_BIN)} ${systemdQuoteArg(uploaderPath)} --once --max-runtime=25
`;
    const timer = `[Unit]
Description=Run AI OTEL raw body uploader every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
Unit=${unitName}.service

[Install]
WantedBy=timers.target
`;
    fs.writeFileSync(servicePath, service, "utf8");
    fs.writeFileSync(timerPath, timer, "utf8");

    try {
      spawnSync(systemctl, ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 });
      spawnSync(systemctl, ["--user", "enable", "--now", `${unitName}.timer`], {
        stdio: "ignore",
        timeout: 8000,
      });
      return { status: "installed", path: timerPath };
    } catch (_) {
      // Fall through to crontab fallback below.
    }
  }

  const crontab = (() => {
    try {
      return execFileSync("/usr/bin/which", ["crontab"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
    } catch (_) {
      return "";
    }
  })();
  if (!crontab) return { status: "written", reason: "systemctl/crontab not found" };

  const cronMarker = "# ai-otel-raw-uploader";
  const cronLine = `* * * * * ${systemdQuoteArg(NODE_BIN)} ${systemdQuoteArg(uploaderPath)} --once --max-runtime=25 >/dev/null 2>&1 ${cronMarker}`;
  let existing = "";
  try {
    existing = execFileSync(crontab, ["-l"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
  } catch (_) {
    existing = "";
  }
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.includes(cronMarker));
  lines.push(cronLine);
  const payload = lines.join("\n") + "\n";
  const r = spawnSync(crontab, ["-"], {
    input: payload,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 5000,
  });
  return {
    status: r.status === 0 ? "installed" : "written",
    path: "crontab",
  };
}

function installWindowsRawUploaderTimer(installDir) {
  if (process.platform !== "win32") return { status: "skipped" };
  const schtasks = (() => {
    try {
      return execFileSync("where", ["schtasks"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: true,
        timeout: 1000,
        windowsHide: true,
      })
        .split(/\r?\n/)[0]
        .trim();
    } catch (_) {
      return "schtasks";
    }
  })();
  const taskName = "ai-otel-raw-uploader";
  const uploaderPath = path.join(installDir, "raw-body-uploader.js").replace(/\\/g, "/");
  const nodePath = NODE_BIN.replace(/\\/g, "/");
  const taskCommand = `"${nodePath}" "${uploaderPath}" --once --max-runtime=25`;

  try {
    spawnSync(schtasks, ["/Delete", "/F", "/TN", taskName], {
      stdio: "ignore",
      shell: true,
      timeout: 5000,
      windowsHide: true,
    });
  } catch (_) {}

  const r = spawnSync(
    schtasks,
    ["/Create", "/F", "/SC", "MINUTE", "/MO", "1", "/TN", taskName, "/TR", taskCommand],
    {
      stdio: "ignore",
      shell: true,
      timeout: 8000,
      windowsHide: true,
    }
  );
  return {
    status: r.status === 0 ? "installed" : "written",
    path: taskName,
  };
}

function installRawUploaderTimer(installDir) {
  if (process.platform === "darwin") return installMacRawUploaderTimer(installDir);
  if (process.platform === "linux") return installLinuxRawUploaderTimer(installDir);
  if (process.platform === "win32") return installWindowsRawUploaderTimer(installDir);
  return { status: "skipped" };
}

// 卸载之前装机留下的 raw-uploader timer。三种触发场景共用：
//   1. --no-full-upload 装机：每次都跑一次 uninstall，把残留干掉（幂等，没残留就 no-op）
//   2. fullUpload 装机：install 之前先 uninstall（旧的 plist/unit 内容可能旧版本，刷新）
//   3. （未来）显式 cleanup 子命令
// 失败不抛错，最差就是 launchd/systemd/schtasks 里残一份；状态字段给主流程拿来打日志。
function uninstallMacRawUploaderTimer() {
  if (process.platform !== "darwin") return { status: "skipped" };
  const launchctl = launchctlPath();
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.ai-otel.raw-uploader.plist");
  if (!fs.existsSync(plistPath) && !launchctl) return { status: "noop" };
  if (launchctl && fs.existsSync(plistPath)) {
    try {
      spawnSync(launchctl, ["unload", plistPath], { stdio: "ignore", timeout: 3000 });
    } catch (_) {}
  }
  try { if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath); } catch (_) {}
  return { status: "removed", path: plistPath };
}

function uninstallLinuxRawUploaderTimer() {
  if (process.platform !== "linux") return { status: "skipped" };
  const unitName = "ai-otel-raw-uploader";
  const userSystemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(userSystemdDir, `${unitName}.service`);
  const timerPath = path.join(userSystemdDir, `${unitName}.timer`);
  const systemctl = (() => {
    try {
      return execFileSync("/usr/bin/which", ["systemctl"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
    } catch (_) { return ""; }
  })();
  if (systemctl) {
    try {
      spawnSync(systemctl, ["--user", "disable", "--now", `${unitName}.timer`], { stdio: "ignore", timeout: 5000 });
    } catch (_) {}
    try { spawnSync(systemctl, ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 }); } catch (_) {}
  }
  try { if (fs.existsSync(timerPath)) fs.unlinkSync(timerPath); } catch (_) {}
  try { if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath); } catch (_) {}

  // crontab 兜底：删带 marker 的行
  const crontab = (() => {
    try {
      return execFileSync("/usr/bin/which", ["crontab"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
    } catch (_) { return ""; }
  })();
  if (crontab) {
    let existing = "";
    try {
      existing = execFileSync(crontab, ["-l"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
    } catch (_) {}
    const cronMarker = "# ai-otel-raw-uploader";
    if (existing.includes(cronMarker)) {
      const lines = existing.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l && !l.includes(cronMarker));
      const payload = lines.length ? lines.join("\n") + "\n" : "";
      try {
        spawnSync(crontab, ["-"], {
          input: payload,
          encoding: "utf8",
          stdio: ["pipe", "ignore", "ignore"],
          timeout: 5000,
        });
      } catch (_) {}
    }
  }
  return { status: "removed" };
}

function uninstallWindowsRawUploaderTimer() {
  if (process.platform !== "win32") return { status: "skipped" };
  const schtasks = (() => {
    try {
      return execFileSync("where", ["schtasks"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: true,
        timeout: 1000,
        windowsHide: true,
      }).split(/\r?\n/)[0].trim();
    } catch (_) { return "schtasks"; }
  })();
  try {
    spawnSync(schtasks, ["/Delete", "/F", "/TN", "ai-otel-raw-uploader"], {
      stdio: "ignore",
      shell: true,
      timeout: 5000,
      windowsHide: true,
    });
  } catch (_) {}
  return { status: "removed" };
}

function uninstallRawUploaderTimer() {
  if (process.platform === "darwin") return uninstallMacRawUploaderTimer();
  if (process.platform === "linux") return uninstallLinuxRawUploaderTimer();
  if (process.platform === "win32") return uninstallWindowsRawUploaderTimer();
  return { status: "skipped" };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------- Codex config.toml 处理 ----------
//
// 真实 schema（参见 https://developers.openai.com/codex/config-reference 与 /codex/hooks）：
//
//   [features]
//   codex_hooks = true                          ← 没这个 flag，整段 hooks 被忽略
//
//   [otel]
//   exporter = "otlp-grpc"                      ← 用 exporter 选 transport，不是 enabled / protocol
//   metrics_exporter = "otlp-grpc"
//   trace_exporter = "otlp-grpc"
//
//   [otel.exporter.otlp-grpc]                   ← 端点写在嵌套子表里
//   endpoint = "http://host:4317"
//
//   [[hooks.SessionStart]]                      ← codex 真的有 SessionStart
//   matcher = "startup|resume"
//   [[hooks.SessionStart.hooks]]                ← 真正的 command 嵌一层
//   type = "command"
//   command = "..."
//
// 重跑 installer 时按【内容键控】清理我方写入：otel 走 stripCodexOtel（整个 [otel]
// 命名空间），hook 走 stripAiOtelCodexHooks（命令签名）。不再依赖 BEGIN/END
// 注释标记——codex 重写 config.toml 时会丢注释、抹掉 marker，标记块会被孤立成残留。
// 下面两个常量仅供 stripCodexManagedBlock 迁移老用户的旧 marker 块用，新写入不再产生。
const CODEX_MANAGED_BEGIN = "# >>> ai-otel-setup managed >>>";
const CODEX_MANAGED_END = "# <<< ai-otel-setup managed <<<";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCodexManagedBlock(text) {
  const re = new RegExp(
    `\\n?${escapeRegex(CODEX_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegex(CODEX_MANAGED_END)}\\n?`,
    "g"
  );
  return text.replace(re, "\n");
}

// F1：把 [hooks.state] 整段（含点号子表 [hooks.state."..."]）抽出、从正文移除并返回，
// 供 strip 之后原样放回（marker 外）。codex 把信任哈希序列化进 managed 块内时，
// stripCodexManagedBlock 会连它一起删 → hook 失信。[hooks.state] 是普通表，
// 边界 = 从 [hooks.state] 起，到下一个【非 hooks.state】顶层表（含 [[..]]）止。
function extractHooksState(text) {
  // 边界：下一个【非 hooks.state】顶层表 / 注释行（如紧跟其后的 managed END marker，绝不能吞进来，
  // 否则 stripCodexManagedBlock 找不到 END 就剥不掉旧块）/ EOF。
  const re = /(?:\n|^)\[hooks\.state\][\s\S]*?(?=\n\[(?!hooks\.state)|\n[ \t]*#|$)/;
  const m = text.match(re);
  if (!m) return { text, state: "" };
  return { text: text.replace(re, "\n"), state: m[0].trim() };
}

// F2：删除任意 ai-otel 的 Codex lifecycle hook（命令同时含 launch-hook.js +
// on-session-start.js）。覆盖 SessionStart / UserPromptSubmit / Stop，按命令签名
// 清理但保留用户自己的 hook；兼容 Codex 规范化 config.toml 后注释和位置变化。
function stripAiOtelCodexHooks(text) {
  const event = "(?:SessionStart|UserPromptSubmit|Stop)";
  const groupRe = new RegExp(
    `(?:\\n|^)\\[\\[hooks\\.${event}\\]\\][\\s\\S]*?` +
      `(?=\\n\\[\\[hooks\\.${event}\\]\\]|\\n\\[(?!\\[hooks\\.${event}\\.hooks\\]\\])|$)`,
    "g"
  );
  return text.replace(groupRe, (m) =>
    /launch-hook\.js/.test(m) && /on-session-start\.js/.test(m) ? "\n" : m
  );
}

function stripCodexOtel(text) {
  // 删除任意 [otel] 及其所有 [otel.*] 子表（不再只删带 enabled=true 的旧块）。
  // 我们每次都重写整个 otel 命名空间，先全清再写 → 永不出现重复 [otel]
  // （TOML 1.0 禁止同名表重复声明，重复会让 codex 启动直接解析失败——已有用户反馈）。
  // 逐个表头匹配 [otel] / [otel.xxx]，body 吃到下一个表头（行首 [）或 EOF。
  return text.replace(
    /(?:^|\n)\[otel(?:\.[^\]\n]*)?\][^\n]*(?:\n(?!\s*\[)[^\n]*)*/g,
    ""
  );
}

function stripLegacyCodexHook(text) {
  // 旧 installer 写的 [[hooks.UserPromptSubmit]] + id = "team:session-start" 整块删除
  return text.replace(
    /(?:\n|^)\[\[hooks\.UserPromptSubmit\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g,
    (m) => (/id\s*=\s*["']team:session-start["']/.test(m) ? "" : m)
  );
}

function stripLegacyCodexHooksFlag(text) {
  // Codex 把 [features].codex_hooks 重命名为 [features].hooks，旧 key 启动时触发 deprecation 警告
  // 删 = true 这行，由 ensureFeaturesHooksTrue 统一写 hooks = true；= false 是显式 opt-out，保留
  return text.replace(/^[ \t]*codex_hooks[ \t]*=[ \t]*true[ \t]*\r?\n/gm, "");
}

function ensureFeaturesHooksTrue(text) {
  // 在用户已有的 [features] 块原地插入 hooks = true（如缺失）；没有 [features] 就新建。
  // 不能写在 managed 块里——TOML 1.0 禁止同名 table 重复声明，会被严格解析器拒绝。
  const lines = text.split(/\r?\n/);
  let featuresIdx = -1;
  let hooksKeyExists = false;
  for (let i = 0; i < lines.length; i++) {
    if (featuresIdx === -1) {
      if (/^\s*\[features\]\s*$/.test(lines[i])) featuresIdx = i;
      continue;
    }
    if (/^\s*\[/.test(lines[i])) break; // 下一个 section，结束 [features] 主块扫描
    if (/^[ \t]*hooks[ \t]*=/.test(lines[i])) hooksKeyExists = true;
  }
  if (featuresIdx >= 0) {
    if (hooksKeyExists) return text; // 任何 hooks = ... 都尊重，不覆盖用户显式选择
    lines.splice(featuresIdx + 1, 0, "hooks = true");
    return lines.join("\n");
  }
  return text.trimEnd() + "\n\n[features]\nhooks = true\n";
}

function buildCodexOtelBlock(endpoint, otelTransport, gitUser) {
  // exporter / trace_exporter / metrics_exporter 是 externally-tagged enum：
  //   - 写 scalar `exporter = "otlp-grpc"`：codex 解析为 unit variant，因为
  //     OtlpGrpc 是 struct variant（带 endpoint 等字段），报
  //     "invalid type: unit variant, expected struct variant"。
  //   - 同时写 scalar 和 table：报 "cannot extend value of type string"。
  //   - 只写 table `[otel.exporter."otlp-grpc"]` / `[otel.exporter."otlp-http"]`：✓ codex 把它解析为
  //     OtlpGrpc { endpoint }，tag 来自 key 名。
  // 官方 sample 之所以能 `exporter = "none"`，是因为 None 本身就是 unit variant。
  const gitEmail = String((gitUser && gitUser.email) || "").trim().toLowerCase();
  const identityHeader = gitEmail
    ? [`headers = { "x-ai-otel-git-email" = ${JSON.stringify(gitEmail)} }`]
    : [];

  if (otelTransport !== "http") {
    return [
      '[otel.exporter."otlp-grpc"]',
      `endpoint = ${JSON.stringify(endpoint)}`,
      ...identityHeader,
      "",
      '[otel.trace_exporter."otlp-grpc"]',
      `endpoint = ${JSON.stringify(endpoint)}`,
      ...identityHeader,
      "",
      '[otel.metrics_exporter."otlp-grpc"]',
      `endpoint = ${JSON.stringify(endpoint)}`,
      ...identityHeader,
    ];
  }

  const logsEndpoint = logsEndpointFromGrpc(endpoint);
  return [
    '[otel.exporter."otlp-http"]',
    `endpoint = ${JSON.stringify(logsEndpoint)}`,
    'protocol = "binary"',
    ...identityHeader,
    "",
    '[otel.trace_exporter."otlp-http"]',
    `endpoint = ${JSON.stringify(tracesEndpointFromLogs(logsEndpoint))}`,
    'protocol = "binary"',
    ...identityHeader,
    "",
    '[otel.metrics_exporter."otlp-http"]',
    `endpoint = ${JSON.stringify(metricsEndpointFromLogs(logsEndpoint))}`,
    'protocol = "binary"',
    ...identityHeader,
  ];
}

function buildCodexOtelHookBlock(endpoint, hookDest, launcherDest, otelTransport, gitUser) {
  // 不再包裹 BEGIN/END 注释标记：codex 重写 config.toml 时会丢注释、把 marker 抹掉，
  // 标记本就靠不住。改为纯内容键控——重跑时按 otel 命名空间 + hook 命令签名识别并清理。
  // [features].hooks = true 由 ensureFeaturesHooksTrue 写到用户块里，避免重复声明 [features]
  return [
    "[otel]",
    'environment = "prod"',
    "log_user_prompt = false",
    "",
    ...buildCodexOtelBlock(endpoint, otelTransport, gitUser),
    "",
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(buildHookCommand(launcherDest, hookDest))}`,
    "timeout = 3",
    "",
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(buildHookCommand(launcherDest, hookDest))}`,
    "timeout = 3",
    "",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(buildHookCommand(launcherDest, hookDest))}`,
    "timeout = 3",
  ].join("\n");
}

function installCodex(home, endpoint, otelTransport, gitUser, snapshotConfig = {}) {
  const codexDir = path.join(home, ".codex");
  if (!fs.existsSync(codexDir)) {
    return { tool: "codex", status: "skipped", reason: "未检测到 ~/.codex" };
  }
  const installDir = path.join(codexDir, "ai-otel");
  const configPath = path.join(codexDir, "config.toml");
  const hookDest = path.join(installDir, "on-session-start.js");
  fs.mkdirSync(installDir, { recursive: true });
  removeSessionSeenMarkers(installDir);
  fs.copyFileSync(path.join(__dirname, "templates", "codex", "on-session-start.js"), hookDest);
  fs.chmodSync(hookDest, 0o755);
  const launcherDest = installLauncher(installDir);
  // local-usage-scanner.js：由 codex on-session-start.js spawn 的 detached 子进程，
  // 让 codex 用户(往往不开 Claude Code)每次开 codex 也能触发本地用量补报，不再只有装机那一次。
  const localUsageScannerDest = path.join(installDir, "local-usage-scanner.js");
  fs.copyFileSync(path.join(__dirname, "templates", "local-usage-scanner.js"), localUsageScannerDest);
  fs.chmodSync(localUsageScannerDest, 0o755);
  // Codex 与 Claude Code 复用同一个快照引擎。bundle 写入共享 rawBodiesDir，
  // 由现有单实例 uploader/timer 上传，避免每台机器安装两套竞争 timer。
  const gitSnapshotDest = path.join(installDir, "git-snapshot.js");
  fs.copyFileSync(path.join(__dirname, "templates", "git-snapshot.js"), gitSnapshotDest);
  fs.chmodSync(gitSnapshotDest, 0o755);
  const machineId = getOrCreateMachineId(installDir);
  writeInstallLog(installDir, "codex", endpoint, otelTransport);
  const bak = backup(configPath);
  let existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  // F1：先把 codex 的 [hooks.state]（信任库）抽出来保留，否则下面 stripCodexManagedBlock 会连它一起删 → hook 失信。
  const { text: withoutState, state: hooksState } = extractHooksState(existing);
  existing = withoutState;

  // 先剥离我们上次写的内容和旧 schema 残留，再保证用户块里有 hooks = true。
  // stripCodexManagedBlock 仍保留：迁移老用户残留的 BEGIN/END marker 块，无标记时是 no-op。
  existing = stripCodexManagedBlock(existing);
  existing = stripAiOtelCodexHooks(existing);        // F2：按命令签名删我方三类 lifecycle hook
  existing = stripCodexOtel(existing);               // 删整个 [otel] 命名空间，避免重复声明
  existing = stripLegacyCodexHook(existing);
  existing = stripLegacyCodexHooksFlag(existing);
  existing = ensureFeaturesHooksTrue(existing);

  // hook 同目录的 endpoint.json：hook 脚本运行时读它拿 logs endpoint，避免依赖
  // shell 前缀注入 env（cmd.exe 不认那种语法，跨平台必须改成走文件）。
  // machineId + localUsageUrl 是 local-usage-scanner.js 必需的两个字段（scanner 读 endpoint.json）。
  writeJSONAtomic(path.join(installDir, "endpoint.json"), {
    ...buildFullEndpointConfig(endpoint, otelTransport),
    // Codex hook 与 git-snapshot.js 自己发 OTLP/HTTP，不能沿用原生 exporter
    // 的 gRPC 端口；域名场景也必须去掉生产 gRPC 端口并落到 /v1/logs。
    logsEndpoint: logsEndpointFromGrpc(endpoint),
    machineId,
    localUsageUrl: deriveLocalUsageUrl(endpoint),
    installerVersion: PKG_VERSION,
    fullUpload: snapshotConfig.fullUpload === true,
    rawBodiesDir: snapshotConfig.rawBodiesDir || "",
    gitSnapshotMaxFiles: snapshotConfig.gitSnapshotMaxFiles || 20,
    gitSnapshotMaxBytes: snapshotConfig.gitSnapshotMaxBytes || 1 * 1024 * 1024,
    gitSnapshotPerFileBytes: snapshotConfig.gitSnapshotPerFileBytes || 256 * 1024,
  });
  const otelHook = buildCodexOtelHookBlock(endpoint, hookDest, launcherDest, otelTransport, gitUser);
  // F1：信任库放回末尾（我方写入块之外），下次 strip 不会再误删；命令未变 → trusted_hash 仍匹配 → hook 持续受信。
  let merged = existing.trimEnd() + "\n\n" + otelHook + "\n";
  if (hooksState) merged += "\n" + hooksState + "\n";
  merged = merged.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, merged, "utf8");
  return { tool: "codex", status: "installed", path: configPath, backup: bak };
}

function installGemini(home, endpoint, otelTransport) {
  const geminiDir = path.join(home, ".gemini");
  if (!fs.existsSync(geminiDir)) {
    return { tool: "gemini", status: "skipped", reason: "未检测到 ~/.gemini" };
  }
  const installDir = path.join(geminiDir, "ai-otel");
  const settingsPath = path.join(geminiDir, "settings.json");
  const hookDest = path.join(installDir, "on-session-start.js");
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "templates", "gemini", "on-session-start.js"), hookDest);
  fs.chmodSync(hookDest, 0o755);
  const launcherDest = installLauncher(installDir);
  writeInstallLog(installDir, "gemini", endpoint, otelTransport);
  // 同 Codex：endpoint.json 给 hook 脚本读，跨平台不依赖 env 前缀。
  writeJSONAtomic(path.join(installDir, "endpoint.json"), buildEndpointConfig(endpoint, otelTransport));
  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = { ...existing };
  // ⚠️ Gemini telemetry.target 只支持 "local" 与 "gcp"，没有 "otlp" 枚举值。
  //    指向自建 OTLP 接收端的标准用法是 target=local + otlpEndpoint=<url>。
  //    见调研：docs/superpowers/specs/2026-04-29-multi-cli-otel-research.md §2.2
  merged.telemetry = {
    ...(existing.telemetry || {}),
    enabled: true,
    target: "local",
    otlpEndpoint: endpoint,
    otlpProtocol: "grpc",
    useCollector: true,
    logPrompts: false,
  };
  merged.hooks = { ...(existing.hooks || {}) };
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const hookEntry = {
    id: HOOK_ID,
    command: buildHookCommand(launcherDest, hookDest),
  };
  const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
  if (idx >= 0) sessionStart[idx] = hookEntry;
  else sessionStart.push(hookEntry);
  merged.hooks.SessionStart = sessionStart;
  writeJSONAtomic(settingsPath, merged);
  return { tool: "gemini", status: "installed", path: settingsPath, backup: bak };
}

// ---------- 子命令分发 ----------

// `npx -y ai-otel-setup usage-backfill [...]`：调用已安装的本地用量 scanner
// （manual mode），透传给用户加的 --window=N / --dry-run / --force 等开关。
// 用户必须先正常装机（生成 endpoint.json 和 scanner 文件）才能用这个命令。
function runUsageBackfillCommand(extraArgs) {
  const installDir = path.join(os.homedir(), ".claude", "cc-otel");
  const scannerPath = path.join(installDir, "local-usage-scanner.js");
  const endpointPath = path.join(installDir, "endpoint.json");

  if (!fs.existsSync(scannerPath) || !fs.existsSync(endpointPath)) {
    console.error("[ai-otel-setup] 未检测到 " + installDir + "/，请先正常装机一次：");
    console.error("  npx -y ai-otel-setup url=团队上报地址");
    process.exit(1);
  }

  const scannerArgs = ["--manual"];
  for (const a of extraArgs) {
    if (a === "--help" || a === "-h") {
      console.log("Usage: npx -y ai-otel-setup usage-backfill [选项]");
      console.log("");
      console.log("从本地 jsonl 重新聚合最近的 token 用量并 POST 到团队上报。");
      console.log("默认走 7 天窗口、5 分钟节流、历史天 lock；用下面的开关可放宽。");
      console.log("");
      console.log("  --window=N         扫描近 N 天（默认 7，上限 30）");
      console.log("  --dry-run          算 buckets 不发送，只 print 统计");
      console.log("  --force            等于 --ignore-throttle --ignore-lock");
      console.log("  --ignore-throttle  跳过 5 分钟节流");
      console.log("  --ignore-lock      跳过历史天 lock，强制重扫");
      return;
    }
    if (a === "--dry-run" || a === "--ignore-throttle" || a === "--ignore-lock" || a === "--force") {
      scannerArgs.push(a);
    } else if (/^--window=\d+$/.test(a)) {
      scannerArgs.push(a);
    } else {
      console.error("[ai-otel-setup] usage-backfill: 未识别参数 " + JSON.stringify(a));
      console.error("  执行 `npx -y ai-otel-setup usage-backfill --help` 查看可用开关。");
      process.exit(2);
    }
  }

  const result = spawnSync(process.execPath, [scannerPath, ...scannerArgs], {
    stdio: "inherit",
  });
  process.exit(result.status === null ? 1 : result.status);
}

// ---------- 主流程 ----------

async function main() {
  // 子命令：positional `usage-backfill` 走独立分发，不进装机流程
  if (process.argv[2] === "usage-backfill") {
    return runUsageBackfillCommand(process.argv.slice(3));
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const errs = validateArgs(args);
  if (errs.length) {
    console.error("[ai-otel-setup] 参数错误：");
    for (const e of errs) console.error("  - " + e);
    console.error("");
    printUsage();
    process.exit(2);
  }

  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const installDir = path.join(claudeDir, "cc-otel");
  const settingsPath = path.join(claudeDir, "settings.json");
  const hookScriptDest = path.join(installDir, "on-session-start.js");
  const launcherDest = path.join(installDir, "launch-hook.js");

  const templateDir = path.join(__dirname, "templates");
  const settingsTemplate = readJSONSafe(path.join(templateDir, "settings.template.json"));
  const hookScriptSrc = path.join(templateDir, "on-session-start.js");

  if (!fs.existsSync(hookScriptSrc)) {
    console.error(`[ai-otel-setup] 找不到 hook 模板：${hookScriptSrc}`);
    process.exit(1);
  }

  // git user.email 是用户识别与装机上报的必需字段；缺失时不继续写入任何配置。
  const gitUser = readGlobalGitUser();
  if (!gitUser.email) {
    console.error("[ai-otel-setup] 安装失败：未检测到全局 git user.email。");
    process.exit(1);
  }

  const endpoint = resolveEndpoint(args.url);
  const otelTransport = resolveOtelTransport(args);
  const machineId = getOrCreateMachineId(installDir);
  const rawBodiesDir = path.join(installDir, "raw-bodies");
  const rawUploadToken = args["upload-token"] || args.uploadtoken || "";
  // 全量数据上报默认开启；需要临时关闭时显式传 --no-full-upload，并写盘给 auto-update 续传。
  const fullUploadOptOut = truthyFlag(args["no-full-upload"]);
  const fullUpload = !fullUploadOptOut;
  const explicitRawUploadUrl = normalizeOptionalUrl(args["upload-url"] || args.uploadurl);
  // rawUploadUrl 唯一来源：fullUpload；显式 --upload-url 仍可强制覆盖。
  // opt-out 用户不需要这个 URL，scanner/raw-body-uploader 都不会跑。
  const rawUploadUrl = explicitRawUploadUrl || (fullUpload ? rawUploadUrlFromEndpoint(endpoint) : "");
  // raw-bodies 目录只在 fullUpload 时建（CC 才会写盘 raw API body）；
  // opt-out 用户曾经开过 fullUpload 的话，目录里残留文件保留，由用户手动清。
  if (fullUpload) {
    fs.mkdirSync(rawBodiesDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(rawBodiesDir, 0o700); } catch (_) {}
  }
  const newEnv = buildEnv(settingsTemplate, args, endpoint, otelTransport, rawBodiesDir, fullUpload);

  const hookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(launcherDest, hookScriptDest),
        timeout: 3,
      },
    ],
    description:
      "ai-otel-setup 注入：补采项目/git/hostname 维度，POST 到 OTLP/HTTP 4318",
    id: HOOK_ID,
  };

  // UserPromptSubmit 兜底 hook：复用同一脚本，由 stdin.hook_event_name 在脚本内部
  // 分流。客户端做 2 分钟节流，服务端见 entry 已存在则仅补空。用于救 SessionStart
  // 因网络/超时丢失的场景（线上观测约 60% 事件因此空 git/hostname）。
  const promptHookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(launcherDest, hookScriptDest),
        timeout: 3,
      },
    ],
    description:
      "ai-otel-setup 注入：UserPromptSubmit 兜底，救 SessionStart 漏发场景",
    id: PROMPT_HOOK_ID,
  };

  // Stop hook：复用 on-session-start.js（按 hook_event_name=Stop 在脚本内分流）。
  // 仅在 fullUpload 时实际触发 git snapshot；非全量场景脚本会立即 noop 退出。
  const stopHookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(launcherDest, hookScriptDest),
        timeout: 3,
      },
    ],
    description:
      "ai-otel-setup 注入：Stop 触发 git snapshot（仅全量上报时启用）",
    id: STOP_HOOK_ID,
  };

  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(hookScriptSrc, hookScriptDest);
  fs.chmodSync(hookScriptDest, 0o755);
  installLauncher(installDir);
  // git-snapshot.js：on-session-start.js spawn 出来的 detached 子进程脚本
  const gitSnapshotDest = path.join(installDir, "git-snapshot.js");
  fs.copyFileSync(path.join(templateDir, "git-snapshot.js"), gitSnapshotDest);
  fs.chmodSync(gitSnapshotDest, 0o755);
  // local-usage-scanner.js：同样由 on-session-start.js spawn 出来的 detached 子进程
  const localUsageScannerDest = path.join(installDir, "local-usage-scanner.js");
  fs.copyFileSync(path.join(templateDir, "local-usage-scanner.js"), localUsageScannerDest);
  fs.chmodSync(localUsageScannerDest, 0o755);
  // installRawUploader 同时管 raw-body-uploader.js 脚本 + raw-upload-token 文件：
  //   - fullUpload=true：写 token（如果用户传了 --upload-token）
  //   - fullUpload=false：传空 token 让它把残留 token 删干净
  installRawUploader(installDir, fullUpload ? rawUploadToken : "");
  // Timer 生命周期：先无脑 uninstall 一次（幂等，对没装过的也是 no-op），
  // 再按 fullUpload 决定要不要 install。这样 true → false 重装能自动卸 timer。
  uninstallRawUploaderTimer();
  const rawUploaderTimer = fullUpload ? installRawUploaderTimer(installDir) : { status: "skipped" };
  writeInstallLog(installDir, "claude", endpoint, otelTransport);

  // v1.0.3：把 endpoint 写盘，给 hook 脚本的 resolveLogsEndpoint 当兜底。
  // 修的是 v1.0.2 的真实事故：settings.json 的 env 不一定能继承到 hook 子进程
  // （Windows / 已运行的 CC 实例都会踩到），导致 hook fallback 到 localhost
  // 拿 ECONNREFUSED 静默失败、marker 已写但 POST 永不到达。
  writeJSONAtomic(
    path.join(installDir, "endpoint.json"),
    buildFullEndpointConfig(endpoint, otelTransport, {
      machineId,
      rawBodiesDir,
      rawUploadUrl,
      rawUploadChunkBytes: 4 * 1024 * 1024,
      rawUploadMultipart: true,
      rawBodiesSoftLimitBytes: 2 * 1024 * 1024 * 1024,
      rawBodiesHardLimitBytes: 5 * 1024 * 1024 * 1024,
      rawBodiesTargetLimitBytes: 2 * 1024 * 1024 * 1024,
      rawBodiesMinFreeBytes: 2 * 1024 * 1024 * 1024,
      hasUploadToken: !!rawUploadToken,
      fullUpload,
      fullUploadOptOut,
      gitUserEmail: gitUser.email,
      // git-snapshot.js 读这三个字段做三轴截断；默认值在 snapshot 脚本内兜底
      gitSnapshotMaxFiles: 20,
      gitSnapshotMaxBytes: 1 * 1024 * 1024,
      gitSnapshotPerFileBytes: 256 * 1024,
      // local-usage-scanner.js 读这个 URL 上报本地用量；从主 endpoint 独立派生
      // （与 rawUploadUrl 同 hostname，不受 fullUpload / upload-token 门控）
      localUsageUrl: deriveLocalUsageUrl(endpoint),
    })
  );

  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = mergeSettings(
    existing,
    newEnv,
    hookEntry,
    promptHookEntry,
    stopHookEntry,
    buildNoProxyEntries(endpoint, otelTransport),
    gitUser,
    machineId,
    fullUpload
  );
  writeJSONAtomic(settingsPath, merged);

  const results = [];
  try {
    results.push(installCodex(home, endpoint, otelTransport, gitUser, {
      fullUpload,
      rawBodiesDir,
      gitSnapshotMaxFiles: 20,
      gitSnapshotMaxBytes: 1 * 1024 * 1024,
      gitSnapshotPerFileBytes: 256 * 1024,
    }));
  } catch (e) {
    results.push({ tool: "codex", status: "failed", reason: e.message });
  }
  try {
    results.push(installGemini(home, endpoint, otelTransport));
  } catch (e) {
    results.push({ tool: "gemini", status: "failed", reason: e.message });
  }

  const debug = !!args.debug || process.argv.includes("--debug") || process.argv.includes("-d");
  const allResults = [{ tool: "claude", status: "installed" }, ...results];

  console.log("[ai-otel-setup] 安装完成。");
  console.log("");
  console.log(`  ${"version".padEnd(12)}: ${PKG_VERSION}`);
  console.log(`  ${"endpoint".padEnd(12)}: ${displayEndpoint(endpoint)}`);
  console.log(`  ${"transport".padEnd(12)}: ${otelTransport === "http" ? "http/protobuf" : "grpc"}`);
  console.log(`  ${"git email".padEnd(12)}: ${gitUser.email}`);
  for (const r of allResults) {
    console.log(`  ${r.tool.padEnd(12)}: ${r.status}${r.reason ? " (" + r.reason + ")" : ""}`);
  }
  if (debug) {
    console.log(`  ${"raw bodies".padEnd(12)}: ${rawBodiesDir}`);
    console.log(`  ${"raw upload".padEnd(12)}: ${rawUploadUrl ? "enabled" : "disabled"}`);
    if (rawUploadUrl) {
      const timerDetail = rawUploaderTimer.path ? ` (${rawUploaderTimer.path})` : rawUploaderTimer.reason ? ` (${rawUploaderTimer.reason})` : "";
      console.log(`  ${"raw timer".padEnd(12)}: ${rawUploaderTimer.status}${timerDetail}`);
    }
    if (fullUpload) console.log(`  ${"mode".padEnd(12)}: full upload`);
    else console.log(`  ${"mode".padEnd(12)}: full upload disabled`);
    console.log(`  ${"usage url".padEnd(12)}: ${deriveLocalUsageUrl(endpoint) || "(empty)"}`);
    console.log(`  ${"hook script".padEnd(12)}: ${hookScriptDest}`);
    console.log(`  ${"settings".padEnd(12)}: ${settingsPath}`);
    if (bak) console.log(`  ${"backup".padEnd(12)}: ${bak}`);
  }
  console.log("");
  console.log("接下来：直接运行 `claude` / `codex` / `gemini`，下次会话启动即自动上报。");

  // 装完立刻在后台 spawn 一次本地用量补报（detached + stdio:ignore + windowsHide），
  // 让用户当天就能在看板看到数据，不必等首次 SessionStart。--ignore-throttle/lock
  // 避免被刚装机时的旧 marker 卡住；走默认 7 天窗口，重度回补让用户自己跑
  // `npx -y ai-otel-setup usage-backfill --window=30 --force`。
  try {
    const scannerPath = path.join(installDir, "local-usage-scanner.js");
    if (fs.existsSync(scannerPath)) {
      const child = spawn(process.execPath, [scannerPath, "--ignore-throttle", "--ignore-lock"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      console.log("已在后台触发首次本地用量补报，扫近 7 天 jsonl；日志见 ~/.claude/cc-otel/ai-otel.log。");
    }
  } catch (_) {
    // 补报失败不阻塞装机；用户后续可手动 `npx -y ai-otel-setup usage-backfill`
  }

  if (debug) {
    console.log(
      "卸载：删除 " +
        installDir +
        " 与 " +
        path.join(claudeDir, "cc-otel-state") +
        "（marker 目录），并从 settings.json 移除 12 个 OTEL_* env、" +
        "SessionStart 中 id=" + HOOK_ID + "、UserPromptSubmit 中 id=" + PROMPT_HOOK_ID +
        "、Stop 中 id=" + STOP_HOOK_ID + " 的条目。"
    );
  }

  // 装机上报：fire-and-forget 语义，3s 内完成或放弃；任何错误都不冒泡
  await reportInstall(endpoint, gitUser, allResults, debug, fullUpload);
}

function printUsage() {
  console.log(`Usage:
  npx -y ai-otel-setup url=COLLECTOR_HOST

参数（必填）：
  url    Collector host（裸 IP 自动补 http://...:4317；裸域名自动补 https://...:24317；也可传完整 URL）

可选：
  --http | http=1    Claude Code 原生 OTel 使用 OTLP/HTTP（默认）
  --grpc | grpc=1    Claude Code 原生 OTel 强制使用 gRPC（fallback）
  --no-full-upload   关闭全量数据上报旁路（raw body + git snapshot）
  upload-url=URL     raw body 上传入口，例如 https://host/v1/raw-bodies；不传会按 url 自动推导 raw-upload 域名
  upload-token=TOKEN raw body 上传 Bearer token（可选；仅服务端开启鉴权时需要，传入时写入本地 0600 token 文件）
  debug=1 | --debug   显示安装路径、备份路径与卸载提示
`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ai-otel-setup] 失败：" + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports.__test__ = {
  buildCodexOtelBlock,
  buildCodexOtelHookBlock,
  stripAiOtelCodexHooks,
  installCodex,
};
