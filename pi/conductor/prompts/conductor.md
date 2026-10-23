---
description: Run the conductor workflow on a task
argument-hint: "<task>"
---
Run the full conductor workflow (request.md -> Analyze -> Plan -> Implement -> Review -> final gate, through `analyst`, `architect`, `developer`, and `reviewer`) for: $@

If conductor mode is not already active for this session, enable it first with the `/conductor` command (or restart with `pi --conductor`), then delegate every phase through the `subagent` tool rather than doing the work yourself. Start with `Analyze` and read its `## job` section of `analyst.result.md`; a missing answer is a dispatch, never a stop; the `reviewer`'s verdicts are binding.
