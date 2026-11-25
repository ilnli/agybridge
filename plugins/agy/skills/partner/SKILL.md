---
name: partner
description: 'agybridge AGY <-> Codex routing, delegation, and collaboration workflow; read before slicing work or coordinating with Codex'
---

partner rules = agybridge rules/AGENTS.md + codex MCP instructions (always loaded), not repeated here
foreground wake rule: after send_message(reply_expected=true) in AGY TUI, call wait_partner once and end turn; never poll status or sleep
nxref detail: codex.send_message and invoke_subagent PreToolUse hooks expand bare nxref:msg:<id> tokens; quoted/backticked refs stay literal
collaboration guide: read references/collaboration.md
