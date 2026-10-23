---
description: Run the refuter workflow on a task
argument-hint: "<task>"
---
Run the full refuter workflow (Scout -> Plan -> Implement -> Review -> Consult -> Fix, through `scout`, `architect`, `developer`, `tester`, and `expert`) for: $@

If refuter mode is not already active for this session, enable it first with the `/refuter` command (or restart with `pi --refuter`), then delegate every phase through the `subagent` tool rather than doing the work yourself.
