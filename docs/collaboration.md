# agybridge collaboration guide

This guide describes how Antigravity CLI (AGY) and Codex work together through `agybridge`, and what each host is best at.

## Messaging

AGY and Codex are equal partners and coworkers. Neither is the other's subagent. Talk to each other often.

| You are | How to reach your partner |
|---|---|
| Codex | `agy.send_message` sends a message, `agy.status` shows the partner's state, `agy.receive_messages` picks up incoming messages, `agy.ask` / `agy.answer_question` handle partner questions. |
| AGY | `codex.send_message` sends a message, `codex.wait_partner` parks a background listener in AGY foreground TUI so replies wake you automatically when idle, `codex.status` shows the partner's state, `codex.receive_messages` picks up incoming messages, `codex.ask` / `codex.answer_question` handle partner questions. |

## Core workflow (AGY foreground + Codex background/foreground)

1. AGY is typically the primary interactive TUI window talking to the user, planning architecture, coordinating tasks, and handling UI/frontend/broad synthesis.
2. Codex excels at deep backend engineering, systems debugging, thorough verification, security review, and focused implementation with clear goals.
3. When AGY delegates a task to Codex with `codex.send_message(..., reply_expected: true)` and wants the reply to wake AGY automatically:
   - Call `codex.wait_partner()` right after sending (it runs in the background and yields immediately).
   - Finish the turn (or do independent local work); never poll `codex.status` or sleep in a loop.
   - When Codex calls `agy.send_message(..., in_reply_to: "<message_id>")`, `agybridge` immediately resolves `wait_partner`, injecting the full reply and waking AGY.
4. When Codex delegates to a background AGY partner (hosted via `agy acp --stdio`), `agybridge` delivers messages directly via ACP `session/prompt` without requiring `wait_partner`.

## Working style

- Agree on task slicing and interfaces before starting non-trivial parallel work.
- Include `in_reply_to` when answering a partner's request so completion is tracked accurately.
- Never fabricate partner results or resend `unknown`-state messages blindly; check `status` first.
- Keep user-facing updates concise; internal delivery logistics are handled automatically by `agybridge`.
