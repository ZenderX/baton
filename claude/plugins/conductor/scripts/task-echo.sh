#!/bin/bash
# PostToolUse hook (TaskCreate|TaskUpdate): echoes a systemMessage naming the
# task and its status, e.g. Task #12 "Build X" -> in_progress.
# Prints nothing on malformed/absent input; always exits 0 so a broken hook
# can never block a tool call.
#
# Verified: hook fires on Task* tools (PostToolUse) on 2.1.268, 2026-09-11.

set -u
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
jq -e . >/dev/null 2>&1 <<<"$input" || exit 0

win_to_unix() {
  local p
  p=$(printf '%s' "$1" | tr '\\' '/')
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

tool_name=$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null)
subject=""

case "$tool_name" in
  TaskCreate)
    subject=$(jq -r '((.tool_response.task?.subject? | strings) // (.tool_input.subject? | strings) // empty) | gsub("\"";"'\''") | gsub("[▸→]";"")' <<<"$input" 2>/dev/null | LC_ALL=C tr -d '[:cntrl:]')
    id=$(jq -r '.tool_response.task?.id? // empty' <<<"$input" 2>/dev/null)
    # Dropped rather than sanitized: a garbled id is worse than none.
    case "$id" in ''|*[!0123456789]*) id="" ;; esac
    status=pending
    ;;
  TaskUpdate)
    id=$(jq -r '.tool_input.taskId // .tool_response.taskId // empty' <<<"$input" 2>/dev/null)
    status=$(jq -r '.tool_input.status // .tool_response.statusChange.to // empty' <<<"$input" 2>/dev/null | LC_ALL=C tr -d '[:cntrl:]')
    # Dropped rather than sanitized: a garbled taskId must never reach a path.
    case "$id" in ''|*[!0123456789]*) id="" ;; esac
    list_id="${CLAUDE_CODE_TASK_LIST_ID:-}"
    case "$list_id" in */*|*'\'*|*..*) list_id="" ;; esac
    if [ -n "$id" ] && [ -n "$list_id" ]; then
      task_file="$(win_to_unix "${HOME:-}")/.claude/tasks/$list_id/$id.json"
      if [ -f "$task_file" ]; then
        subject=$(jq -r '((.subject | strings) // empty) | gsub("\"";"'\''") | gsub("[▸→]";"")' "$task_file" 2>/dev/null | LC_ALL=C tr -d '[:cntrl:]')
        [ -n "$status" ] || status=$(jq -r '.status // empty' "$task_file" 2>/dev/null | LC_ALL=C tr -d '[:cntrl:]')
      fi
    fi
    ;;
  *)
    exit 0
    ;;
esac

[ -n "$id" ] || [ -n "$subject" ] || exit 0
[ -n "$status" ] || status="unknown"

if [ -n "$id" ] && [ -n "$subject" ]; then
  jq -n --arg id "$id" --arg subject "$subject" --arg status "$status" \
    '{systemMessage: ("▸ Task #" + $id + " \"" + $subject + "\" → " + $status)}' 2>/dev/null
elif [ -n "$id" ]; then
  jq -n --arg id "$id" --arg status "$status" \
    '{systemMessage: ("▸ Task #" + $id + " → " + $status)}' 2>/dev/null
else
  jq -n --arg subject "$subject" --arg status "$status" \
    '{systemMessage: ("▸ Task \"" + $subject + "\" → " + $status)}' 2>/dev/null
fi

exit 0
