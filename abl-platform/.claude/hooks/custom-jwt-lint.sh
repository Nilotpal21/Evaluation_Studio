#!/usr/bin/env bash
# custom-jwt-lint.sh — BLOCKS custom JWT verification outside shared auth middleware
#
# Evidence: search-ai jwt-only-auth.ts grants admin + permissions: ['*'] to all JWT holders
# Rule: Use createUnifiedAuthMiddleware/requireAuth. Never custom token verification.

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

# Only check server code (not the shared-auth package itself, not test files)
case "$FILE" in
  */packages/shared-auth/*|*/packages/auth/*)
    # This IS the auth package — custom jwt handling is expected here
    exit 0
    ;;
  */apps/*/src/*|*/packages/*/src/*)
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

# Check for direct jwt.verify usage
JWT_VERIFY=$(echo "$CONTENT" | grep -nE '\bjwt\.verify\b' 2>/dev/null || true)

# Check for manual Authorization header parsing (common pattern for custom auth)
MANUAL_AUTH=$(echo "$CONTENT" | grep -nE "req\.(headers|header)\[?['\"]authorization['\"]" 2>/dev/null || true)
# Also check for Bearer token extraction patterns
BEARER_EXTRACT=$(echo "$CONTENT" | grep -nE "split\(['\"]Bearer\s" 2>/dev/null || true)

VIOLATIONS=""
[ -n "$JWT_VERIFY" ] && VIOLATIONS="$VIOLATIONS\n  jwt.verify:\n$JWT_VERIFY"
[ -n "$BEARER_EXTRACT" ] && VIOLATIONS="$VIOLATIONS\n  Manual Bearer extraction:\n$BEARER_EXTRACT"

if [ -n "$VIOLATIONS" ]; then
  echo "BLOCKED: Custom JWT verification detected outside shared auth middleware."
  echo "  File: $FILE"
  echo ""
  echo "  Use createUnifiedAuthMiddleware() or requireAuth() from @abl/shared-auth instead."
  echo "  Custom JWT verification creates security gaps (e.g., granting permissions: ['*'])."
  echo ""
  echo "  Violations:"
  echo -e "$VIOLATIONS"
  exit 2
fi

exit 0
