#!/bin/bash
#
# Claude Code PreToolUse hook: warn when writing Mongoose findById, findByIdAndUpdate,
# or findByIdAndDelete calls that bypass tenant isolation.
#
# These methods skip tenant filtering. Use findOne({_id, tenantId}) etc. instead.
# See CLAUDE.md Core Invariants.
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

# Check for banned Mongoose methods
if echo "$CONTENT" | grep -qE '\.findById\(|\.findByIdAndUpdate\(|\.findByIdAndDelete\('; then
  MATCHED=$(echo "$CONTENT" | grep -oE '\.findById(AndUpdate|AndDelete)?\(' | head -3)
  echo ""
  echo "Tenant isolation violation detected: $MATCHED"
  echo ""
  echo "Banned methods: findById(), findByIdAndUpdate(), findByIdAndDelete()"
  echo "These bypass tenant filtering and violate security requirements."
  echo ""
  echo "Use instead:"
  echo "  findOne({ _id, tenantId })        instead of findById()"
  echo "  findOneAndUpdate({ _id, tenantId }) instead of findByIdAndUpdate()"
  echo "  findOneAndDelete({ _id, tenantId }) instead of findByIdAndDelete()"
  echo ""
  echo "See CLAUDE.md Core Invariants."
  exit 2
fi

exit 0
