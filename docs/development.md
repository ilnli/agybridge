# 开发说明

面向从源码构建、修改或排查 `agybridge` 实现的开发者：目录结构、构建打包、安装机制与验证测试。日常安装与使用请先看仓库首页 [README.md](../README.md) 与 [user-guide.md](user-guide.md)。

## 目录结构

| 位置 | 说明 |
|---|---|
| `src/` 根目录 | 固定运行入口：`cli.ts`、`hook-entry.ts`、`mcp-entry.ts`，以及全局共用的 `types.ts`、`version.ts`。入口名与发布文件名保持稳定，插件按固定名字加载 |
| `src/app/` | 命令行分派（`dispatch.ts`）与帮助（`help.ts`）；`commands/` 按子命令拆分实现，按需加载 |
| `src/broker/` | 本机协调器 `coordinator.ts` 及其领域模块：`requests/`（RPC 契约）、`pairing/`（配对、候选选择、解除与恢复）、`profiles/`（后台搭档模型与推理强度管理）、`lifecycle/`（后台准备、恢复编排与进程回收）、`recovery/`（故障恢复、前台接管、会话托管与历史核验）、`delivery/`（消息投递、`nxref:` 引用展开与协作提醒）、`health/`（轮次进展、在途工具、资源与运行状态监测） |
| `src/hosts/` | 后台启动与宿主协议适配：`agy/`（`acp-client.ts` JSON-RPC over stdio 客户端、`adapter.ts` 后台 `agy acp` 会话生命周期与权限处理、`identity.ts` MCP/hook 会话与产物路径解析）、`codex/`（App Server、共用 daemon、持久历史回执、命名权限隔离与冷重启） |
| `src/integration/` | 模型与宿主接入：`mcp/`（`server.ts` 双端 MCP 工具集、问答协议、错误映射与终端展示）、`hooks/`（AGY 与 Codex hook 客户端、命令入口、超时守卫与会话绑定），`instructions.ts` 维护常驻协作指令 |
| `src/install/` | `setup` / `update` / `uninstall`、安装事务日志、插件缓存保留、版本兼容预检与独立运行时管理 |
| `src/config/` | `config.toml` 与 `config.managed.toml` 解析、schema 校验、自动热重载与宿主内配置提案 |
| `src/ipc/` | 本地 Unix socket / Windows Named Pipe 通信、64 位令牌校验与修复、唤醒通道 |
| `src/process/` | 宿主命令解析、进程代次核验、归属登记与安全回收；`windows/`、`posix/` 为平台实现 |
| `src/storage/` | `node:sqlite` WAL 账本、schema 迁移、落盘原子文件写入（`atomic-file.ts`、`state-directory.ts`）、日志轮转与数据保留 |
| `src/shared/` | 跨模块基础工具（路径、时间预算、错误类型、内嵌脚本标记） |
| `src/tests/`、`src/native-tests/` | 单元测试与调用真实官方 CLI 的原生集成测试；测试夹具位于 `src/tests/support/` |
| `plugins/agy/`、`plugins/codex/` | 两端插件源码。`plugins/agy/` 包含 `plugin.json`、`mcp_config.json`、`hooks.json`、`rules/AGENTS.md`、`skills/partner/` 及图标资源；`plugins/codex/` 包含 `.codex-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json` 与 `skills/partner/` |
| `tools/` | 构建打包（`build-publish.mjs`、`pack-publish.mjs`）、版本同步（`sync-version.mjs`）、内嵌代码处理、测试运行器与诊断脚本 |
| `docs/` | 使用说明（`user-guide.md`）、协作指南（`collaboration.md`，构建时同步至两端 `partner` 技能）、行为说明（`behavior.md`）与本开发说明 |
| `publish/` | `npm run build:publish` 生成的零外部依赖发行目录（不入库）；打标签发布时打包为 Release zip |
| `.github/` | GitHub Actions：推送构建与跨平台单元/原生测试（`ci.yml`）、版本标签发版（`release.yml`）、定时兼容性巡检（`canary.yml`） |

> 注意：Codex 插件目录下的文件一旦发生字节变化，用户需要在 Codex 的 `/hooks` 中重新授权一次信任，因此 `plugins/codex/` 的文件内容和入口名应尽量保持稳定。

## 从源码构建与安装

### 环境要求

- Node.js 24～26（内置 `node:sqlite`）
- 官方 `agy` CLI 与 `codex` CLI（`>= 0.164.0`）

### 构建与本地部署

```sh
npm ci
npm run build
npm run build:publish
node publish/agybridge.mjs setup --dry-run   # 预检
node publish/agybridge.mjs setup             # 安装或更新本机环境
```

`npm run build:publish` 使用 `esbuild` 将运行时与依赖打包进 `publish/`（无需 `node_modules`），同时生成第三方依赖许可证清单 `publish/THIRD-PARTY-NOTICES.md` 和完整性校验清单 `publish/publish.json`。

校验 AGY 插件清单与结构：

```sh
agy plugin validate plugins/agy --strict
```

### `setup` / `update` 的工作流

1. **只读预检**：检查 Node.js 版本与 `node:sqlite`、两端 CLI 版本与必需能力、本地市场目录与命令路径冲突，以及本地 IPC 令牌完整性。任一检查未通过均直接退出，不落盘修改。
2. **独立运行时落盘**：将 `publish/` 复制到 `~/.agybridge/runtime/<buildId>`（仅保留当前版与上一版），更新 `~/.agybridge/bin/runtime.json` 指针，并在用户可写的 `PATH` 目录（优先 `~/.local/bin`、`~/bin`、用户 npm 全局目录等）生成 `agybridge` 启动命令。
3. **双端插件安装与同步**：
   - 在 `~/.agybridge/marketplace/` 生成注入了本机 Node 与桥接路径的 `plugins/agy` 和 `plugins/codex`，并将 `docs/collaboration.md` 同步为技能参考文档。
   - **AGY 侧**：首次通过 `agy plugin install` 安装到 `~/.gemini/config/plugins/agybridge/`；后续更新优先文件级同步或重装，保留启用状态。
   - **Codex 侧**：通过 `agybridge-local` 本地市场安装 `agybridge@agybridge-local`，并通过 Codex 官方配置接口写入限定在 `agy` 命名空间的直接工具配置（不改动模型、沙箱、审批或 hooks 信任记录）。
4. **零停机交接或平滑重启协调器**：新旧版本均支持交接协议（`publish/broker-custody-v1`）时，新协调器通过受保护的本机交接通道继承后台 Codex 物理订阅与挂起中的搭档问答等待（`question.wait`），正在执行的轮次不中断、问题超时时钟保持不变；旧版本不支持交接时则等待活动问答结束后平滑切换。

### 更新后重新加载

- **已打开的 AGY 前台窗口**：退出后通过 `agy --conversation <会话ID>` 恢复，或新开窗口即可加载最新插件与 MCP 服务；其中短生命周期 command hooks（如 `PreToolUse`、`PreInvocation`、`Stop`）每次执行都会经稳定入口连接新协调器。
- **后台 AGY ACP 会话**：空闲时可通过 `agybridge open agy` 接管或由协调器按原会话 ID 重新连接。
- **后台 Codex 搭档**：空闲后在外部终端执行 `agybridge restart codex`（多配对时指定 `--member <ID>`）。
- **用户前台 Codex 窗口**：退出后用 `codex resume <会话ID>` 恢复或新开会话。

## 验证与测试

```sh
npm run check               # 版本元数据同步、Windows 原生身份修订、TypeScript 类型与模块导入边界检查
npm test                    # 构建并运行全部单元测试（dist/tests/**/*.test.js）
npm run test:native         # 在隔离临时目录中使用真实 CLI + 本地模拟模型服务运行原生协议测试
npm run test:native:target  # 临时下载指定版本官方 Codex 二进制做隔离兼容性验证
npm run pack:zip            # 生成并校验 artifacts/releases/agybridge-<buildId>.zip 发布包
```

测试准则：

- 所有自动化测试均在临时隔离目录（`AGYBRIDGE_HOME`、`CODEX_HOME`、`AGY_HOME`）中运行，使用本机模拟模型接口或模拟 ACP 进程，**不调用真实在线模型，也不读写用户真实配置**。
- 测试运行器（`tools/run-tests.mjs`）自动追踪每个测试批次派生的子进程并在批次结束时核验回收，防止孤儿进程残留。
