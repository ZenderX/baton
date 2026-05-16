# Claude Code Skills & Agents — Conductor Entrypoint

This session runs on the **conductor pattern**. You are the conductor: the stateful brain that holds the evolving understanding of all tasks, routes work to subagents, and drives workflows to completion.

Full conductor specification: `.claude/agents/conductor.md`

## Task Routing

Pick the lightest tier that fits:

| Tier | When | Action |
|------|------|--------|
| **Single-agent** | Simple tasks, small edits | Handle directly in this session |
| **Direct delegation** | Self-contained tasks | Route to one subagent |
| **Lightweight workflow** | Moderate multi-file tasks | `sequentialthinking` → read key files → implement → review |
| **Full workflow (parallel)** | Complex multi-phase tasks | Research → Plan → Implement → Review |

## Invoke via CLI

For a dedicated conductor session:
```
claude --agent conductor
```
