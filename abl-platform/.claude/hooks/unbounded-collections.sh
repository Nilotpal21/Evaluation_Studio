#!/bin/bash
#
# Claude Code PreToolUse hook: warn when new Map() or new Set() appears in
# service/package files without evidence of size management.
#
# Every in-memory Map/Set needs max size, TTL, and eviction.
# See CLAUDE.md Core Invariants.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Get the file path
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check service and package files
case "$FILE_PATH" in
  */apps/*/src/services/*.ts|*/packages/*/src/*.ts) ;;
  *) exit 0 ;;
esac

# Skip test files
case "$FILE_PATH" in
  *__tests__*|*.test.*|*.spec.*) exit 0 ;;
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Skip if no Map/Set construction
if ! echo "$CONTENT" | grep -qE 'new (Map|Set)\('; then
  exit 0
fi

# Check for evidence of size management in the content being written
# and in the existing file (for Edit operations)
FULL_CONTENT="$CONTENT"
if [ "$TOOL" = "Edit" ] && [ -f "$FILE_PATH" ]; then
  FULL_CONTENT=$(cat "$FILE_PATH")
  FULL_CONTENT="$FULL_CONTENT
$CONTENT"
fi

if echo "$FULL_CONTENT" | grep -qE 'MAX_|maxSize|\.delete\(|evict|LRU|lru|TTL|ttl|expire|cache\.clear|\.clear\('; then
  exit 0
fi

echo ""
echo "WARNING: new Map()/Set() found without evidence of size management."
echo "File: $FILE_PATH"
echo ""
echo "Every in-memory Map/Set needs max size, TTL, and eviction. See CLAUDE.md."
echo ""
echo "Add one of:"
echo "  - MAX_SIZE constant with size check before .set()"
echo "  - TTL-based eviction (setTimeout or periodic sweep)"
echo "  - LRU cache wrapper instead of raw Map"
echo "  - .delete() calls that bound the collection"
echo ""
exit 2
