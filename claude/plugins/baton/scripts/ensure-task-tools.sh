#!/bin/bash
# SessionStart hook: idempotently wire Claude Code's Task tools into the
# project's .claude/settings.json "env" block. Runs only while the plugin is
# enabled (plugin hooks are inert when the plugin is disabled).
# Prints nothing — SessionStart hook stdout is injected into context.
#
# Invoked bare (no CLAUDE_PROJECT_DIR), this writes to $PWD/.claude — export
# CLAUDE_PROJECT_DIR when testing so it cannot touch the current repo.
#
# Idempotency: run N times → byte-identical file after the first run; any
# user-present value wins forever; every other key is preserved; invalid JSON
# or a missing jq is a no-op. A key already present in settings.local.json
# counts as satisfied and is never mirrored into settings.json. Presence, not
# truthiness: `false`, `0` and `""` are present; `null` counts as absent. The
# env block is read at process start, so the tools only appear on the next
# session.
#
# Task lists are per session: CLAUDE_CODE_TASK_LIST_ID is never written. A
# value equal to the `conductor-<slug>` pin earlier versions wrote into
# settings.json is removed; any other value is user-set and left alone.

set -u
command -v jq >/dev/null 2>&1 || exit 0

win_to_unix() {
  local p
  p=$(printf '%s' "$1" | tr '\\' '/')
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

proj=$(win_to_unix "${CLAUDE_PROJECT_DIR:-$PWD}")
settings="$proj/.claude/settings.json"
local_settings="$proj/.claude/settings.local.json"

slug=$(printf '%s' "$(basename "$proj")" | tr 'A-Z' 'a-z' \
  | sed 's/[^a-z0-9._-]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//')
[ -n "$slug" ] || slug="project"
old_id="conductor-$slug"

# One jq per file: emits "<enable><stale>" as y/n flags — Task tools key
# present, and the task-list pin equal to the old hook-written value.
env_state() {
  jq -r --arg id "$old_id" \
     '(.env // {}) as $raw
      | (if ($raw | type) == "object" then $raw else {} end) as $e
      | (if ($e | has("CLAUDE_CODE_ENABLE_TODO_TOOLS"))
            and ($e.CLAUDE_CODE_ENABLE_TODO_TOOLS != null) then "y" else "n" end)
        + (if $e.CLAUDE_CODE_TASK_LIST_ID == $id then "y" else "n" end)' \
     "$1" 2>/dev/null
}

flags="nn"
if [ -f "$settings" ]; then
  flags=$(env_state "$settings")
  # Unparseable settings.json: never rewrite it.
  [ -n "$flags" ] || exit 0
fi
enable=${flags%?}
stale=${flags#?}

# Unparseable settings.local.json yields empty flags and is simply ignored.
if [ "$enable" = "n" ] && [ -f "$local_settings" ]; then
  case "$(env_state "$local_settings")" in y?) enable=y ;; esac
fi

[ "$enable" = "y" ] && [ "$stale" = "n" ] && exit 0

if [ ! -f "$settings" ]; then
  mkdir -p "$proj/.claude" 2>/dev/null || exit 0
  printf '{}\n' > "$settings" 2>/dev/null || exit 0
fi

tmp=$(mktemp) || exit 0
if jq --arg e "$enable" --arg s "$stale" \
     '.env = ((.env // {}) | if type == "object" then . else {} end)
      | if $e == "n" then .env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1" else . end
      | if $s == "y" then del(.env.CLAUDE_CODE_TASK_LIST_ID) else . end
      | if .env == {} then del(.env) else . end' \
     "$settings" > "$tmp" 2>/dev/null \
   && jq -e . "$tmp" >/dev/null 2>&1; then
  mv "$tmp" "$settings"
else
  rm -f "$tmp"
fi
exit 0
