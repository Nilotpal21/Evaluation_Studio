#!/bin/bash
#
# Claude Code PreToolUse hook: warn on lowercase role comparisons in Studio.
#
# Studio stores roles as uppercase ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER').
# requireAuth() passes payload.role through unchanged from the JWT/DB.
# Comparing against lowercase ('admin', 'owner') always fails.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
fi

# Only check Studio files
case "$FILE_PATH" in
  */apps/studio/*) ;;
  *) exit 0 ;;
esac

# Flag lowercase role comparisons
if echo "$CONTENT" | grep -qE "role.*===.*'(admin|owner|member|viewer)'|'(admin|owner|member|viewer)'.*===.*role"; then
  echo ""
  echo "⚠️  Lowercase role comparison detected in Studio code."
  echo ""
  echo "Studio roles are UPPERCASE: 'OWNER', 'ADMIN', 'MEMBER', 'VIEWER'"
  echo "Using lowercase ('admin', 'owner') will ALWAYS fail the check."
  echo ""
  echo "Fix: user.role === 'ADMIN' (not 'admin')"
  exit 2
fi

exit 0
