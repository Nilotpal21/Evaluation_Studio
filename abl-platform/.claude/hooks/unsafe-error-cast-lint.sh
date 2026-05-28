#!/bin/bash
#
# Claude Code PreToolUse hook: warn when writing unsafe error type casts
# like (err as Error).message that crash on non-Error throws.
#
# Use: err instanceof Error ? err.message : String(err)
# See CLAUDE.md Key Rules.
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

# Check for unsafe error casts: (varname as Error).property
# Catches .message, .name, .stack, .cause, and any other property access
# Matches any variable name pattern (err, error, e, ex, _err, etc.)
if echo "$CONTENT" | grep -qE '\([a-zA-Z_][a-zA-Z0-9_]* as Error\)\.[a-zA-Z]+'; then
  MATCHED=$(echo "$CONTENT" | grep -oE '\([a-zA-Z_][a-zA-Z0-9_]* as Error\)\.[a-zA-Z]+' | head -3)
  echo ""
  echo "Unsafe error type cast detected: $MATCHED"
  echo ""
  echo "Banned pattern: (err as Error).property"
  echo "This crashes if the caught value is not an Error instance (e.g., string, object)."
  echo ""
  echo "Use instead:"
  echo "  err instanceof Error ? err.message : String(err)"
  echo ""
  echo "See CLAUDE.md Key Rules."
  exit 2
fi

exit 0
