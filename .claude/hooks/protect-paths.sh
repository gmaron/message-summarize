#!/bin/sh
# PreToolUse (Edit|Write): refuses writes to paths that hold real data or secrets.
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in
  */auth/*|*/data/*|*/.sandbox/out/*|*/.env|*/.env.[!e]*|*.db|*.sqlite)
    echo "Blocked: $f holds real data or secrets and must not be written from here (AGENTS.md: no real data in the repo)." >&2
    exit 2 ;;
esac
exit 0
