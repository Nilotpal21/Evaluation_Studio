#!/bin/bash
#
# Claude Code PreToolUse hook: block console.log/warn/error/info in server-side code.
#
# Server code must use createLogger('module') from @abl/compiler/platform.
# See CLAUDE.md Key Rules.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Get the file path being written/edited
FILE_PATH=""
if [ "$TOOL" = "Write" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
elif [ "$TOOL" = "Edit" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
fi

# Skip if no file path
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Skip client-side code (apps/studio/ and client-side packages)
if echo "$FILE_PATH" | grep -qE 'apps/studio/|packages/(web-sdk|admin-ui|design-tokens)/'; then
  exit 0
fi

# Skip test files (including e2e and integration test suffixes)
if echo "$FILE_PATH" | grep -qE '(__tests__|\.test\.ts|\.spec\.ts|\.e2e\.ts|\.integration\.ts)'; then
  exit 0
fi

# Skip script files
if echo "$FILE_PATH" | grep -q '/scripts/'; then
  exit 0
fi

# Only check server-side paths
SERVER_MATCH=false
for pattern in 'apps/runtime/' 'apps/admin/' 'apps/search-ai/' 'apps/workflow-engine/' 'apps/multimodal-service/' 'packages/'; do
  if echo "$FILE_PATH" | grep -q "$pattern"; then
    SERVER_MATCH=true
    break
  fi
done

if [ "$SERVER_MATCH" = false ]; then
  exit 0
fi

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Skip if no content
if [ -z "$CONTENT" ]; then
  exit 0
fi

# Check each line for console.log/warn/error/info, skipping comment lines
FOUND=""
while IFS= read -r line; do
  # Trim leading whitespace for comment detection
  trimmed=$(echo "$line" | sed 's/^[[:space:]]*//')

  # Skip comment lines (starts with // or *)
  if echo "$trimmed" | grep -qE '^(//|\*)'; then
    continue
  fi

  # Check for console.log(, console.warn(, console.error(, console.info(
  if echo "$line" | grep -qE 'console\.(log|warn|error|info)\('; then
    FOUND="$line"
    break
  fi
done <<< "$CONTENT"

if [ -n "$FOUND" ]; then
  echo ""
  echo "BLOCKED: console.log/warn/error/info detected in server-side code."
  echo ""
  echo "  $FOUND"
  echo ""
  echo "Use \`createLogger('module')\` from \`@abl/compiler/platform\` instead of console.log."
  echo "See CLAUDE.md Key Rules."
  exit 2
fi

exit 0
