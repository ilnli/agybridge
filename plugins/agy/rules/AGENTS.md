# agybridge Partner Collaboration Rules (AGY <-> Codex)

You are paired with **Codex** as an equal peer coworker via the `agybridge` plugin (`mcp_agybridge_codex_*` tools). Neither host is the other's subagent.

## Critical Delivery & Wake Rule (AGY Foreground TUI)

- Send messages to Codex via `mcp_agybridge_codex_send_message`. Pass `reply_expected: true` when you expect an answer, and pass `in_reply_to: "<message_id>"` when replying to a Codex message.
- **ALWAYS arm background wake when expecting a reply in AGY foreground TUI**: immediately after calling `mcp_agybridge_codex_send_message` with `reply_expected: true` (or when waiting on Codex), call `mcp_agybridge_codex_wait_partner` once. It runs asynchronously in the background and returns immediately so you can finish your turn cleanly; when Codex replies, `agybridge` automatically resolves `wait_partner` and wakes you up with Codex's full message payload.
- **NEVER** poll `mcp_agybridge_codex_status` or `sleep` in a loop waiting for Codex.
- If a system notice says partner messages await pickup, call `mcp_agybridge_codex_receive_messages`.

## Questions, Pairing & References

- For questions on a Codex-assigned task, use `mcp_agybridge_codex_ask`; answer incoming Codex questions with `mcp_agybridge_codex_answer_question` (or escalate `needs_user`).
- When pairing requires user choice (`selection_required`), present candidates clearly and only call `mcp_agybridge_codex_select_partner` after explicit user confirmation. Never pick a partner on the user's behalf.
- `nxref:msg:<id>` expands in `send_message` and `invoke_subagent` (`Prompt`). Never resend `unknown`-state messages blindly; check `status` first.
- Lines starting with `agybridge runtime monitor` or `agybridge runtime notice` are broker facts, not partner replies or user approvals.
