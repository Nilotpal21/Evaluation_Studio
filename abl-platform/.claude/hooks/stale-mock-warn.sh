#!/bin/bash
#
# Claude Code PreToolUse hook: warn when editing function/method signatures
# in source files without updating corresponding test files.
#
# Problem: 6+ incidents where agents changed function signatures but didn't
# update test mocks, causing 15-38 test failures each time.
#
# Behavior: When an Edit changes a function/method signature in a src/ file,
# checks if a corresponding .test.ts file exists. If it does, warns the agent
# to update test mocks too.
#
# Exit codes:
#   0 — pass (no signature changes, or no corresponding test file)
#   2 — block (signature changed, test file exists but may have stale mocks)
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Edit tool (signature changes happen via Edit, not Write)
case "$TOOL" in
  Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check TypeScript source files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip test files themselves, generated files
case "$FILE_PATH" in
  *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) exit 0 ;;
  */dist/*|*/build/*|*/node_modules/*|*.d.ts) exit 0 ;;
esac

# Only check files under src/ directories
case "$FILE_PATH" in
  */src/*) ;;
  *) exit 0 ;;
esac

OLD_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')
NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')

if [ -z "$OLD_CONTENT" ] || [ -z "$NEW_CONTENT" ]; then
  exit 0
fi

# Detect function/method signature changes:
# - Function parameter list changed: function foo(a: string) -> function foo(a: string, b: number)
# - Method signature changed
# - Interface/type property changes (affects mocks)
# - Export function/const signature changes
#
# Heuristic: Look for function/method declarations in old_string and check if
# the same function name appears with a DIFFERENT signature in new_string.

# Extract function/method names from old content
OLD_FUNCS=$(echo "$OLD_CONTENT" | grep -oE '(export\s+)?(async\s+)?function\s+[A-Za-z_][A-Za-z0-9_]*\s*\(' | \
  sed -E 's/(export\s+)?(async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/\3/' | sort -u)

# Extract method names from old content (class methods)
OLD_METHODS=$(echo "$OLD_CONTENT" | grep -oE '(public|private|protected|static|async)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(' | \
  sed -E 's/(public|private|protected|static|async)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/\2/' | sort -u)

# Extract interface/type names being modified
OLD_TYPES=$(echo "$OLD_CONTENT" | grep -oE 'export\s+(interface|type)\s+[A-Za-z_][A-Za-z0-9_]*' | \
  sed -E 's/export\s+(interface|type)\s+//' | sort -u)

ALL_OLD_SYMBOLS=$(echo -e "$OLD_FUNCS\n$OLD_METHODS\n$OLD_TYPES" | grep -v '^$' | sort -u)

if [ -z "$ALL_OLD_SYMBOLS" ]; then
  exit 0  # No function/method/type signatures in the edit
fi

# Check if the signature actually changed (symbol exists in new but with different params)
CHANGED_SYMBOLS=""
for sym in $ALL_OLD_SYMBOLS; do
  # Extract the full signature line in old and new
  OLD_SIG=$(echo "$OLD_CONTENT" | grep -E "\b${sym}\b\s*\(" | head -1)
  NEW_SIG=$(echo "$NEW_CONTENT" | grep -E "\b${sym}\b\s*\(" | head -1)

  if [ -n "$OLD_SIG" ] && [ -n "$NEW_SIG" ] && [ "$OLD_SIG" != "$NEW_SIG" ]; then
    CHANGED_SYMBOLS="$CHANGED_SYMBOLS $sym"
  fi

  # Check if a type/interface was modified (properties changed)
  OLD_TYPE_LINE=$(echo "$OLD_CONTENT" | grep -E "(interface|type)\s+${sym}\b" | head -1)
  NEW_TYPE_LINE=$(echo "$NEW_CONTENT" | grep -E "(interface|type)\s+${sym}\b" | head -1)
  if [ -n "$OLD_TYPE_LINE" ] && [ -z "$NEW_TYPE_LINE" ]; then
    CHANGED_SYMBOLS="$CHANGED_SYMBOLS $sym"
  fi
done

CHANGED_SYMBOLS=$(echo "$CHANGED_SYMBOLS" | xargs)

if [ -z "$CHANGED_SYMBOLS" ]; then
  exit 0  # Signatures didn't actually change
fi

# Find corresponding test files
# Convert src path to test path patterns:
#   apps/runtime/src/services/foo.ts -> apps/runtime/src/__tests__/services/foo.test.ts
#   packages/compiler/src/bar.ts -> packages/compiler/src/__tests__/bar.test.ts
BASENAME=$(basename "$FILE_PATH" .ts)
BASENAME="${BASENAME%.tsx}"
DIR=$(dirname "$FILE_PATH")

# Search for test files matching this source file
TEST_FILES=""
for pattern in \
  "${DIR}/__tests__/${BASENAME}.test.ts" \
  "${DIR}/__tests__/${BASENAME}.test.tsx" \
  "${DIR}/../__tests__/${BASENAME}.test.ts" \
  "${DIR}/../__tests__/$(basename "$DIR")/${BASENAME}.test.ts" \
  "${DIR}/../__tests__/$(basename "$DIR")-${BASENAME}.test.ts"; do
  if [ -f "$pattern" ]; then
    TEST_FILES="$TEST_FILES $pattern"
  fi
done

# Also search more broadly
BROAD_TEST=$(find "$(echo "$FILE_PATH" | sed 's|/src/.*|/src/__tests__|')" -name "${BASENAME}*.test.ts" 2>/dev/null | head -3)
if [ -n "$BROAD_TEST" ]; then
  TEST_FILES="$TEST_FILES $BROAD_TEST"
fi

TEST_FILES=$(echo "$TEST_FILES" | xargs -n1 2>/dev/null | sort -u | xargs)

if [ -z "$TEST_FILES" ]; then
  exit 0  # No test files found — nothing to warn about
fi

echo ""
echo "WARNING: Function/type signatures changed but test files may have stale mocks."
echo ""
echo "Changed symbols: $CHANGED_SYMBOLS"
echo "Source file: $FILE_PATH"
echo "Test files that may need updating:"
for tf in $TEST_FILES; do
  echo "  - $tf"
done
echo ""
echo "6+ incidents in this repo where signature changes broke 15-38 tests due to stale mocks."
echo "Update the corresponding test mocks/assertions to match the new signatures."
echo ""
echo "See CLAUDE.md: 'Stale mock warning' rule."
# Exit 0 (warn only) — agent may legitimately need to finish source edit before updating tests
exit 0
