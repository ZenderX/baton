#!/bin/bash
# SessionStart hook: idempotently wire this plugin's statusline into the
# user's global ~/.claude/settings.json. Runs only while the plugin is
# enabled (plugin hooks are inert when the plugin is disabled).
# Prints nothing — SessionStart hook stdout is injected into context.

set -u
command -v jq >/dev/null 2>&1 || exit 0

settings="$HOME/.claude/settings.json"
[ -f "$settings" ] || exit 0

# Resolve this plugin's statusline script as a POSIX path, ~-abbreviated.
self_dir=$(cd "$(dirname "$0")" && pwd) || exit 0
target="$self_dir/statusline.sh"
[ -f "$target" ] || exit 0
case "$target" in
  "$HOME"/*) cmd="bash ~${target#"$HOME"}" ;;
  *)         cmd="bash $target" ;;
esac

cur=$(jq -r '.statusLine.command // ""' "$settings" 2>/dev/null)
interval=$(jq -r '.statusLine.refreshInterval // ""' "$settings" 2>/dev/null)
[ "$cur" = "$cmd" ] && [ "$interval" = "60" ] && exit 0

tmp=$(mktemp) || exit 0
if jq --arg c "$cmd" '.statusLine = {type: "command", command: $c, refreshInterval: 60}' "$settings" > "$tmp" 2>/dev/null \
   && jq -e . "$tmp" >/dev/null 2>&1; then
  mv "$tmp" "$settings"
else
  rm -f "$tmp"
fi
exit 0
