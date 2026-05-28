#!/usr/bin/env bash
# design-lint.sh — Validates design documents and plans for completeness
# Checks against the 12 architectural concerns and required sections.
#
# Usage:
#   tools/design-lint.sh docs/plans/2026-03-07-feature-design.md
#   tools/design-lint.sh docs/plans/2026-03-07-feature-plan.md

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() { ((PASS_COUNT++)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { ((FAIL_COUNT++)); echo -e "  ${RED}MISS${NC} $1"; }
warn() { ((WARN_COUNT++)); echo -e "  ${YELLOW}WARN${NC} $1"; }

check_section() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  local required="${4:-true}"

  if grep -qiE "$pattern" "$file" 2>/dev/null; then
    pass "$label"
  elif [ "$required" = "true" ]; then
    fail "$label"
  else
    warn "$label (optional)"
  fi
}

if [ $# -eq 0 ]; then
  echo "Usage: tools/design-lint.sh <path-to-document.md>"
  echo ""
  echo "Validates design docs and implementation plans for completeness."
  exit 1
fi

FILE="$1"

if [ ! -f "$FILE" ]; then
  echo -e "${RED}File not found: $FILE${NC}"
  exit 1
fi

FILENAME=$(basename "$FILE")
LINE_COUNT=$(wc -l < "$FILE" | tr -d ' ')

echo -e "${BOLD}Design Lint — $FILENAME ($LINE_COUNT lines)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Detect document type
IS_DESIGN=false
IS_PLAN=false
if echo "$FILENAME" | grep -qi 'design\|rfc\|architecture'; then
  IS_DESIGN=true
fi
if echo "$FILENAME" | grep -qi 'plan\|implementation\|impl'; then
  IS_PLAN=true
fi
if ! $IS_DESIGN && ! $IS_PLAN; then
  # Default: check as design
  IS_DESIGN=true
fi

# ─── Common Sections ───
echo -e "\n${BOLD}Required Sections${NC}"

check_section "$FILE" "problem.statement|problem|motivation|why|background" "Problem Statement"
check_section "$FILE" "overview|summary|goal|objective" "Overview / Goal"

# ─── Design-Specific Checks ───
if $IS_DESIGN; then
  echo -e "\n${BOLD}Design Doc Sections${NC}"

  check_section "$FILE" "alternative|option [abc123]|approach [abc123]|considered|comparison|trade.?off" "Alternatives / Options Considered"
  check_section "$FILE" "recommend|decision|chosen|selected approach" "Decision / Recommendation"
  check_section "$FILE" "architect|diagram|component|data.flow|sequence" "Architecture / Data Flow"
  check_section "$FILE" "scope|non.goal|out.of.scope|not.included|boundary" "Scope Boundary" "false"

  echo -e "\n${BOLD}12 Architectural Concerns${NC}"
  echo -e "  (Mark N/A with justification if not applicable)\n"

  # Structural
  check_section "$FILE" "tenant.isolation|tenantId|multi.tenant" "1. Tenant isolation"
  check_section "$FILE" "data.access|repository|persistence|storage|database|model" "2. Data access pattern"
  check_section "$FILE" "api.contract|request|response|endpoint|REST|schema" "3. API contract"
  check_section "$FILE" "security|auth|encryption|validation|SSRF|OWASP" "4. Security surface"

  # Behavioral
  check_section "$FILE" "error|failure|exception|fault" "5. Error model"
  check_section "$FILE" "failure.mode|circuit.breaker|timeout|retry|fallback|resilience" "6. Failure modes"
  check_section "$FILE" "idempoten|dedup|retry.safe|at.least.once|exactly.once" "7. Idempotency" "false"
  check_section "$FILE" "observ|trace|log|monitor|metric|telemetry|dashboard" "8. Observability"

  # Operational
  check_section "$FILE" "performance|latency|throughput|benchmark|budget|SLA" "9. Performance budget" "false"
  check_section "$FILE" "migrat|strangler|feature.flag|rollout|cutover|backward" "10. Migration path"
  check_section "$FILE" "rollback|revert|fallback|undo|recovery" "11. Rollback plan" "false"
  check_section "$FILE" "test|coverage|parity|integration.test|unit.test|TDD" "12. Test strategy"
fi

# ─── Plan-Specific Checks ───
if $IS_PLAN; then
  echo -e "\n${BOLD}Implementation Plan Sections${NC}"

  check_section "$FILE" "phase|sprint|stage|milestone|step [0-9]" "Phased Breakdown"
  check_section "$FILE" "exit.criteria|done.when|success.criteria|must.be.true|definition.of.done" "Exit Criteria"
  check_section "$FILE" "task [0-9]|task:|###.task|step [0-9]" "Task-Level Granularity"
  check_section "$FILE" "test|coverage|parity|verify|validation" "Test Strategy per Phase"
  check_section "$FILE" "rollback|revert|feature.flag|fallback" "Rollback Strategy" "false"
  check_section "$FILE" "shadow|parity|dual.run|compare|strangler" "Shadow/Parity Strategy (for refactors)" "false"

  # Check for measurable exit criteria (not just "it works" or "tests pass")
  VAGUE_CRITERIA=$(grep -niE 'exit.criteria|done.when|success.criteria' "$FILE" | grep -iE 'it works|tests pass|looks good|complete$' || true)
  if [ -n "$VAGUE_CRITERIA" ]; then
    warn "Exit criteria may be too vague — use measurable conditions (e.g., '99.5% parity', 'p95 < 200ms')"
  fi
fi

# ─── Open Questions ───
echo -e "\n${BOLD}Documentation Quality${NC}"

OPEN_QUESTIONS=$(grep -ciE 'open.question|TBD|TODO|to.be.determined|FIXME|decide.later' "$FILE" 2>/dev/null || true)
OPEN_QUESTIONS=${OPEN_QUESTIONS:-0}
if [ "$OPEN_QUESTIONS" -gt 0 ]; then
  warn "$OPEN_QUESTIONS open questions/TODOs remaining"
else
  pass "No unresolved TODOs or open questions"
fi

# Word count sanity
WORD_COUNT=$(wc -w < "$FILE" | tr -d ' ')
if [ "$WORD_COUNT" -lt 200 ]; then
  warn "Document is very short ($WORD_COUNT words) — may be incomplete"
elif [ "$WORD_COUNT" -gt 10000 ]; then
  warn "Document is very long ($WORD_COUNT words) — consider splitting"
else
  pass "Document length reasonable ($WORD_COUNT words)"
fi

# ─── Summary ───
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}Results:${NC} ${GREEN}$PASS_COUNT present${NC}, ${YELLOW}$WARN_COUNT warnings${NC}, ${RED}$FAIL_COUNT missing${NC}"

TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))
if [ "$TOTAL" -gt 0 ]; then
  SCORE=$((PASS_COUNT * 100 / TOTAL))
  echo -e "${BOLD}Completeness:${NC} ${SCORE}%"
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "\n${RED}${BOLD}Address missing sections before proceeding to implementation.${NC}"
  exit 1
else
  echo -e "\n${GREEN}${BOLD}Document passes quality gate.${NC}"
  exit 0
fi
