#!/bin/bash
#
# Claude Code PreToolUse hook: ban bare mongoose.model() without HMR guard.
#
# In Next.js dev mode, hot reload re-executes module code. A bare
# mongoose.model('Name', schema) call will throw OverwriteModelError
# on the second execution.
#
# Correct:   mongoose.models.Foo || mongoose.model('Foo', FooSchema)
# Banned:    mongoose.model('Foo', FooSchema)  — no HMR guard
#
# Safe (retrieval-only, no schema arg): mongoose.model(name)
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

[ -z "$CONTENT" ] && exit 0

# Skip test files
FILE_PATH=""
if [ "$TOOL" = "Write" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
elif [ "$TOOL" = "Edit" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
fi

case "$FILE_PATH" in
  *__tests__*|*.test.*|*.spec.*) exit 0 ;;
esac

# Check for mongoose.model( with a schema argument (2+ args) but without
# mongoose.models. on the same line. A retrieval-only call like
# mongoose.model(name) (single arg, no schema) is safe — it just looks
# up an already-registered model.
#
# Heuristic: if the line has mongoose.model('Name', <schema>) with a comma,
# it's a registration call and must be guarded.

BARE_CALLS=$(echo "$CONTENT" | grep -n 'mongoose\.model(' | grep -v 'mongoose\.models\.' | grep ',' || true)

if [ -n "$BARE_CALLS" ]; then
  echo ""
  echo "Bare mongoose.model() detected (missing HMR guard):"
  echo "$BARE_CALLS"
  echo ""
  echo "In Next.js dev mode, hot reload re-executes modules."
  echo "Use: mongoose.models.Name || mongoose.model('Name', schema)"
  exit 2
fi

exit 0
