#!/usr/bin/env bash
# architecture-scorecard.sh — Measures architecture health metrics
# Tracks progress toward the target architecture (thin routes, layered modules, decomposed shared).
#
# Usage:
#   tools/architecture-scorecard.sh              # Full scorecard
#   tools/architecture-scorecard.sh --routes     # Route complexity only
#   tools/architecture-scorecard.sh --shared     # Shared package coupling only
#   tools/architecture-scorecard.sh --coverage   # Coverage vs targets only

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
CYAN='\033[0;36m'
NC='\033[0m'

MODE="${1:---all}"
ROUTE_FILE_PATTERN='*/route*'
TS_FILE_PATTERN='*.ts'
ROUTE_LOC_TARGET=300
ROUTE_WARN_THRESHOLD=200
ROUTE_TOP_LIMIT=20
DB_CALL_PATTERN='findOne\|findById\|\.create\b\|findOneAndUpdate\|\.aggregate\b'
ROUTE_FIND_BASE=(find apps -name "$TS_FILE_PATTERN" -path "$ROUTE_FILE_PATTERN" -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/__tests__/*')

# ─── Route Complexity ───
route_complexity() {
  echo -e "\n${BOLD}${CYAN}Route Complexity Analysis${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${BOLD}Target: All route files < ${ROUTE_LOC_TARGET} LOC${NC}\n"

  echo -e "${BOLD}Top 20 largest route/controller files:${NC}"
  printf "%-80s %s\n" "File" "Lines"
  printf "%-80s %s\n" "────" "─────"

  "${ROUTE_FIND_BASE[@]}" 2>/dev/null | while read -r f; do
    printf "%s\t%s\n" "$(wc -l < "$f" | tr -d ' ')" "$f"
  done | sort -rn -k1,1 | awk "NR <= ${ROUTE_TOP_LIMIT} { print }" | while IFS=$'\t' read -r count file; do
    if [ "$count" -gt "$ROUTE_LOC_TARGET" ]; then
      printf "  ${RED}%-78s %s${NC}\n" "$file" "$count"
    elif [ "$count" -gt "$ROUTE_WARN_THRESHOLD" ]; then
      printf "  ${YELLOW}%-78s %s${NC}\n" "$file" "$count"
    else
      printf "  ${GREEN}%-78s %s${NC}\n" "$file" "$count"
    fi
  done

  OVER_300=$("${ROUTE_FIND_BASE[@]}" 2>/dev/null -exec sh -c "lines=\$(wc -l < \"\$1\"); [ \"\$lines\" -gt ${ROUTE_LOC_TARGET} ] && echo \"\$1\"" _ {} \; | wc -l | tr -d ' ')
  TOTAL_ROUTES=$("${ROUTE_FIND_BASE[@]}" 2>/dev/null | wc -l | tr -d ' ')
  echo -e "\n  ${BOLD}Summary:${NC} $OVER_300 / $TOTAL_ROUTES route files exceed ${ROUTE_LOC_TARGET} LOC"
}

# ─── DB Calls in Routes ───
db_in_routes() {
  echo -e "\n${BOLD}${CYAN}Direct DB Access in Route Files${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${BOLD}Target: Zero direct Model.* calls in route handlers${NC}\n"

  VIOLATIONS=$("${ROUTE_FIND_BASE[@]}" 2>/dev/null -exec grep -l "$DB_CALL_PATTERN" {} \; | grep -v 'Schema' || true)

  if [ -n "$VIOLATIONS" ]; then
    echo "$VIOLATIONS" | while read -r f; do
      COUNT=$(grep -c "$DB_CALL_PATTERN" "$f" 2>/dev/null || echo "0")
      printf "  ${RED}%-78s %s calls${NC}\n" "$f" "$COUNT"
    done
    VIOLATION_COUNT=$(echo "$VIOLATIONS" | wc -l | tr -d ' ')
    echo -e "\n  ${RED}${BOLD}$VIOLATION_COUNT route files have direct DB access${NC}"
  else
    echo -e "  ${GREEN}No direct DB calls in route files${NC}"
  fi
}

# ─── Shared Package Coupling ───
shared_coupling() {
  echo -e "\n${BOLD}${CYAN}Shared Package Coupling${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${BOLD}Target: shared-kernel has zero database dependency${NC}\n"

  echo "  Imports of @agent-platform/shared per app:"
  for app in apps/runtime apps/studio apps/search-ai apps/admin; do
    if [ -d "$app" ]; then
      COUNT=$(grep -r '@agent-platform/shared' "$app/src" --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ' || true)
      printf "    %-40s %s imports\n" "$app" "$COUNT"
    fi
  done

  echo ""
  echo "  Shared package dependencies (from package.json):"
  if [ -f packages/shared/package.json ]; then
    INTERNAL_DEPS=$(grep -o '"@agent-platform/[^"]*"' packages/shared/package.json 2>/dev/null || echo "none")
    echo "    Internal: $INTERNAL_DEPS"
    if echo "$INTERNAL_DEPS" | grep -q 'database'; then
      echo -e "    ${RED}${BOLD}shared still depends on @agent-platform/database${NC}"
    fi
  fi

  echo ""
  echo "  Shared package file count:"
  SHARED_FILES=$(find packages/shared/src -name '*.ts' -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
  echo "    $SHARED_FILES TypeScript files in packages/shared/src/"
}

# ─── Coverage vs Targets ───
coverage_targets() {
  echo -e "\n${BOLD}${CYAN}Coverage vs Targets${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ ! -f coverage-thresholds.json ]; then
    echo -e "  ${YELLOW}coverage-thresholds.json not found${NC}"
    return
  fi

  echo -e "  ${BOLD}Current thresholds (from coverage-thresholds.json):${NC}"
  printf "  %-35s %-10s %-10s %s\n" "Package" "Lines" "Branches" "Target Lines"
  printf "  %-35s %-10s %-10s %s\n" "───────" "─────" "────────" "────────────"

  # Parse and display using python3 (available on macOS)
  python3 -c "
import json

targets = {
    'apps/runtime': 35, 'apps/studio': 30, 'apps/search-ai': 45,
    'apps/search-ai-runtime': 55, 'packages/compiler': 80,
    'packages/database': 60, 'packages/core': 75, 'packages/project-io': 90,
}

with open('coverage-thresholds.json') as f:
    data = json.load(f)

for key, val in data.items():
    if isinstance(val, dict) and 'lines' in val:
        lines = val['lines']
        branches = val.get('branches', '?')
        target = targets.get(key, '?')
        if target != '?' and lines >= target:
            color = '\033[0;32m'  # green
        elif target != '?' and lines >= target // 2:
            color = '\033[0;33m'  # yellow
        else:
            color = '\033[0;31m'  # red
        target_str = f'{target}%' if target != '?' else '?'
        print(f'  {color}{key:<35} {lines}%{\"\":<8} {branches}%{\"\":<8} {target_str}\033[0m')
" 2>/dev/null || echo "  (python3 required to parse thresholds)"
}

# ─── Runtime Executor Size ───
executor_size() {
  echo -e "\n${BOLD}${CYAN}Runtime Executor Consolidation Progress${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${BOLD}Target: runtime-executor.ts < 1,500 LOC${NC}\n"

  for f in \
    "apps/runtime/src/services/runtime-executor.ts" \
    "apps/runtime/src/services/execution/flow-step-executor.ts"; do
    if [ -f "$f" ]; then
      LINES=$(wc -l < "$f" | tr -d ' ')
      if [ "$LINES" -gt 2000 ]; then
        COLOR=$RED
      elif [ "$LINES" -gt 1500 ]; then
        COLOR=$YELLOW
      else
        COLOR=$GREEN
      fi
      printf "  ${COLOR}%-70s %s LOC${NC}\n" "$f" "$LINES"
    fi
  done

  # Check for new sub-executors (signs of delegation progress)
  echo ""
  echo "  Delegated sub-executors found:"
  for executor in gather-executor constraint-executor complete-executor handoff-executor delegate-executor reasoning-executor flow-executor; do
    FOUND=$(find apps/runtime packages/compiler -name "$executor.ts" -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null | head -1)
    if [ -n "$FOUND" ]; then
      LINES=$(wc -l < "$FOUND" | tr -d ' ')
      printf "    ${GREEN}%-50s %s LOC${NC}\n" "$executor" "$LINES"
    else
      printf "    ${YELLOW}%-50s not yet created${NC}\n" "$executor"
    fi
  done
}

# ─── Run Selected Sections ───
echo -e "${BOLD}Architecture Scorecard${NC}"
echo -e "Generated: $(date '+%Y-%m-%d %H:%M')\n"

case "$MODE" in
  --routes)   route_complexity; db_in_routes ;;
  --shared)   shared_coupling ;;
  --coverage) coverage_targets ;;
  --all)
    route_complexity
    db_in_routes
    shared_coupling
    coverage_targets
    executor_size
    ;;
  *)
    echo "Usage: tools/architecture-scorecard.sh [--all|--routes|--shared|--coverage]"
    exit 1
    ;;
esac

echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}Run regularly to track simplification progress.${NC}"
