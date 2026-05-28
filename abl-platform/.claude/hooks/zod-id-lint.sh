#!/bin/bash
#
# Claude Code PreToolUse hook: warn when writing Zod ID format validators
# that don't match our data formats.
#
# Our IDs are UUIDs or custom strings (proj-*, tenant-*, etc.), never CUIDs.
# Common AI mistake: using .cuid() because it "looks right" for ID fields.
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

# Check for banned Zod validators
if echo "$CONTENT" | grep -qE '\.(cuid|cuid2|nanoid|ulid)\('; then
  MATCHED=$(echo "$CONTENT" | grep -oE '\.(cuid|cuid2|nanoid|ulid)\(' | head -3)
  echo ""
  echo "⚠️ Zod ID format mismatch detected: $MATCHED"
  echo ""
  echo "This codebase uses z.string().min(1) for ID fields."
  echo "Project IDs are UUIDs or custom strings (proj-*, tenant-*), not CUIDs/NANOIDs."
  echo "Change to: z.string().min(1)"
  exit 2
fi

exit 0
