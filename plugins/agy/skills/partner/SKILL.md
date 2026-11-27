---
name: partner
description: 'agybridge AGY <-> Codex routing, shared Artifact workbench, zero-copy nxref delegation, and GPT/AGY model tier workflow; read before slicing work or coordinating with Codex'
---

partner rules = agybridge rules/AGENTS.md + codex MCP instructions (always loaded), not repeated here
routing summary: AGY owns UI/frontend/styling, multimodal (images/PDF/audio/video/image-generator/browser), wide research/workflow fan-out, and user alignment/Artifacts; Codex owns backend/systems/concurrency/security/hard bug root-causing (Sol = default high-value backend, Astra = hardest systems/architecture/security, Terra = simple scoped slices; effort high/xhigh)
shared workbench: status exposes self.artifacts_dir + scratch_dir -> write plans/specs/diagrams to artifacts_dir and send file:// or absolute paths to Codex (Codex reads them directly); avoid pasting long specs in messages
nxref detail: PreToolUse hooks expand bare nxref:msg:<id> and nxref:agent:<subagent_conversation_id> in codex.send_message, invoke_subagent (Prompt), send_message (Message), and run_workflow (Args); quoted/backticked refs stay literal
full model profiles & routing matrix: read references/collaboration.md
