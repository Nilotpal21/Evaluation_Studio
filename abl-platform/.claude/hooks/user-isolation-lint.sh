#!/bin/bash
#
# Claude Code PreToolUse hook: warn when writing Mongoose queries for user-owned
# resources without userId or createdBy in the filter.
#
# User-owned resources (sessions, API keys, tokens, MFA) MUST filter by
# userId/createdBy. See CLAUDE.md Core Invariant #1.
#
# WARNING only (exit 2) — heuristic may have false positives.
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

# Only check files related to user-owned resources
if ! echo "$FILE_PATH" | grep -qiE '(session|api-key|apikey|token|mfa)'; then
  exit 0
fi

# Skip test files
if echo "$FILE_PATH" | grep -qiE '(__tests__|\.test\.|\.spec\.)'; then
  exit 0
fi

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Check for Mongoose query methods
QUERY_PATTERN='\.(findOne|findOneAndUpdate|findOneAndDelete|find|updateOne|deleteOne)\('
if ! echo "$CONTENT" | grep -qE "$QUERY_PATTERN"; then
  exit 0
fi

# Check if userId or createdBy appears in the content
if echo "$CONTENT" | grep -qE '(userId|createdBy|ownerId)'; then
  exit 0
fi

MATCHED=$(echo "$CONTENT" | grep -oE '\.(findOne|findOneAndUpdate|findOneAndDelete|find|updateOne|deleteOne)\(' | head -3)
echo ""
echo "User isolation warning: query may be missing userId/createdBy in filter"
echo ""
echo "Detected Mongoose queries: $MATCHED"
echo "File: $FILE_PATH"
echo ""
echo "User-owned resources (sessions, API keys, tokens) MUST filter by"
echo "userId or createdBy to prevent cross-user access."
echo ""
echo "Example: Model.findOne({ _id, tenantId, createdBy: userId })"
echo ""
echo "See CLAUDE.md Core Invariant #1."
exit 2
