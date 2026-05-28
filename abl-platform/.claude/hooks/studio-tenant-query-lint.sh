#!/bin/bash
#
# Claude Code PreToolUse hook: warn when Studio server code writes Mongoose-style
# queries without an explicit tenantId or an approved project-join helper.
#
# Studio route handlers do not have AsyncLocalStorage tenant injection, so direct
# queries must carry tenantId explicitly unless the code is using a verified
# project join such as findProjectByIdAndTenant() / requireProjectAccess().
#
# WARNING only (exit 2) — heuristic may have false positives.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if ! echo "$FILE_PATH" | grep -q 'apps/studio/src/'; then
  exit 0
fi

if echo "$FILE_PATH" | grep -q '/__tests__/'; then
  exit 0
fi

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

QUERY_PATTERN='[A-Z][A-Za-z0-9_]*\.(findOne|findOneAndUpdate|findOneAndDelete|find|updateOne|deleteOne|countDocuments|aggregate)\('
if ! echo "$CONTENT" | grep -qE "$QUERY_PATTERN"; then
  exit 0
fi

if echo "$CONTENT" | grep -q 'tenantId'; then
  exit 0
fi

if echo "$CONTENT" | grep -qE 'findProjectByIdAndTenant\(|requireProjectAccess\(|requireProjectPermission\('; then
  exit 0
fi

MATCHED=$(echo "$CONTENT" | grep -oE "$QUERY_PATTERN" | head -3)
echo ""
echo "Studio tenant-isolation warning: query may be missing tenantId"
echo ""
echo "Detected Mongoose-style queries: $MATCHED"
echo "File: $FILE_PATH"
echo ""
echo "Studio routes and repos must pass tenantId explicitly because Studio does not"
echo "register a tenant AsyncLocalStorage provider for Mongoose queries."
echo ""
echo "Allowed patterns:"
echo "  Model.findOne({ _id, tenantId, ... })"
echo "  Verified project join via findProjectByIdAndTenant() / requireProjectAccess()"
echo ""
echo "See AGENTS.md Studio Route Handler Gotchas."
exit 2
