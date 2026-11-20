#!/bin/sh
# PostToolUse (Edit|Write): applies Biome to the file just edited. Never blocks.
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in
  *.ts|*.js|*.mjs|*.cjs|*.json|*.jsonc|*.css) ;;
  *) exit 0 ;;
esac
[ -f "$f" ] || exit 0
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
npx --no-install biome check --write --no-errors-on-unmatched "$f" >/dev/null 2>&1 || true
exit 0
