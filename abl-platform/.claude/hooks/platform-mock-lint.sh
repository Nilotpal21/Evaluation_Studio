#!/bin/bash
#
# Claude Code PreToolUse hook: prevent mocking platform components in ANY test.
#
# vi.mock / jest.mock of internal packages (@agent-platform/*, @abl/*) or
# relative imports (../) is forbidden. Only external third-party packages
# (ai, openai, stripe, etc.) may be mocked.
#
# BLOCKS (exit 1) on vi.mock/jest.mock of internal packages in any test file.
# WARNS  (exit 2) on vi.mock/jest.mock of relative paths (../) in any test file.
#
# Incident: agent wrote tenant-models-error-format.test.ts with 11 vi.mock
# calls — repos, middleware, auth, encryption, observability — hiding real
# integration bugs. Fix was extracting provider-cache.ts (zero behavior change).
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check test files
if ! echo "$FILE_PATH" | grep -qiE '\.(test|spec)\.(ts|tsx)$'; then
  exit 0
fi

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Skip if no mock calls at all (fast path)
if ! echo "$CONTENT" | grep -qE '(vi\.mock|jest\.mock)\('; then
  exit 0
fi

BLOCK_VIOLATIONS=""
WARN_VIOLATIONS=""

# -----------------------------------------------------------------------
# Rule 1: BLOCK — No mocking @agent-platform/* packages
# -----------------------------------------------------------------------
AP_MOCKS=$(echo "$CONTENT" | grep -oE "(vi|jest)\.mock\(['\"]@agent-platform/[^'\"]*['\"]" | head -5)
if [ -n "$AP_MOCKS" ]; then
  BLOCK_VIOLATIONS="${BLOCK_VIOLATIONS}\n  [BLOCKED] Mocking @agent-platform/* packages is forbidden."
  BLOCK_VIOLATIONS="${BLOCK_VIOLATIONS}\n  Found: $AP_MOCKS"
  BLOCK_VIOLATIONS="${BLOCK_VIOLATIONS}\n  Fix the code to be testable without mocks — extract pure functions, use DI.\n"
fi

# -----------------------------------------------------------------------
# Rule 2: BLOCK — No mocking @abl/* packages
# -----------------------------------------------------------------------
ABL_MOCKS=$(echo "$CONTENT" | grep -oE "(vi|jest)\.mock\(['\"]@abl/[^'\"]*['\"]" | head -5)
if [ -n "$ABL_MOCKS" ]; then
  BLOCK_VIOLATIONS="${BLOCK_VIOLATIONS}\n  [BLOCKED] Mocking @abl/* packages is forbidden."
  BLOCK_VIOLATIONS="${BLOCK_VIOLATIONS}\n  Found: $ABL_MOCKS"
  BLOCK_VIOLATIONS="${BLOCK_VIOLATIONS}\n  Fix the code to be testable without mocks — extract pure functions, use DI.\n"
fi

# -----------------------------------------------------------------------
# Rule 3: WARN — Mocking relative imports (../) is suspicious
# -----------------------------------------------------------------------
REL_MOCKS=$(echo "$CONTENT" | grep -oE "(vi|jest)\.mock\(['\"]\.\.?/[^'\"]*['\"]" | head -5)
if [ -n "$REL_MOCKS" ]; then
  WARN_VIOLATIONS="${WARN_VIOLATIONS}\n  [WARNING] Mocking relative imports is discouraged."
  WARN_VIOLATIONS="${WARN_VIOLATIONS}\n  Found: $REL_MOCKS"
  WARN_VIOLATIONS="${WARN_VIOLATIONS}\n  If the code isn't testable without mocks, refactor it."
  WARN_VIOLATIONS="${WARN_VIOLATIONS}\n  Extract pure functions, break dependency chains, use DI.\n"
fi

# -----------------------------------------------------------------------
# Exit
# -----------------------------------------------------------------------
if [ -n "$BLOCK_VIOLATIONS" ]; then
  echo ""
  echo "Platform mock violation in: $FILE_PATH"
  echo ""
  echo -e "$BLOCK_VIOLATIONS"
  echo "Rule: NEVER mock platform components (@agent-platform/*, @abl/*)."
  echo "Only external third-party packages may be mocked (ai, openai, stripe, etc.)."
  echo "If code isn't testable without mocks, refactor the code — not the test."
  echo ""
  echo "See CLAUDE.md 'Test Architecture — Fix the Code, Not the Test'."
  exit 1
fi

if [ -n "$WARN_VIOLATIONS" ]; then
  echo ""
  echo "Platform mock warning in: $FILE_PATH"
  echo ""
  echo -e "$WARN_VIOLATIONS"
  echo "Hint: Extract the logic into a pure function and test that directly."
  echo "See CLAUDE.md 'Test Architecture — Fix the Code, Not the Test'."
  exit 2
fi

exit 0
