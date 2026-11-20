#!/bin/sh
# PreToolUse (Bash): refuses git commit/push while on main.
cmd=$(jq -r '.tool_input.command // empty')
case "$cmd" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0 ;;
esac
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$branch" = main ]; then
  echo "Blocked: you are on main. Create a branch first." >&2
  exit 2
fi
exit 0
