---
description: Run the conductor workflow on a task
argument-hint: "<task>"
---
Run the full conductor workflow (scout/research -> build -> refute -> gate) for: $@

If conductor mode is not already active for this session, enable it first with the `/conductor` command (or restart with `pi --conductor`), then delegate every phase through the `subagent` tool rather than doing the work yourself.
