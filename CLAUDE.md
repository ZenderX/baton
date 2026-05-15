# Claude Code Skills & Agents

## Workflow

### Default: Single-Session

Handle most tasks directly in the current session. Use `/compact` if context grows large. Only escalate to the conductor when a task is too large for one context window or has genuinely independent parallel workstreams.

### Escalate to the Conductor

**From the CLI:**
```
claude --agent conductor
```

**In-session:** Use the `Agent` tool with the `conductor` agent. Provide a clear, concise task description and let the conductor handle the rest.

The conductor holds a private working model in its context window. It reads project files directly for routing decisions, distills subagent results to extract only what matters for the next step, and uses file-based state (`task-state.md`) for genuine cross-subagent sharing.

The conductor routes to the lightest workflow that fits:
- **Single-agent** — conductor handles the task directly, no subagents (default for most work)
- **Direct delegation** — routes a self-contained task straight to one subagent
- **Lightweight workflow** — reads key files, plans internally, delegates implementation and review
- **Full workflow (parallel)** — spawns independent workstreams in parallel for large multi-phase tasks
