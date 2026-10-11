---
description: Enable Claude Code's Task tools for the conductor or refuter in this project now (normally automatic via the SessionStart hook — use this to wire it before the next restart)
allowed-tools: Read, Edit, Bash(bash:*), Bash(ls:*), Bash(command:*), Bash(jq:*)
---

Wire Claude Code's Task tools into this project's `.claude/settings.json`. (Note: the plugin's SessionStart hook does this automatically at the next session start after enabling — this command is the immediate/manual path. The simplest form: run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-task-tools.sh"` and verify with `jq '.env' .claude/settings.json`.)

1. Resolve the script path: `${CLAUDE_PLUGIN_ROOT}/scripts/ensure-task-tools.sh`. If `${CLAUDE_PLUGIN_ROOT}` was not substituted (still appears literally), search `~/.claude/settings.json` for the marketplace entry that provides this plugin — any `source.path` under which `claude/plugins/baton` exists (typically under `extraKnownMarketplaces`) — append `/claude/plugins/baton/scripts/ensure-task-tools.sh` to that path. Verify the file exists before running anything.
2. Check prerequisites and warn (do not block) if missing: `jq`. Without it the script exits silently without writing.
3. Run the script, then confirm with `jq '.env' .claude/settings.json` that `CLAUDE_CODE_ENABLE_TODO_TOOLS` is present and `CLAUDE_CODE_TASK_LIST_ID` is not `conductor-<slug>` (the pin earlier versions wrote; `<slug>` is the project dir basename, lowercased, non `[a-z0-9._-]` replaced by `-`).
4. If the script is unavailable, edit `.claude/settings.json` by hand instead, setting (preserve all other keys, and do not overwrite a value that is already there):

```json
"env": {
  "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"
}
```

   and delete `CLAUDE_CODE_TASK_LIST_ID` from that `env` block if its value is exactly `conductor-<slug>`.
5. Task lists are per session, so no `CLAUDE_CODE_TASK_LIST_ID` is set. If one still remains in `.claude/settings.json` or `.claude/settings.local.json`, tell the user it is user-set and left alone, that it makes every session in the project share one task list, and that deleting the key restores per-session lists.
6. Tell the user the Task tools appear on the **next session start** (`env` is read at process start), and that the `env` block can live in `.claude/settings.local.json` instead to keep it per-user — the hook respects keys already set there and leaves `.claude/settings.json` alone.
