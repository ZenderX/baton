---
description: Run the conductor workflow on a task
argument-hint: "<task>"
---
Run the conductor workflow for: $@

If conductor mode is not already active for this session, enable it first with the `/conductor` command (or restart with `pi --conductor`). Triage first: answer a question within the read budget or through one `Answer` dispatch to `analyst`; run a small named edit on the direct path; otherwise run the full path (request.md -> Analyze -> Plan -> Implement -> Review -> final gate, through `analyst`, `architect`, `developer`, and `reviewer`). Delegate every phase through the `subagent` tool rather than doing the work yourself; a missing answer is a dispatch, never a stop; the `reviewer`'s verdicts are binding.
