#!/bin/bash
#
# Claude Code PreToolUse hook: warn when new WebSocket() appears in React
# component files without useEffect or useRef nearby.
#
# WebSocket connections created during render cause infinite re-render loops.
# Always create WebSocket connections inside useEffect with proper cleanup.
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

# Only check React code in apps/studio/src/
case "$FILE_PATH" in
  */apps/studio/src/*.ts|*/apps/studio/src/*.tsx) ;;
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

# Skip if no WebSocket usage
if ! echo "$CONTENT" | grep -qE 'new WebSocket\('; then
  exit 0
fi

# Heuristic: check if the full file content (for Write) or nearby code (for Edit)
# also contains useEffect or useRef, which suggests proper lifecycle management.
# For Write, we check the whole file. For Edit, we can only check the new_string,
# so we also read the file if it exists.
FULL_CONTENT="$CONTENT"
if [ "$TOOL" = "Edit" ] && [ -f "$FILE_PATH" ]; then
  FULL_CONTENT=$(cat "$FILE_PATH")
  # Include the new content being written
  FULL_CONTENT="$FULL_CONTENT
$CONTENT"
fi

if echo "$FULL_CONTENT" | grep -qE 'useEffect|useRef'; then
  exit 0
fi

echo ""
echo "WARNING: new WebSocket() found in React component without useEffect/useRef."
echo "File: $FILE_PATH"
echo ""
echo "WebSocket connections created during render cause infinite re-render loops."
echo "Always create WebSocket connections inside useEffect() with proper cleanup:"
echo ""
echo "  useEffect(() => {"
echo "    const ws = new WebSocket(url);"
echo "    return () => ws.close();"
echo "  }, [url]);"
echo ""
exit 2
