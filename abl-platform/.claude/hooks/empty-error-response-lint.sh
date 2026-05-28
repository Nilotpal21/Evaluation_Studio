#!/usr/bin/env bash
# empty-error-response-lint.sh — Warns on empty error responses in route handlers
#
# CLAUDE.md rule: "Return { success, data?, error?: { code, message } } on failure — not {}"

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL" = "Write" ]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
else
  exit 0
fi

[ -z "$FILE" ] && exit 0

# Only check route/controller files
case "$FILE" in
  */routes/*|*/controllers/*|*/handlers/*|*/api/*)
    ;;
  *)
    exit 0
    ;;
esac

# Skip test files
case "$FILE" in
  *__tests__/*|*.test.*|*.spec.*|*/test/*)
    exit 0
    ;;
esac

# Check for empty error responses: return {}, res.json({}), res.send({})
VIOLATIONS=$(echo "$CONTENT" | grep -nE '(return\s+\{\s*\}|res\.(json|send)\(\s*\{\s*\}\s*\))' 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  COUNT=$(echo "$VIOLATIONS" | wc -l | tr -d ' ')
  echo "WARNING: $COUNT empty response(s) found — use { success, error: { code, message } } format."
  echo "  File: $FILE"
  echo ""
  echo "  Violations:"
  echo "$VIOLATIONS" | head -5
  exit 0
fi

exit 0
