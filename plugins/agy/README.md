# agybridge AGY 插件

提供与 Codex CLI 平等搭档通信的原生 Antigravity CLI (`agy`) 插件，包含：

- `mcp_config.json`：注册 `codex` MCP 服务（工具前缀 `mcp_agybridge_codex_*`），其中 `wait_partner` 默认配置 `eager: true` + `background: "always"` + `timeoutSeconds: -1`，可在 AGY 前台 TUI 空闲时自动被 Codex 回信唤醒。
- `hooks.json`：注册 `SessionStart`、`PreInvocation`、`PreToolUse`（自动以 `allow` 放行 `mcp_agybridge_codex_*`、`invoke_subagent`、`send_message` 与 `run_workflow`，并展开其中的 `nxref:` 引用）、`PostToolUse`（追踪工具完成并捕获子代理回报）与 `Stop`（兜底唤醒），自动隔离子代理 hook 以保护根会话绑定。
- `rules/AGENTS.md`：常驻协作规则与 `wait_partner` 使用约束。
- `skills/partner/`：协作指南与参考文档。

通过 `agybridge setup` 自动准备并调用 `agy plugin install` 安装到 `~/.gemini/config/plugins/agybridge/`。
