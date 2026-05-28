#!/bin/bash
#
# Claude Code PreToolUse hook: block route handlers that return empty objects
# on failure instead of structured error responses.
#
# Return `{ success: false, error: { code, message } }`, not `{}`.
# See CLAUDE.md Key Rules.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Get the file path being written
FILE_PATH=""
if [ "$TOOL" = "Write" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
elif [ "$TOOL" = "Edit" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
fi

# Only check .ts files
case "$FILE_PATH" in
  *.ts) ;;
  *) exit 0 ;;
esac

# Only check route-like paths
case "$FILE_PATH" in
  */routes/*|*/handlers/*|*/controllers/*) ;;
  *) exit 0 ;;
esac

# Skip test files
case "$FILE_PATH" in
  *.test.ts|*.spec.ts|*__tests__*) exit 0 ;;
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Check for empty response body patterns
if echo "$CONTENT" | grep -qE '(res\.(json|send)\s*\(\s*\{\s*\}\s*\)|return\s+\{\s*\})'; then
  MATCHED=$(echo "$CONTENT" | grep -oE '(res\.(json|send)\s*\(\s*\{\s*\}\s*\)|return\s+\{\s*\})' | head -3)
  echo ""
  echo "Empty response body detected: $MATCHED"
  echo ""
  echo "Empty response body detected. On failure, return \`{ success: false, error: { code, message } }\`, not \`{}\`. See CLAUDE.md Key Rules."
  exit 2
fi

exit 0
