# agybridge

让同一台电脑上的 **Antigravity CLI (`agy`)** 和 **Codex CLI (`codex`)** 互相发消息、平等异步协作。

你照常跟其中一边说要做什么，两边会按各自擅长的方向自动商量分工、并行推进、互相审查把关，不用你在两个终端窗口之间来回复制转述。两边仍然是各自的官方 CLI，使用各自的登录态、模型服务、上下文与权限边界；`agybridge` 只在本机传递消息与维护协调状态，不调用任何外部模型，也不把内容发往别处。

## 它能做什么

- **平等搭档、取长补短**：AGY 擅长交互规划、跨模块综合分析、前端/UI 与多代理编排；Codex 擅长纵深后端工程、系统级调试、严密验证与安全审查。双方作为对等同事异步配合，绝不把一方降级成另一方的无状态子代理。
- **前台自动唤醒 + 双向后台托管**：
  - 在 **AGY 前台窗口**发信后通过 `codex.wait_partner` 在后台挂起监听，Codex 完成任务回信时**自动唤醒空闲中的 AGY 窗口并注入完整回复**，无需轮询。
  - 同目录没有对方窗口时自动按需拉起后台搭档（后台专用 Codex App Server，或基于 **`agy acp --stdio`** 的后台 AGY 会话），严格遵循源会话权限边界（非 `bypass` 会话遇到审批自动转 `needsHuman`），需要人工查看或介入时随时用 `agybridge open codex` 或 `agybridge open agy` 在前台打开原会话；同时兼容 Antigravity CLI 与 Antigravity 2.0 IDE 会话存储目录。
- **消息可靠、断线可恢复**：每条消息与问答均记录在本机 SQLite WAL 持久账本中，送达证据如实反馈，结果不明（`unknown`）的消息绝不盲目重发；后台搭档意外退出后按原会话自动恢复，关键状态文件均经 `fsync` 落盘后原子替换。
- **非侵入、数据隔离**：通过两家官方的插件、生命周期 hooks 和 MCP 标准协议接入，不修改 CLI 本身，不改动你的模型、沙箱和审批策略，也不安装系统常驻服务。所有运行数据隔离保存在 `~/.agybridge`（`AGYBRIDGE_HOME`）。

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js `24` ～ `26` | 需要内置 `node:sqlite`，运行 `node -v` 确认 |
| Antigravity CLI (`agy`) | 已完成登录（推荐 `1.5.14+`） |
| Codex CLI (`codex`) | 已完成登录，版本至少 `0.164.0` |

已在 Linux / WSL 与 Windows 环境完成协议验证；macOS 提供独立只读验证工具与隔离用例（见 [tools/macos-validation.md](tools/macos-validation.md)）。

## 安装

### 方式一：从 Release 压缩包安装

1. 从 [Releases](https://github.com/ilnli/agybridge/releases) 下载最新 `agybridge-<版本>.zip` 并解压，在解压目录打开终端。
2. 执行安装：

   ```sh
   node agybridge.mjs setup --dry-run   # 先预演检查，不写入任何文件
   node agybridge.mjs setup             # 正式安装
   ```

### 方式二：从源码构建安装

```sh
git clone git@github.com:ilnli/agybridge.git
cd agybridge
npm ci
npm run build:publish
node publish/agybridge.mjs setup
```

`setup` 会将独立运行时复制到 `~/.agybridge/runtime/`，通过两端官方插件机制安装 `agybridge` 插件，并在你 `PATH` 中的用户目录放置 `agybridge` 命令。安装完成后，临时解压目录或构建目录移走也不影响运行。

### 让插件生效

1. **AGY**：新开一个 `agy` 窗口，或用 `agy --conversation <会话ID>` 恢复会话以加载插件。
2. **Codex**：新开一个会话，在 `/hooks` 中信任 `agybridge` 的 hooks。
3. **自检**：运行 `agybridge doctor` 确认两端状态正常。

## 日常使用

在项目目录打开 `agy`（或 `codex`），直接像平时一样描述任务即可：需要搭档时会自动配对或在后台拉起搭档，双方商定边界后并行工作、互相核验。也可以直接指定分工或模型，例如“用 `agybridge` 拉起一个 Codex（`gpt-6.2-astra` `high`），把底层重构和测试交给它”。

常用命令：

| 命令 | 作用 |
|---|---|
| `agybridge status` | 查看当前配对、双方状态与消息计数 |
| `agybridge doctor` | 检查双端 CLI、插件、hooks 信任与本机协调器状态 |
| `agybridge pair` | 查看可配对窗口、历史后台搭档，或手动指定配对 |
| `agybridge open codex` / `agybridge open agy` | 在前台临时接管后台运行的 Codex 或 AGY 会话 |
| `agybridge adopt codex` / `release codex` | 将 Codex 会话转交后台托管，或交还用户窗口 |
| `agybridge partner-profile codex\|agy` | 查看或修改后台搭档使用的模型与推理强度 |
| `agybridge pause` / `resume` / `unpair` | 暂停、恢复或解除当前配对 |
| `agybridge restart codex` | 在后台 Codex 空闲时平滑重启运行时 |
| `agybridge watch` | 实时查看双方消息流与结构化问答 |
| `agybridge update [--from <目录>]` | 更新或修复当前安装 |
| `agybridge uninstall [--dry-run] [--purge]` | 卸载插件与命令（`--purge` 一并清理 `~/.agybridge`） |

在 AGY 或 Codex 输入框里也可以直接输入快捷指令：`agybridge status`、`agybridge on/off`、`agybridge pair [<配对码>]`、`agybridge pickup`（或 `agybridge 收信`）、`agybridge config pending` / `confirm`。

## 文档

- [使用说明](docs/user-guide.md)：安装、更新、配对、后台托管、快捷指令与安全边界完整指南
- [协作指南](docs/collaboration.md)：AGY 与 Codex 的分工方式、`wait_partner` 唤醒与协作约定
- [行为说明](docs/behavior.md)：协议细节、状态机、异常检测、恢复策略与 TOML 配置项参考
- [开发说明](docs/development.md)：目录结构、从源码构建、插件校验与自动化测试

## 致谢

本项目基于 **[nxbridge](https://github.com/nxbridge/nxbridge)** 衍生与改造而来，特此向原项目及其作者致以诚挚感谢！

`nxbridge` 为本地 CLI 智能体之间的对等异步协作奠定了极其扎实的工程基础——包括本机协调器架构、SQLite 可靠投递账本、Codex App Server / daemon 深度协议适配、进程代次归属核验以及克制严谨的安全边界设计。`agybridge` 在继承上述核心设计与可靠性保障的基础上，将协作另一端适配并扩展至 **Antigravity CLI (`agy`)**，实现了原生 AGY 插件与生命周期 hooks、`wait_partner` 前台异步挂起唤醒，以及基于 `agy acp --stdio` 的后台会话托管与前后台无损切换。

## 安全反馈与许可证

安全问题请参见 [SECURITY.md](SECURITY.md) 私下报告。

本项目采用 MIT 许可证发布，详见 [LICENSE](LICENSE)。
