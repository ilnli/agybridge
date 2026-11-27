# agybridge collaboration guide

This guide describes how Antigravity (AGY) and Codex work together through `agybridge`, what each host and model tier excels at, and how to route and share context without wasting tokens. Where an individual note and the routing matrix disagree, the routing matrix wins.

## Messaging & Core Loop

AGY and Codex are equal peer partners and coworkers. Neither is the other's subagent. Talk to each other often with short, high-signal messages.

| You are | How to reach your partner |
|---|---|
| **Codex** | `agy.send_message` sends a message, `agy.status` shows partner state + shared `artifacts_dir` / `scratch_dir`, `agy.receive_messages` picks up pending messages, `agy.ask` / `agy.answer_question` handle partner questions. |
| **AGY** | `codex.send_message` sends a message, `codex.wait_partner` arms background wake in AGY foreground TUI (`Stop` hook also guards against forgetting it on `reply_expected: true`), `codex.status` shows partner state + own `artifacts_dir` / `scratch_dir`, `codex.receive_messages` picks up pending messages, `codex.ask` / `codex.answer_question` handle partner questions. |

## Host & Model Profiles

### Antigravity (AGY / Gemini)
- **Native Multimodal & Visual Intelligence**: Directly reads images, screenshots, PDFs, audio, and video via `read_file`; generates/edits visual assets via built-in `image-generator` subagent; performs live UI/DOM/visual verification via `/browser` and specialized design/UI skills.
- **Interactive Alignment & User UX**: Excels at requirement discovery (`/grill-me`, `/plan`, `ask_question`), live execution checklists (`update_steps`), structured Markdown **Artifacts** (`<artifacts_dir>/*.md` with Mermaid diagrams, carousels, and feedback-enabled plans), and natural user communication.
- **Broad Fan-Out Orchestration**: Spawns parallel `research` / `self` subagents (`invoke_subagent`, `send_message`) and multi-stage Python agent pipelines (`run_workflow`) to survey wide codebases quickly.
- **Multi-Surface & Managed ACP Parity**: Works seamlessly across Antigravity CLI (`~/.gemini/antigravity-cli`) and Antigravity 2.0 IDE (`~/.gemini/antigravity`), with managed `agy acp` background sessions preserving permission boundaries (`bypass` vs `prompting` -> `needsHuman` escalation) and ACP execution `mode`s (`default`, `accept-edits`, `plan`).
- **Typical Blind Spots vs GPT**: Less exhaustive than high-effort GPT on subtle backend race conditions, tricky OS/process edge cases, and adversarial security corner cases.

### Codex (GPT Models)
- **GPT-6.2 Sol**: Mainstream workhorse GPT model. Nearly matches Astra on standard engineering stacks at ~60% lower cost. Default choice for medium-to-high difficulty backend features, refactors, and test suites.
- **GPT-6.2 Astra**: Strongest deep-engineering model. Best at hard backend/distributed systems bugs, concurrency/lifecycle edge cases, security audits, graphics/math modeling, and macro architecture trade-offs.
- **GPT-6.1 Terra**: Cost-effective option (~30% cheaper than Sol), more literal/rigid. Good for well-scoped, low-to-medium difficulty implementation slices or mechanical migrations.
- **Effort Guidance**: Use `high` or `xhigh` for Sol and Astra (`max` only for the hardest proofs/bugs). Use `xhigh` for Terra.
- **Shared GPT Traits**: Strong raw analytical rigor, careful boundary verification, and disciplined execution once scope is clear; weaker at visual taste, prose warmth, and unstated product intuition (tendency to over-engineer unless bounded).

## Shared Workbench & Zero-Copy Context (`artifacts_dir` + `nxref:`)

1. **Shared Artifact Workbench (`artifacts_dir` / `scratch_dir`)**:
   - `status` exposes the AGY session's `artifacts_dir` (`.../brain/<conversation-id>`) and `scratch_dir` (`.../brain/<conversation-id>/scratch`) to both peers.
   - Instead of pasting long plans, specs, or audit tables into chat messages, AGY writes plans/specs to `artifacts_dir` and sends `[plan.md](file:///.../plan.md)` (or plain path) to Codex — Codex reads the file directly from disk in one call.
   - For large diagnostic dumps or intermediate notes, write to `scratch_dir` (when writable) or an external temp/checkpoint file and pass the path + concise summary.
2. **Zero-Copy References (`nxref:`)**:
   - Reference existing pair messages with `nxref:msg:<message_id>` and completed own subagent outputs with `nxref:agent:<agent_id>` (on AGY, `<agent_id>` is the subagent's `conversationId` UUID).
   - `agybridge` expands bare `nxref:` tokens automatically in `send_message`, AGY `invoke_subagent` (`Prompt`), AGY subagent `send_message` (`Message`), AGY `run_workflow` (`Args`), and Codex native `spawn_agent` (`message`). Quoted or backticked `nxref:` tokens stay literal.

## Task Routing Matrix

These routing rules take precedence when slicing non-trivial work (user instructions always override):

| Domain / Task Type | Primary Owner & Collaboration Pattern |
|---|---|
| **Frontend UI, visual design, styling, UX, aesthetics** | **AGY** leads UI/visuals/component UX; **Codex** handles complex state machines, data-layer wiring, or strict type/test harnesses when needed. |
| **Multimodal tasks (screenshots, PDFs, diagrams, assets)** | **AGY** (native multimodal `read_file`, `image-generator`, `/browser`). |
| **Backend, systems, concurrency, OS/process, CLI/IPC** | **Codex** (`Astra` for hard races/lifecycle/architecture; `Sol` for standard implementation). |
| **Security review, sandboxing, trust & auth boundaries** | **Codex** (`Astra` / `Sol` `high`–`xhigh`) leads audit & hardening; AGY reviews UX impact. |
| **Macro architecture & cross-cutting specs** | **Discuss together**: AGY drafts user-aligned spec/Artifact + product trade-offs; Codex stress-tests invariants, failure modes, and data/state contracts. |
| **Hard bug diagnosis & regression hunting** | **Codex** isolates root cause + minimal repro + regression test; **AGY** assists with broad repo fan-out (`research` subagents) or UI reproduction. |
| **Documentation, release notes, user communication** | **AGY** leads structure, clarity, and user-facing prose; **Codex** verifies technical/command accuracy against code. |

## Working Style Checklist

- Agree on file/module ownership boundaries before editing in parallel so neither partner touches the other's files.
- Always set `in_reply_to` when answering or finishing a partner's task message.
- Run one heavy build/test suite at a time across the pair; trust your partner's routine checks unless new edits invalidate them.
- Never fabricate partner results or blindly resend `unknown`-state messages; check `status` first.
