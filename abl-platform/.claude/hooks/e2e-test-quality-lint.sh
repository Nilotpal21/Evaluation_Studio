#!/bin/bash
#
# Claude Code PreToolUse hook: enforce E2E test quality rules.
#
# Test-tier rules enforced here:
# 1. E2E tests must not patch execution at all: no vi.mock/jest.mock and no
#    vi.spyOn/jest.spyOn. They must exercise the system via HTTP/API surfaces.
# 2. Integration tests may use targeted vi.spyOn/jest.spyOn assertions, but
#    must not replace whole modules with vi.mock/jest.mock.
# 3. Wiring sentinel tests (*.wiring.test.ts/tsx) may use targeted spies for
#    side-effect ordering, but must not replace whole modules with mocks.
# 4. E2E, integration, and wiring tests must not access the database directly
#    (Mongoose models, .findOne, .create, etc.).
#
# BLOCKS (exit 1) on violations in files matching e2e, integration, or wiring
# test patterns.
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

# Determine test tier
IS_E2E=false
IS_INTEGRATION=false
IS_WIRING=false
if echo "$FILE_PATH" | grep -qiE '\.wiring\.(test|spec)\.(ts|tsx)$'; then
  IS_WIRING=true
elif echo "$FILE_PATH" | grep -qiE '(e2e|end-to-end|end_to_end)'; then
  IS_E2E=true
elif echo "$FILE_PATH" | grep -qiE 'integration'; then
  IS_INTEGRATION=true
fi

# If no guarded tier, skip
if [ "$IS_E2E" = false ] && [ "$IS_INTEGRATION" = false ] && [ "$IS_WIRING" = false ]; then
  exit 0
fi

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

VIOLATIONS=""

# -----------------------------------------------------------------------
# Rule 1a: No whole-module mocks in guarded tiers
# -----------------------------------------------------------------------
MODULE_MOCK_PATTERNS='(vi\.mock\(|jest\.mock\()'
MODULE_MOCK_MATCHES=$(echo "$CONTENT" | grep -oE "$MODULE_MOCK_PATTERNS" | head -5)
if [ -n "$MODULE_MOCK_MATCHES" ]; then
  VIOLATIONS="${VIOLATIONS}\n  [NO MODULE MOCKS] E2E, integration, and wiring tests must not replace modules."
  VIOLATIONS="${VIOLATIONS}\n  Found: $MODULE_MOCK_MATCHES"
  VIOLATIONS="${VIOLATIONS}\n  Use real implementations. For integration/wiring sentinels, targeted vi.spyOn/jest.spyOn is allowed when the assertion needs a named function."
  VIOLATIONS="${VIOLATIONS}\n  If you need test doubles, inject them via DI — do not patch modules.\n"
fi

# -----------------------------------------------------------------------
# Rule 1b: No spies in E2E tests
# -----------------------------------------------------------------------
SPY_PATTERNS='(vi\.spyOn\(|jest\.spyOn\()'
SPY_MATCHES=$(echo "$CONTENT" | grep -oE "$SPY_PATTERNS" | head -5)
if [ "$IS_E2E" = true ] && [ -n "$SPY_MATCHES" ]; then
  VIOLATIONS="${VIOLATIONS}\n  [NO SPIES] E2E tests must not patch or spy on runtime components."
  VIOLATIONS="${VIOLATIONS}\n  Found: $SPY_MATCHES"
  VIOLATIONS="${VIOLATIONS}\n  E2E tests must exercise behavior through HTTP/API surfaces. Use integration or wiring tests for targeted function-spy sentinels.\n"
fi

# -----------------------------------------------------------------------
# Rule 2: No direct DB access in E2E tests
# -----------------------------------------------------------------------
DB_PATTERNS='\.(findOne|findById|findOneAndUpdate|findOneAndDelete|create|insertMany|updateOne|deleteOne|deleteMany|aggregate|countDocuments)\('
DB_MATCHES=$(echo "$CONTENT" | grep -oE "$DB_PATTERNS" | head -5)
if [ -n "$DB_MATCHES" ]; then
  VIOLATIONS="${VIOLATIONS}\n  [NO DB] E2E tests must only interact via API, never query the DB directly."
  VIOLATIONS="${VIOLATIONS}\n  Found: $DB_MATCHES"
  VIOLATIONS="${VIOLATIONS}\n  Seed data via API calls (POST endpoints), not Mongoose model methods."
  VIOLATIONS="${VIOLATIONS}\n  Assert via API responses, not DB reads.\n"
fi

# Also catch direct model imports
MODEL_IMPORT='import.*from.*models/'
MODEL_MATCHES=$(echo "$CONTENT" | grep -oE "$MODEL_IMPORT" | head -3)
if [ -n "$MODEL_MATCHES" ]; then
  VIOLATIONS="${VIOLATIONS}\n  [NO DB] E2E tests must not import Mongoose models."
  VIOLATIONS="${VIOLATIONS}\n  Found: $MODEL_MATCHES"
  VIOLATIONS="${VIOLATIONS}\n  Use API endpoints for all data operations.\n"
fi

# -----------------------------------------------------------------------
# Rule 3: No stubbed infrastructure (port = 0, TODO stubs)
# -----------------------------------------------------------------------
STUB_PATTERNS='(port[AB]?\s*=\s*0;|TODO:.*Wire up|TODO:.*Replace with actual)'
STUB_MATCHES=$(echo "$CONTENT" | grep -oE "$STUB_PATTERNS" | head -3)
if [ -n "$STUB_MATCHES" ]; then
  VIOLATIONS="${VIOLATIONS}\n  [NO STUBS] E2E tests must use real servers, not stubbed infrastructure."
  VIOLATIONS="${VIOLATIONS}\n  Found: $STUB_MATCHES"
  VIOLATIONS="${VIOLATIONS}\n  Start real servers on random ports (port: 0 → server.address().port).\n"
fi

# -----------------------------------------------------------------------
# Exit
# -----------------------------------------------------------------------
if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "E2E/Integration/Wiring test quality violation in: $FILE_PATH"
  echo ""
  echo -e "$VIOLATIONS"
  echo "Rules:"
  echo "  1. E2E tests must NOT mock or spy on components that exist in the codebase"
  echo "  2. Integration and wiring tests may use targeted spies, but must NOT use module mocks"
  echo "  3. Guarded test tiers must not access the DB directly"
  echo "  4. E2E tests must use real servers, not stubbed infrastructure"
  echo "  5. Prefer the architecturally correct solution, not the easy path"
  echo ""
  echo "See CLAUDE.md 'E2E Test Standards' and AGENTS.md 'E2E Test Principles'."

  exit 1
fi

exit 0
