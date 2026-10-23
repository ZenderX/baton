---
description: Run the refuter workflow on a task
argument-hint: "<task>"
---
Run the full refuter workflow (Analyze -> Plan -> Implement -> Review -> Consult -> Fix, through `analyst`, `architect`, `developer`, `reviewer`, and `consultant`) for: $@

If refuter mode is not already active for this session, enable it first with the `/refuter` command (or restart with `pi --refuter`), then delegate every phase through the `subagent` tool rather than doing the work yourself.
