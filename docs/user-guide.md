# agybridge 使用说明

`agybridge` 让同一台电脑上的 **Antigravity CLI (`agy`)** 和 **Codex CLI (`codex`)** 互相发消息，像两个平等的同事一样异步协作。两边仍然是各自的官方 CLI，保留各自独立的登录、模型服务、上下文与权限边界。

`agybridge` 只在本机传递消息与核验运行状态，不调用第三方模型，不会替你批准宿主敏感操作，也不会把一方降级为另一方的子代理。

## 一分钟了解

**常见用法（AGY 主窗口 ↔ Codex 后台/前台）：** 在项目目录里打开 `agy` TUI，照常交代任务或明确要求与 Codex 分工（例如“把后端实现和单测交给 Codex，你负责整体架构和前端”）。如果同目录没有已打开的 Codex 窗口，`agybridge` 会自动在后台启动一个专用 Codex App Server 搭档；AGY 通过 `codex.send_message` 发信并调用 `codex.wait_partner` 在后台挂起监听，Codex 完成后通过 `agy.send_message` 回信，**空闲中的 AGY 前台窗口会被自动唤醒并收到完整回复**。

**双向对等协作（Codex 窗口 ↔ AGY 后台/前台）：** 从 Codex 窗口发起协作时，若同目录没有未配对的 AGY 窗口，`agybridge` 可通过 **`agy acp --stdio`** 在后台拉起并托管 AGY 会话，支持 `session/resume` 断线续接、动态切换模型与推理强度（`thought_level`）、ACP 执行模式（`default` / `accept-edits` / `plan`）与细粒度权限对齐（非 `bypass` 源会话绝不静默跳过审批，遇到权限请求时自动转为 `needsHuman` 等待 `agybridge open agy` 前台接管），同时兼容 Antigravity CLI（`~/.gemini/antigravity-cli`）与 Antigravity 2.0 IDE（`~/.gemini/antigravity`）双路径会话历史及本地 `ConversationService` 配对标签自动同步（`agybridge:paired`）。

| 组成部分 | 作用 |
|---|---|
| AGY 插件 (`plugins/agy`) | 通过 `agy plugin install` 安装到 `~/.gemini/config/plugins/agybridge/`，提供 `codex` MCP 服务（含 `wait_partner` 后台常驻唤醒）、生命周期 hooks（`SessionStart`、`PreInvocation` 快捷指令拦截、`PreToolUse` 自动放行 `mcp_agybridge_codex_*` 与 `invoke_subagent` `nxref:` 展开、`PostToolUse`、`Stop` 兜底唤醒）、`rules/AGENTS.md` 与 `partner` 技能 |
| Codex 插件 (`plugins/codex`) | 通过 `agybridge-local` 本地市场安装到 Codex，提供 `agy.*` MCP 工具、兼容 hooks 与 `partner` 技能 |
| 本机协调器 | 独立私有目录 `~/.agybridge`（可用 `AGYBRIDGE_HOME` 指定）与 SQLite 持久账本 `agybridge.db`，负责可靠投递、自动唤醒、断线恢复与运行健康监测 |
| `agybridge` 命令 | 安装更新、配对管理、前台接管、搭档模型配置、消息观察与诊断 |

## 环境要求

- **Node.js 24～26**（需要内置 `node:sqlite`，运行 `node -v` 确认）
- **Antigravity CLI (`agy`)**：已登录（推荐 `1.5.14+`）
- **Codex CLI (`codex`)**：已登录，版本至少 `0.164.0`

## 安装、更新与卸载

### 从发行版压缩包安装

解压下载的 `agybridge-<版本>.zip`，在解压后的 `agybridge-<版本>` 目录中执行：

```sh
node agybridge.mjs setup --dry-run   # 预演检查，不写入任何文件
node agybridge.mjs setup             # 正式安装
```

### 从源码目录安装

```sh
npm ci
npm run build:publish
node publish/agybridge.mjs setup
```

安装过程会将独立运行时复制到 `~/.agybridge/runtime/`，为两端官方 CLI 安装插件，并在当前用户可写的 `PATH` 目录（如 `~/.local/bin`）放置 `agybridge` 命令。安装完成后，解压的临时目录可以删除。

### 让插件生效并自检

1. **AGY**：新开 `agy` 窗口，或恢复已有会话（`agy --conversation <会话ID>`）加载 `agybridge` 插件。
2. **Codex**：新开一个会话，在 `/hooks` 中信任 `agybridge` 的 hooks（后台专用 App Server 主路径通过原生接口收信，embedded / 共用 daemon 兼容路径需信任 hooks）。
3. **检查状态**：运行 `agybridge doctor` 核对两端 CLI、插件、MCP 与本地 IPC 状态。

### 更新与卸载

```sh
agybridge update --from <新版本目录>   # 升级到新版本（源码构建后可直接运行 node publish/agybridge.mjs update）
agybridge setup --prepare-only         # 仅在私有目录生成插件文件，不改动 CLI 配置
agybridge uninstall --dry-run          # 预览卸载操作
agybridge uninstall                    # 卸载插件与命令（加 --purge 同时清理私有运行目录）
```

## 常用命令

```sh
agybridge status                                             # 查看所有配对、成员状态与投递计数
agybridge pair                                               # 查看未配对窗口与可接回的历史后台搭档
agybridge pair --agy <ID> --codex <ID> [--replace]           # 手动指定两端配对
agybridge pair --restore <原配对ID>                          # 接回已结束的原配对与原会话
agybridge open codex                                         # 在前台临时接管后台 Codex 会话
agybridge open agy [--interrupt]                             # 暂停后台 AGY ACP 并在前台 agy --conversation 接管
agybridge adopt codex [--session <ID>]                       # 将前台关闭后的 Codex 会话转交后台托管
agybridge release codex                                      # 将后台 Codex 会话交还用户窗口
agybridge partner-profile codex|agy [--model <M>] [--effort <E>] [--reset]  # 查看或修改后台搭档模型与推理强度
agybridge pause / resume / unpair                            # 暂停、恢复或解除当前配对
agybridge restart codex                                      # 空闲时平滑冷重启后台 Codex 运行时
agybridge recover codex --dry-run / --turn <turn ID>         # 查看或显式恢复卡住/失败的后台 Codex 轮次
agybridge watch [--once] [--json]                            # 实时查看双方消息流与问答状态
agybridge config list / get / set / unset                    # 查看或修改 ~/.agybridge 配置项
agybridge doctor [--current]                                 # 诊断全局安装或当前窗口配对状态
```

### 窗口内快捷指令

在 AGY 或 Codex 对话输入框中可直接输入以下指令：

- `agybridge status` — 查看当前窗口的配对与搭档状态
- `agybridge on [self|agy|codex]` / `agybridge off [self|agy|codex]` — 开启或关闭本窗口/搭档的 `agybridge` 协作
- `agybridge pair` / `agybridge pair <4位配对码>` — 打开原生搭档选择，或使用 4 位配对码完成配对
- `agybridge pickup`（或 `agybridge 收信`）— 手动触发收取待处理消息
- `agybridge config pending` / `agybridge config confirm <确认码>` — 查看或确认模型提交的敏感配置变更提案

## 隐私、可靠性与安全边界

- **本地隔离存储**：所有状态、SQLite 账本与本地连接文件保存在当前用户私有的 `~/.agybridge`（`0700` 权限，可通过 `AGYBRIDGE_HOME` 覆盖），与原项目 `~/.nxbridge` 完全隔离，互不干扰。
- **落盘与认证保护**：关键状态与配置文件经 `fsync` 落盘后再原子替换；本地协调器 IPC 使用 64 位十六进制随机令牌认证，损坏时拒绝连接并可通过 `agybridge update` 安全修复。
- **不越权、不盲重发**：协调器绝不代用户批准宿主权限或敏感配置；投递结果不明（`unknown`）的消息如实标记，绝不自动重放。
