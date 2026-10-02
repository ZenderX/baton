#!/bin/bash
# PostToolUse hook: rewrite working-tree files to CRLF wherever git attributes
# say eol=crlf but the file holds LF or mixed endings. Claude Code's Write tool
# and shell edits (sed -i, heredocs, redirection) emit LF, which leaves files
# "modified" with an empty diff. Scans the whole repo instead of parsing the
# hook input, so files written by Bash are caught too.
# Prints nothing and always exits 0 — no hook noise, never blocks a tool.
#
# Invoked bare (no CLAUDE_PROJECT_DIR), this rewrites the repo containing $PWD
# — export CLAUDE_PROJECT_DIR when testing.
#
# Only files git reports as text (w/lf or w/mixed) are touched; binaries,
# symlinks and files already CRLF are left alone. A missing final newline is
# preserved. Each rewrite goes through a temp file in the same directory, so a
# failure never truncates the original.

set -u

# The hook input is unused; drain it so the writer never sees a broken pipe.
[ -t 0 ] || cat >/dev/null 2>&1

top=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" 2>/dev/null || exit 0

# Pure bash, not sed: Git for Windows sed strips CR on read.
to_crlf() {
  local line
  while IFS= read -r line; do
    printf '%s\r\n' "${line%$'\r'}"
  done
  [ -z "$line" ] || printf '%s' "$line"
}

converted=()
# Record: "i/<eol> w/<eol> attr/<attrs> <TAB><path>", fields space-padded.
while IFS= read -r -d '' rec; do
  info=${rec%%$'\t'*}
  path=${rec#*$'\t'}
  w=${info#*w/}
  w=${w%% *}
  case "$w" in lf|mixed) ;; *) continue ;; esac
  attr=${info#*attr/}
  attr=${attr%"${attr##*[! ]}"}
  case "$attr" in "text eol=crlf"|"text=auto eol=crlf") ;; *) continue ;; esac
  [ -f "$path" ] && [ ! -L "$path" ] || continue
  dir=$(dirname "$path")
  tmp=$(mktemp "$dir/.restore-crlf.XXXXXX" 2>/dev/null) || continue
  # cp -p first so the rewrite keeps the original's mode.
  if cp -p "$path" "$tmp" 2>/dev/null && to_crlf < "$path" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$path" 2>/dev/null && converted+=("$path") || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
done < <(git ls-files --eol -z -c -o --exclude-standard 2>/dev/null)

# A converted tracked file whose index stat was recorded from an LF worktree
# would show "modified" with an empty diff. Re-record its stat, but only when
# its cleaned content equals the index blob, so real edits are never staged.
refresh=()
for path in ${converted[@]+"${converted[@]}"}; do
  staged=$(git rev-parse -q --verify ":0:$path" 2>/dev/null) || continue
  [ "$(git hash-object --path="$path" -- "$path" 2>/dev/null)" = "$staged" ] && refresh+=("$path")
done
# Fails harmlessly (e.g. index.lock held); the file then just stays "modified".
[ ${#refresh[@]} -eq 0 ] || printf '%s\0' "${refresh[@]}" | git update-index -z --stdin >/dev/null 2>&1
exit 0
