---
description: Manually wire this plugin's statusline into settings.json now (normally automatic via the SessionStart hook — use this to skip the restart)
allowed-tools: Read, Edit, Bash(bash:*), Bash(ls:*), Bash(command:*)
---

Configure the user's Claude Code statusline to use this plugin's script. (Note: the plugin's SessionStart hook does this automatically at the next session start after enabling — this command is the immediate/manual path. The simplest form: run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-statusline.sh"` and verify `statusLine` appeared in `~/.claude/settings.json`; fall back to the manual steps below if that fails.)

1. Resolve the script path: `${CLAUDE_PLUGIN_ROOT}/scripts/statusline.sh`. If `${CLAUDE_PLUGIN_ROOT}` was not substituted (still appears literally), fall back to the marketplace source directory declared in `~/.claude/settings.json` under `extraKnownMarketplaces` (append `/plugins/statusline/scripts/statusline.sh`). Verify the file exists before editing anything.
2. Check prerequisites and warn (do not block) if missing: `jq`, `curl`, GNU `date` (`date -d`), a Nerd-Font-capable terminal (glyphs U+E0B0/U+E0A0/U+F07B).
3. Edit `~/.claude/settings.json`, setting (preserve all other keys):

```json
"statusLine": {
  "type": "command",
  "command": "bash <resolved script path, POSIX-style, ~-abbreviated when under $HOME>",
  "refreshInterval": 60
}
```

4. Smoke-test by piping a minimal payload into the script and confirming non-empty ANSI output:

```bash
printf '{"model":{"id":"claude-fable-5","display_name":"Fable 5"},"workspace":{"current_dir":"<cwd as escaped Windows path>"}}' | bash <resolved script path>
```

5. Tell the user the statusline takes effect on the next session start, and that plan usage requires `~/.claude/.credentials.json` (Claude Code OAuth login) — the segment silently disappears without it.
