# agybridge 行为说明

面向开发与维护者：说明 `agybridge` 各模块的真实运行机制、协议边界与安全约束。仓库概览见 [README.md](../README.md)，日常安装与命令速查见 [user-guide.md](user-guide.md)。

## 1. 宿主兼容与通信机制

### Antigravity CLI (`agy`) 接入机制

`agybridge` 同时支持 **AGY 前台 TUI** 与 **后台 `agy acp` 托管会话**两种形态：

- **AGY 前台窗口（`mode: "agy-tui"`）**：
  - 通过 `agy plugin install` 安装 `plugins/agy` 插件，向 AGY 注入 `codex` MCP 服务（工具名形如 `mcp_agybridge_codex_*`）、常驻规则 `rules/AGENTS.md`、`partner` 技能及生命周期 hooks（`SessionStart`、`PreInvocation`、`PreToolUse`、`PostToolUse`、`Stop`）。
  - **主唤醒路径（`wait_partner`）**：`mcp_config.json` 将 `wait_partner` 配置为 `eager: true` + `background: "always"` + `timeoutSeconds: -1`。AGY 发出期待回复的 `send_message(..., reply_expected: true)` 后调用 `wait_partner` 立即转入后台挂起并结束当前轮次；当 Codex 发来消息、提出问题或产生需唤醒的运行通知时，协调器立即结算该挂起请求，将消息正文直接唤醒并注入空闲的 AGY 前台窗口。
  - **兜底唤醒与防循环**：若 AGY 未挂起 `wait_partner` 而消息已在收件箱待处理，`Stop` hook（在 `continuationActive !== true` 时）返回 `{"decision": "continue", "reason": ...}` 提示调用 `receive_messages` 取件；`PreInvocation` 在 `wait_partner` 刚唤醒后的短窗口内自动抑制重复控制指令触发。
  - **工具放行与引用展开**：`PreToolUse` hook 对 `mcp_agybridge_codex_*` 与普通 `invoke_subagent` 返回 `{"decision": "allow"}`；当 `invoke_subagent` 的 `Prompt` 含有未加引号/反引号的裸 `nxref:msg:<id>` 或 `nxref:agent:<id>` 时，经 `overwrite` 展开后再放行，引用无效则以 `{"decision": "deny"}` 拦截并说明原因。

- **后台托管 AGY 会话（`mode: "agy-acp"`）**：
  - 当从 Codex 发起协作且没有现成配对时，协调器通过 `agy acp --stdio` 启动独立后台 AGY 进程，经 JSON-RPC over stdio 完成 `initialize` 与 `session/new`（断线恢复走 `session/resume` / `session/load`），并在会话级注入 `codex` MCP 服务与后台协作提示。
  - 协调器直接通过 ACP `session/prompt` 投递 `<partner-message>`，无需 `wait_partner`；收到 `session/update` 时实时同步工具等待状态、模型/推理强度（`model` / `thought_level`）和 token 用量。
  - **前台接管（`agybridge open agy`）**：先安全关闭当前后台 ACP 进程（运行中轮次需显式加 `--interrupt` 中断），再在用户交互终端以 `agy --conversation <会话ID>`（保留原模型与推理强度）打开同一会话；退出前台后可自动交还后台继续托管。

### Codex CLI 接入与版本兼容

Codex 最低要求 `0.164.0`；更旧或无法核验的版本在 `setup` / `update` 预检阶段直接拒绝。已在隔离协议测试中验证 `0.164.0`、`0.166.0`、`0.171.0`、`0.172.0` 等版本。

按 Codex 运行形态，消息投递分为三类：

1. **agybridge 托管的专用后台 Codex（`--no-daemon app-server`）**：
   - 空闲时，协调器通过 `thread/inject_items` 注入成对的 `agy.receive_messages` 调用与结果（带唯一 `call_id`），再以空 `input` 调用 `turn/start` 续跑；忙碌时由 Codex 在 hook 提示下主动调用 `agy.receive_messages` 取件。
   - Linux / WSL 与 Windows 在官方二进制支持 `--ws-auth` 与 `--ws-token-file` 时，优先使用带本地随机令牌认证的回环 WebSocket；macOS 默认使用私有 Unix socket 并严格核验符号链接目标与监听进程代次。
   - 连接握手先以只读 `codex-backend` 获取实际服务端版本，再以一致版本的 `codex-tui` 身份建立工作连接，确保模型请求的原生 originator 与 User-Agent 与官方 TUI 完全一致。
2. **共用后台服务（Codex daemon）**：
   - 协调器只读扫描共用 daemon，绝不停止、重启或修改用户 daemon。
   - 仅当用户在搭档选择或配对码中明确选中该会话、原生线程处于 `idle` 且窗口绑定未变化时，才按严格复核直接唤醒；否则保留消息等待线程自行取件或在输入框执行 `agybridge pickup`。
3. **非本机或 embedded 兼容窗口**：
   - 无法直接挂接持久历史的会话保留在收件箱，通过已信任的 hooks 提示调用 `agy.receive_messages` 取件。

送达证据准则：

- 仅当官方 `thread.path` 持久历史或协议回执确认匹配的 `call_id` / `message_id` 进入上下文时，消息状态才推进为 `contextObserved`（收到关联 `in_reply_to` 回复后推进为 `responded`）。
- 提交中途断连、无法确认对端是否收到时记为 `unknown`，**绝不自动重发**。

## 2. 配对、换绑与会话转移

- **多组 1:1 并发配对**：同一台机器可同时维护多组独立的 `AGY ↔ Codex` 配对（不同项目目录或不同窗口）。
- **首次配对不静默抢占窗口**：同项目目录中若已存在未配对的对端窗口或可恢复的历史后台搭档，首次发信返回 `selection_required`，由用户明确选择“现有窗口 / 接回历史后台搭档 / 新建后台搭档 / 暂不配对”；仅在没有任何候选且 `collaboration.implicit = "on-demand"` 时，才按需自动新建后台搭档。
- **接回历史后台搭档**：解除配对或换绑后，只要原后台会话的本地历史文件仍可核验存在且未被占用，就可通过搭档选择或 `agybridge pair --restore <原配对ID>` 接回原会话与上下文。
- **Codex 会话在窗口与后台间转移**：
  - `agybridge adopt codex`：将用户关闭窗口后的原 Codex 会话转由后台专用 App Server 接着运行（保留会话 ID、配对与沙箱/审批类别）。
  - `agybridge open codex`：在交互终端临时以前台 TUI 接入后台 Codex（例如处理原生审批），退出后自动归还后台。
  - `agybridge release codex`：停止后台托管进程并将会话长期交还用户自行打开。
- **shell wrapper（可选）**：基础 `setup` 不修改任何 shell profile；如需直接敲 `codex resume <ID>` 时自动识别已在后台托管的会话，可显式运行 `agybridge install-wrapper --file <profile> [--shell powershell|bash|zsh]`，随时可通过 `agybridge remove-wrapper` 或 `uninstall` 无损移除。

## 3. 后台搭档模型与权限边界

### 模型与推理强度（`partner-profile`）

新建后台搭档时的优先级从高到低为：

1. 创建时显式指定（如 `select_partner` 传入 `model` / `effort`）；
2. 配置文件中的 `partners.<codex|agy>.model` 与 `partners.<codex|agy>.effort`；
3. `partners.<codex|agy>.profile_source = "frozen"` 时冻结的首个观测值；
4. 宿主 CLI 自身的默认设置（默认行为 `profile_source = "host"`）。

运行中可通过命令行 `agybridge partner-profile codex|agy --model <M> --effort <E>` 或 MCP 工具 `partner_profile` 在搭档空闲时无损切换；只允许修改 `agybridge` 自有后台搭档，用户自己打开的窗口一律拒绝代改。

### 启动权限准则

- **后台 Codex**：根据配对端权限类别选择启动参数（bypass 类对应 `danger-full-access` + `never`；prompting 类优先 `on-request` + `approvalsReviewer: auto_review`），只通过进程启动参数传递，永不改写用户的 `~/.codex/config.toml`。
- **后台 AGY ACP**：通过 `--stdio` 与会话级参数启动，隔离配置目录通过 `--gemini-dir` 传入；ACP `session/request_permission` 按当前后台会话授权策略响应。

## 4. 运行健康监测、恢复与按成员开关

- **轮次健康与在途工具核验**：协调器持续跟踪双端轮次状态，并结合 Codex 原生 rollout 尾部核查仍在执行的函数/内置工具调用（含 `sleep`、`function_call`、`custom_tool_call`），确认处于工具等待（`waitingTool`）时不误报停滞；若轮次无进展超过阈值或遇到供应商重试（`networkRetrying`）/ 阻断，如实生成只读 `runtime monitor` 事实通知，绝不擅自杀死进程或重发任务。
- **显式轮次恢复（`recover codex`）与冷重启（`restart codex`）**：
  - `agybridge recover codex --dry-run` / `--turn <turn ID>`：由用户在外部交互终端确认后中断卡住的后台轮次或让失败停下的轮次检查进度后继续。
  - `agybridge restart codex`：在后台 Codex 空闲且无在途投递时，按原会话 ID 平滑重启专用 App Server 以加载新版插件、规则或配置。
- **结构化搭档问答（`ask` / `answer_question`）**：处理搭档委派的任务遇到歧义时，通过 `ask` 向搭档提问（默认 10 分钟超时），避免后台无人值守会话卡在原生交互提问；需最终用户拍板时可提交 `action: "needs_user"` 交由前台窗口向用户确认。
- **按成员启用/关闭（`on` / `off`）**：关闭期间（`enabled = false`）持久写入 `member-control.json`，协调器、MCP 与 hooks 对该成员停止一切投递、唤醒与自动恢复；关闭可由用户指令或授权的 `set_enabled` 触发，**重新开启（`on`）只接受人工在输入框或独立交互终端亲手执行**。
- **协调器断线自愈提醒（`broker_outage`）**：协调器连续不可达时，由用户窗口原子认领一次诊断提醒（`agybridge doctor` / `agybridge bootstrap`），无界面后台会话不参与认领，同一目录带冷却上限防止循环唤醒。

## 5. 配置文件与落盘保护

`agybridge` 配置位于私有目录（默认 `~/.agybridge`，仅受环境变量 `AGYBRIDGE_HOME` 控制）下的两个 TOML 文件：

| 文件 | 维护方 | 说明 |
|---|---|---|
| `config.toml` | 用户手写 | `agybridge` 永不改写；直接保存后协调器约 1 秒内自动热重载 |
| `config.managed.toml` | `setup` 与 `agybridge config` | 程序维护并经 `fsync` + 目录同步原子替换；手写 `config.toml` 同名键优先级更高 |

主要配置键（`agybridge config list` 可查看完整实时状态）：

| 键名 | 说明 |
|---|---|
| `collaboration.implicit` | `on-demand`（默认，无候选时按需新建后台搭档）或 `never` |
| `collaboration.compatibility_wake` | `notify`（默认）或 `strict` |
| `collaboration.subagent_send` | `allow-verified`（默认）或 `deny` |
| `collaboration.sync_tip_minutes` | 长时间独自忙碌且搭档空闲时的协作提醒间隔（默认 `30`，`0` 关闭） |
| `collaboration.context_tip_tokens` | 输入侧长上下文提醒阈值数组（默认 `[400000, 600000, 850000]`） |
| `collaboration.idle_notice_minutes` | 搭档空闲但未回复 `reply_expected` 消息的提醒分钟数（默认 `5`，`0` 关闭） |
| `questions.timeout_ms` | 搭档结构化问答超时毫秒数（默认 `600000`） |
| `hosts.{codex,agy}.binary / command / home` | 指定宿主可执行文件路径、wrapper 启动命令数组或配置目录 |
| `hosts.codex.endpoint / auth_token_env` | 连接指定外部 Codex App Server 端点及认证令牌环境变量名 |
| `partners.{codex,agy}.model / effort / profile_source` | 新建后台搭档的默认模型、推理强度及来源策略（`host` 或 `frozen`） |
| `retention.*` | 事件、消息历史、归档配对、`nxref` 引用缓存与日志轮转保留上限 |

敏感配置项在独立交互终端可通过 `agybridge config set <key> <value>` 直接修改；若由模型在会话内通过 `config` 工具发起，则只生成待确认提案，必须由用户本人在输入框输入 `agybridge config pending` 查看差异并用 `agybridge config confirm <确认码>` 批准后才会生效。
