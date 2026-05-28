#!/bin/bash
#
# Claude Code PreToolUse hook: warn when building cache keys that may be
# missing critical dimensions (tenantId, userId, etc.).
#
# Cache key collisions cause cross-tenant or cross-user data leakage.
# Every cache key for user-facing data should include:
# - tenantId (cross-tenant isolation)
# - userId (when credential/permission resolution is user-dependent)
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Check for cache key construction that joins multiple fields but is missing userId
# Pattern: array of fields joined into a cache key
if echo "$CONTENT" | grep -qE "\.join\(['\"][::|]"; then
  if echo "$CONTENT" | grep -qE "tenantId" && ! echo "$CONTENT" | grep -qE "userId"; then
    echo ""
    echo "WARNING: Cache key includes tenantId but not userId."
    echo ""
    echo "If this cache stores credential or permission data that differs per user"
    echo "(e.g., credential policies: user_first, user_only), the cache key must"
    echo "include userId to prevent cross-user data leakage."
    echo ""
    echo "Add userId to the cache key or document why it's safe to omit."
    # Non-blocking warning
    exit 0
  fi
fi

exit 0
