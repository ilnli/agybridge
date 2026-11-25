# agybridge Codex 插件

提供与 Antigravity CLI (AGY) 平等搭档通信的 MCP 工具和 embedded 兼容 hooks。使用 `agybridge setup` 完成限定命名空间配置；模型直接获得 `agy.send_message`、`agy.status`、`agy.receive_messages`、`agy.ask` 与 `agy.answer_question`。

AGY 交来的任务有疑问用 `agy.ask`，立即提交后等关联答案；默认十分钟到期。收到 AGY 的问题用 `answer_question` 回答并说明理由，需用户决定时提交 `needs_user`。用户直接交来的任务仍按需原生提问，原生 ask 和审批不被接管。

主路径通过原版 App Server 自动收信，不依赖 hooks。无法挂接的 embedded 窗口在 hooks 获得原生信任后，通过固定通知提示取件；正文始终作为 MCP 工具结果返回。插件不改变模型、沙箱、审批策略或用户 hooks 信任记录。

配对、暂停、恢复与需要人工处理的状态可通过 `agybridge` 命令查询。

`partner` 技能提供通信入口、多交流的提醒与模型特点。模型文档的唯一维护来源是工程的 `docs/collaboration.md`；安装时复制为 `skills/partner/references/collaboration.md`，与技能一同交付。
