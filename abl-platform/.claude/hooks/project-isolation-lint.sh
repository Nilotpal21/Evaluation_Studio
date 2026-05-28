#!/bin/bash
#
# Claude Code PreToolUse hook: warn when writing Mongoose queries in project-scoped
# routes without projectId in the filter.
#
# Project-scoped routes (/api/projects/:projectId/...) MUST include projectId
# in every query filter. See CLAUDE.md Core Invariant #1.
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

# Only check project-scoped route files
if ! echo "$FILE_PATH" | grep -qiE '(apps/runtime/src/routes/|apps/studio/src/app/api/projects/)'; then
  exit 0
fi

# Only check files whose path suggests project scoping
if ! echo "$FILE_PATH" | grep -qi 'project'; then
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

# Check if projectId appears near the query (within the content block)
# For Edit, the new_string is typically a small block, so checking the whole content is fine.
# For Write, we check if projectId appears in the content at all.
if echo "$CONTENT" | grep -q 'projectId'; then
  exit 0
fi

MATCHED=$(echo "$CONTENT" | grep -oE '\.(findOne|findOneAndUpdate|findOneAndDelete|find|updateOne|deleteOne)\(' | head -3)
echo ""
echo "Project isolation warning: query may be missing projectId in filter"
echo ""
echo "Detected Mongoose queries: $MATCHED"
echo "File: $FILE_PATH"
echo ""
echo "Project-scoped routes (/api/projects/:projectId/...) MUST include"
echo "projectId in every query filter to prevent cross-project access."
echo ""
echo "Example: Model.findOne({ _id, tenantId, projectId })"
echo ""
echo "See CLAUDE.md Core Invariant #1."
exit 2
