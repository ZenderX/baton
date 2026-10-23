---
description: Run the conductor workflow on a task
argument-hint: "<task>"
---
Run the full conductor workflow (request.md -> Scout -> Plan -> Implement -> Review -> final gate, through `scout`, `architect`, `developer`, and `tester`) for: $@

If conductor mode is not already active for this session, enable it first with the `/conductor` command (or restart with `pi --conductor`), then delegate every phase through the `subagent` tool rather than doing the work yourself. Start with `Scout` and read its `## job` section of `scout.result.md`; a missing answer is a dispatch, never a stop; the `tester`'s verdicts are binding.
