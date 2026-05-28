#!/bin/bash
#
# Claude Code PreToolUse hook: guard against removing exported symbols
# that are imported/used elsewhere in the codebase.
#
# Problem: AI agents doing feature work sometimes over-aggressively delete
# types, interfaces, functions, and constants they don't think are needed,
# breaking downstream consumers across the monorepo.
#
# Incident: attachments-gap-closure phase 3 deleted ~20 type definitions
# (RuntimeAuthChallengeParams, TracerRegistry integration, etc.) causing
# 35 TypeScript errors across 8+ files in a follow-up commit.
#
# Behavior:
#   - For Edit: compares old_string vs new_string for removed exports
#   - For Write: compares current file content vs new content
#   - If removed exports are imported elsewhere, BLOCKS the edit (exit 2)
#
# Correct workflow for intentional removal:
#   1. Update or remove all consumers of the symbol FIRST
#   2. Then remove the export (hook passes once no imports remain)
#
# Exit codes:
#   0 — pass (no removed exports, or removed exports have no consumers)
#   2 — block (removed exports are still imported elsewhere)
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check TypeScript source files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip test files — tests can freely restructure exports
case "$FILE_PATH" in
  *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*__mocks__*) exit 0 ;;
esac

# Skip generated files
case "$FILE_PATH" in
  */dist/*|*/build/*|*/node_modules/*|*.d.ts) exit 0 ;;
esac

# Get old and new content based on tool type
OLD_CONTENT=""
NEW_CONTENT=""

if [ "$TOOL" = "Edit" ]; then
  OLD_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')
  NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
elif [ "$TOOL" = "Write" ]; then
  if [ ! -f "$FILE_PATH" ]; then
    exit 0  # New file — nothing being removed
  fi
  OLD_CONTENT=$(cat "$FILE_PATH" 2>/dev/null)
  NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
fi

if [ -z "$OLD_CONTENT" ]; then
  exit 0
fi

# Extract exported symbol names from a content string.
# Matches: export [default] [async] (interface|type|function|const|class|enum|let) SymbolName
extract_exports() {
  echo "$1" | grep -oE 'export\s+(default\s+)?(async\s+)?(interface|type|function|const|class|enum|let)\s+[A-Za-z_][A-Za-z0-9_]*' | \
    sed -E 's/export\s+(default\s+)?(async\s+)?(interface|type|function|const|class|enum|let)\s+//' | \
    sort -u
}

OLD_EXPORTS=$(extract_exports "$OLD_CONTENT")

if [ -z "$OLD_EXPORTS" ]; then
  exit 0  # No exports in the old content — nothing to guard
fi

NEW_EXPORTS=$(extract_exports "$NEW_CONTENT")

# Find symbols exported in old content but absent from new content
REMOVED=""
for sym in $OLD_EXPORTS; do
  # Still exported under the same name?
  if echo "$NEW_EXPORTS" | grep -qx "$sym" 2>/dev/null; then
    continue
  fi
  # Still referenced anywhere in the new content? (covers renames, re-assignments, etc.)
  if echo "$NEW_CONTENT" | grep -qw "$sym" 2>/dev/null; then
    continue
  fi
  REMOVED="$REMOVED $sym"
done

REMOVED=$(echo "$REMOVED" | xargs)

if [ -z "$REMOVED" ]; then
  exit 0
fi

# For each removed symbol, check if it's imported/re-exported in other files
VIOLATIONS=""
for sym in $REMOVED; do
  # Search for import/export statements referencing this symbol
  IMPORTERS=$(grep -rl --include="*.ts" --include="*.tsx" \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
    --exclude-dir=.next --exclude-dir=coverage --exclude-dir=.turbo \
    -E "(import|export)\s.*\b${sym}\b" \
    apps/ packages/ 2>/dev/null | grep -v "$FILE_PATH" | head -5)

  if [ -n "$IMPORTERS" ]; then
    COUNT=$(echo "$IMPORTERS" | wc -l | xargs)
    FILES=$(echo "$IMPORTERS" | head -3 | tr '\n' ', ' | sed 's/,$//')
    VIOLATIONS="${VIOLATIONS}\n  - '${sym}' imported in ${COUNT} file(s): ${FILES}"
  fi
done

if [ -z "$VIOLATIONS" ]; then
  exit 0  # Removed exports have no consumers — safe to proceed
fi

echo ""
echo "BLOCKED: Exported symbols being removed are still imported elsewhere."
echo ""
echo "Removed exports with active consumers:"
echo -e "$VIOLATIONS"
echo ""
echo "Feature work must be additive — do NOT delete existing exports that have consumers."
echo ""
echo "Correct workflow:"
echo "  1. Update or remove all consumers/imports of the symbol FIRST"
echo "  2. Then remove the export definition (this hook passes once no imports remain)"
echo ""
echo "If this is an intentional refactor (not feature work), update the importing files"
echo "before editing this file."
echo ""
echo "See CLAUDE.md: 'Export Removal Guard' rule."
exit 2
