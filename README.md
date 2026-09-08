# AI CLI 上报工具

一键开通团队的 Claude Code / Codex CLI / Gemini CLI 使用数据上报。

`ai-otel-setup` 是一个本机安装器，用于写入 AI CLI 的 OpenTelemetry 上报配置和 hooks。Collector、Forward 服务和数据看板由团队另行部署，不包含在本仓库内。

```text
Claude Code / Codex CLI / Gemini CLI
  -> ai-otel-setup 写入的 OTel 配置和 hooks
  -> 团队提供的上报端点
  -> Collector / Forward（团队另行部署）
  -> 数据看板（团队另行部署）
```

## 配套看板示例

采集到的数据可接入团队的数据看板，用于查看 Token 用量、API 费用、代码变动、活跃会话和工作区投入等指标。

下图为脱敏后的示例效果：

![AI 助手观测平台看板示例](docs/assets/dashboard-demo.png)

## 安装

```bash
npx -y ai-otel-setup url=collector服务地址
```

> 国内网络慢可以临时切到淘宝镜像：`npm config set registry https://registry.npmmirror.com`，再执行安装命令。

把 `collector服务地址` 替换成团队提供的实际地址，例如：url=collector.example.com。具体地址请向团队负责人索取。

装好后直接运行 `claude` / `codex` / `gemini`，上报会自动开始，无需额外配置。

| 参数 | 说明 |
|---|---|
| `url`（必填） | 服务器地址。可填 IP / 域名，或完整地址。裸 IP 会按本地测试规则生成 `http://IP:4317`；裸域名会按生产规则生成 `https://域名:24317`。不能包含空格或逗号。 |
| `--http` / `http=1` | Claude Code 原生 OTel 使用 OTLP/HTTP。默认使用此模式，logs 指向 `/v1/logs`，metrics 指向 `/v1/metrics`。 |
| `--grpc` / `grpc=1` | 强制 Claude Code 原生 OTel 使用 gRPC，作为 HTTP 上报异常时的 fallback。 |
| `--no-full-upload` | 关闭全量数据上报旁路（raw body + git snapshot）。默认已开启全量上报。 |

## 安装后会做什么

- 在 `~/.claude/cc-otel/`、`~/.codex/ai-otel/` 放置启动与采集脚本
- 备份你原来的 `~/.claude/settings.json`（带时间戳，可随时还原）
- 备份 Codex 的 `~/.codex/config.toml`，写入 `SessionStart`、`UserPromptSubmit`、`Stop` hooks
- 把上报相关配置写进 Claude Code、Codex 和 Gemini 的用户配置

你原本的其他设置都会保留；重复运行不会产生重复条目，可以放心重装。

## 采集了哪些数据

| 类型 | 内容 |
|---|---|
| 会采集 | 调用了哪些工具、每次耗时、是否成功、Token 用量、当前目录、Git 信息 |
| 仅全量上报旁路采集 | Claude Code raw body，以及 Claude Code / Codex 工作区 git snapshot，用于完整排查和全量数据看板 |

Codex 工作区快照使用隐藏 Git ref 和临时 index，不修改当前 branch、HEAD 或用户的 staged 状态。快照 bundle 与 Claude Code 共用 `~/.claude/cc-otel/raw-bodies/` 上传队列；使用 `--no-full-upload` 会同时关闭两种工具的快照采集。

## 本地用量补报

补全 Claude Code 原生 OTel 偶尔漏报的 token 数据。装完会立即在后台跑一次首发补报。

手动立刻触发一次补报：

```bash
npx -y ai-otel-setup usage-backfill
```

完整说明（参数表、输出怎么读、排查）见 [docs/usage-backfill.md](docs/usage-backfill.md)。

## 本地日志

安装后会在本机写入排查日志，只保留最近 3 天数据：

| 工具 | 日志路径 |
|---|---|
| Claude Code | `~/.claude/cc-otel/ai-otel.log` |
| Codex CLI | `~/.codex/ai-otel/ai-otel.log` |
| Gemini CLI | `~/.gemini/ai-otel/ai-otel.log` |

## AStudio 支持

如果本机存在 `~/.acode/`，安装器会额外配置 AStudio：

- 在 `~/.acode/ai-otel/` 安装 AStudio transcript Hook；
- 在 `~/.acode/hooks.json` 注册 `UserPromptSubmit` 和 `Stop` Hook；
- 读取 `~/.acode/sessions/**/rollout-*.jsonl` 中当前 turn 的用户消息、模型回复、工具调用/结果和 token 用量；
- 通过 OTLP/HTTP Logs `/v1/logs` 发送到 Collector 全量旁路，数据标记为 `tool_kind=acode`、`data_source=acode_transcript_hook`；
- 在 Prompt/Stop 生命周期生成 `snapshot-acode-*.snapshot.bundle`，复用现有 raw-body uploader；
- 服务端分别归档到 OSS `acode_records` 与 `acode_snapshot_files`，未来如接入 provider raw body 则进入 `acode_body_files`；
- Hook 只负责排队并立即返回，transcript 解析和网络发送在 detached worker 中完成。

AStudio 使用与 Codex transcript 兼容的 JSONL 格式，但配置目录不同，因此不会复用或修改 `~/.codex/config.toml`。AStudio transcript 与快照受 `--no-full-upload` 统一门控；AStudio 的原始 Provider HTTP 请求体不在本功能范围内。

## 卸载

还原安装前的备份即可：

```bash
ls ~/.claude/settings.json.bak.* | tail -1 | xargs -I{} cp {} ~/.claude/settings.json
rm -rf ~/.claude/cc-otel
```

系统级 raw body 上传 timer 也要清掉：

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.ai-otel.raw-uploader.plist
rm -f ~/Library/LaunchAgents/com.ai-otel.raw-uploader.plist

# Linux (systemd 用户态)
systemctl --user disable --now ai-otel-raw-uploader.timer
rm -f ~/.config/systemd/user/ai-otel-raw-uploader.{service,timer}

# Windows
schtasks /Delete /F /TN ai-otel-raw-uploader
```

> 提示：不想卸载、只想关掉 raw body 上报？直接重跑安装命令并加 `--no-full-upload`，
> installer 会自动 uninstall timer + 把 settings.json 里的隐私 env（USER_PROMPTS / TOOL_CONTENT / RAW_API_BODIES）改回 0/删除。`~/.claude/cc-otel/raw-bodies/` 目录里
> 残留的 body 文件不会被自动清理，可以放心手动删。

## 排查

| 现象 | 怎么办 |
|---|---|
| 启动 `claude` 没看到上报动作 | 打开 `~/.claude/settings.json`，确认里面有一项 `id: team:session-start` |
| Codex 没有工作区快照 | 在 Codex 中运行 `/hooks`，确认 `SessionStart`、`UserPromptSubmit`、`Stop` 三类 ai-otel hooks 已审阅并信任 |
| 服务器一直收不到数据 | 用团队提供的地址和端口做连通性检查；IP 测试地址通常检查 `4317`，生产域名通常检查团队提供的 gRPC 端口 |
| 想换服务器地址 | 直接重跑安装命令即可，会自动覆盖旧配置 |

详细排查见 [docs/troubleshooting.md](docs/troubleshooting.md)。
