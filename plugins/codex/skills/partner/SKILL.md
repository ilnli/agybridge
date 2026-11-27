---
name: partner
description: 'agybridge routing/delegation, shared AGY Artifact workbench, and GPT/AGY model strengths/costs/effort; read before task routing, spawning subagents or choosing model/reasoning_effort'
---

partner rules = agy MCP instructions (always loaded), not repeated here
subagent policy (agybridge enabled; user intent overrides): delegate reasonably independent work (eg feature implementation, probes, platform work, review) to subagents when it saves time or isolates context; keep tightly coupled or tiny work local. default <=2 concurrent; fresh context + small brief each. may consult agy on task slicing
shared workbench: agy.status exposes partner.artifacts_dir + partner.scratch_dir; read AGY's plan/spec/diagram Artifacts directly from disk when referenced instead of asking AGY to copy-paste
nxref detail: agy.send_message and native function spawn_agent hooks expand bare refs (V1/V2, including namespaced function calls). Service-hosted multi_agent_call actions bypass local hooks: read_messages first and inline needed text in delegation; use returned child final directly. Unknown spawn support -> inline, never pass unresolved nxref. Captured agent refs require a finished child. Supported expansion errors block sending/native spawning; fix id or inline. Quoted/backticked refs stay literal; expanded blocks use [nxref msg:<id>]...[/nxref].
model strengths/costs/effort prefs & routing matrix: read references/collaboration.md
