#!/usr/bin/env bash
# pre-review-audit.sh — Automated pre-review checks for the ABL platform
# Catches the top recurring review findings before PR submission.
#
# Usage:
#   tools/pre-review-audit.sh                  # Check staged + unstaged changes
#   tools/pre-review-audit.sh --all            # Check entire codebase
#   tools/pre-review-audit.sh --files f1 f2    # Check specific files
#   tools/pre-review-audit.sh --new-endpoints  # Focus on new route/endpoint files only

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
fail() { ((FAIL_COUNT++)); echo -e "  ${RED}FAIL${NC} $1"; }
warn() { ((WARN_COUNT++)); echo -e "  ${YELLOW}WARN${NC} $1"; }

# Determine which files to check
get_files() {
  local mode="${1:-changed}"
  case "$mode" in
    all)
      find apps packages -name '*.ts' -not -path '*/node_modules/*' -not -path '*/__tests__/*' -not -path '*/dist/*'
      ;;
    files)
      shift
      echo "$@" | tr ' ' '\n'
      ;;
    new-endpoints)
      git diff --name-only --diff-filter=A HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' | grep -iE 'route|endpoint|controller|handler' || true
      ;;
    *)
      # Changed files (staged + unstaged)
      { git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null; } | sort -u | grep -E '\.(ts|tsx)$' || true
      ;;
  esac
}

MODE="${1:-changed}"
shift 2>/dev/null || true

if [ "$MODE" = "--all" ]; then
  FILES=$(get_files all)
elif [ "$MODE" = "--files" ]; then
  FILES=$(get_files files "$@")
elif [ "$MODE" = "--new-endpoints" ]; then
  FILES=$(get_files new-endpoints)
else
  FILES=$(get_files changed)
fi

if [ -z "$FILES" ]; then
  echo -e "${GREEN}No files to check.${NC}"
  exit 0
fi

FILE_COUNT=$(echo "$FILES" | wc -l | tr -d ' ')
echo -e "${BOLD}Pre-Review Audit — checking $FILE_COUNT files${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Tenant Isolation ───
echo -e "\n${BOLD}[1/8] Tenant & Project Isolation${NC}"

FIND_BY_ID=$(echo "$FILES" | xargs grep -n 'findById\b' 2>/dev/null | grep -v '__tests__' | grep -v '\.test\.' | grep -v 'node_modules' || true)
if [ -n "$FIND_BY_ID" ]; then
  fail "findById() used instead of findOne({_id, tenantId}):"
  echo "$FIND_BY_ID" | head -10 | sed 's/^/    /'
else
  pass "No findById() — tenant-scoped queries used"
fi

FIND_BY_ID_UPDATE=$(echo "$FILES" | xargs grep -n 'findByIdAndUpdate\|findByIdAndDelete\|findByIdAndRemove' 2>/dev/null | grep -v '__tests__' | grep -v '\.test\.' || true)
if [ -n "$FIND_BY_ID_UPDATE" ]; then
  fail "findByIdAndUpdate/Delete used — use findOneAndUpdate({_id, tenantId}):"
  echo "$FIND_BY_ID_UPDATE" | head -10 | sed 's/^/    /'
else
  pass "No findByIdAndUpdate/Delete — tenant-scoped mutations used"
fi

# ─── Auth & Security ───
echo -e "\n${BOLD}[2/8] Auth & Security${NC}"

CUSTOM_JWT=$(echo "$FILES" | xargs grep -n 'jwt\.verify\|jwt\.decode\|jsonwebtoken' 2>/dev/null | grep -v '__tests__' | grep -v 'node_modules' | grep -v 'unified-auth' | grep -v 'middleware' || true)
if [ -n "$CUSTOM_JWT" ]; then
  warn "Custom JWT usage found — should use createUnifiedAuthMiddleware:"
  echo "$CUSTOM_JWT" | head -5 | sed 's/^/    /'
else
  pass "No custom JWT verification — centralized auth used"
fi

# ─── Error Handling ───
echo -e "\n${BOLD}[3/8] Error Handling${NC}"

EMPTY_CATCH=$(echo "$FILES" | xargs grep -n '\.catch(\s*(\s*)\s*=>\s*{}\s*)' 2>/dev/null | grep -v '__tests__' || true)
EMPTY_CATCH2=$(echo "$FILES" | xargs grep -n '\.catch(\s*(\s*)\s*=>\s*{\s*})' 2>/dev/null | grep -v '__tests__' || true)
COMBINED_CATCH=$(printf '%s\n%s' "$EMPTY_CATCH" "$EMPTY_CATCH2" | sort -u | grep -v '^$' || true)
if [ -n "$COMBINED_CATCH" ]; then
  fail "Empty .catch(() => {}) swallows errors:"
  echo "$COMBINED_CATCH" | head -5 | sed 's/^/    /'
else
  pass "No swallowed errors"
fi

ERR_AS_ERROR=$(echo "$FILES" | xargs grep -n '(err as Error)\.message\|(error as Error)\.message\|(e as Error)\.message' 2>/dev/null | grep -v '__tests__' || true)
if [ -n "$ERR_AS_ERROR" ]; then
  fail "Unsafe error cast — use 'err instanceof Error ? err.message : String(err)':"
  echo "$ERR_AS_ERROR" | head -5 | sed 's/^/    /'
else
  pass "No unsafe error casts"
fi

# ─── Logging ───
echo -e "\n${BOLD}[4/8] Logging & Observability${NC}"

CONSOLE_LOG=$(echo "$FILES" | xargs grep -n 'console\.log\|console\.warn\|console\.error\|console\.info' 2>/dev/null | grep -v '__tests__' | grep -v '\.test\.' | grep -v 'node_modules' | grep -v 'apps/studio' || true)
if [ -n "$CONSOLE_LOG" ]; then
  fail "console.* in server code — use createLogger('module'):"
  echo "$CONSOLE_LOG" | head -10 | sed 's/^/    /'
else
  pass "No console.* in server code"
fi

# ─── Type Safety ───
echo -e "\n${BOLD}[5/8] Type Safety${NC}"

ANY_TYPE=$(echo "$FILES" | xargs grep -n ': any\b\|as any\b' 2>/dev/null | grep -v '__tests__' | grep -v '\.test\.' | grep -v 'node_modules' | grep -v '\.d\.ts' || true)
ANY_COUNT=$(echo "$ANY_TYPE" | grep -c . 2>/dev/null || true)
ANY_COUNT=${ANY_COUNT:-0}
if [ "$ANY_COUNT" -gt 5 ]; then
  warn "$ANY_COUNT uses of 'any' type — consider structured types:"
  echo "$ANY_TYPE" | head -5 | sed 's/^/    /'
elif [ "$ANY_COUNT" -gt 0 ]; then
  warn "$ANY_COUNT uses of 'any' type (acceptable if justified)"
else
  pass "No 'any' types found"
fi

# ─── Route Layering ───
echo -e "\n${BOLD}[6/8] Route Layering${NC}"

ROUTE_FILES=$(echo "$FILES" | grep -iE 'route|controller|handler' | grep -v '__tests__' || true)
if [ -n "$ROUTE_FILES" ]; then
  MODEL_IN_ROUTES=$(echo "$ROUTE_FILES" | xargs grep -n 'Model\.\|\.findOne\|\.create\b\|\.findOneAndUpdate\|\.aggregate\b' 2>/dev/null | grep -v 'Schema\.' || true)
  if [ -n "$MODEL_IN_ROUTES" ]; then
    warn "Direct DB calls in route files — move to service/repository layer:"
    echo "$MODEL_IN_ROUTES" | head -10 | sed 's/^/    /'
  else
    pass "No direct DB calls in route files"
  fi

  QUEUE_IN_ROUTES=$(echo "$ROUTE_FILES" | xargs grep -n 'new Queue\|queue\.add\|\.addBulk' 2>/dev/null || true)
  if [ -n "$QUEUE_IN_ROUTES" ]; then
    warn "Queue operations in route files — move to application service:"
    echo "$QUEUE_IN_ROUTES" | head -5 | sed 's/^/    /'
  else
    pass "No queue operations in route files"
  fi
else
  pass "No route files in changeset"
fi

# ─── Resource Management ───
echo -e "\n${BOLD}[7/8] Resource Management${NC}"

SYNC_FS=$(echo "$FILES" | xargs grep -n 'readFileSync\|writeFileSync\|existsSync\|mkdirSync' 2>/dev/null | grep -v '__tests__' | grep -v 'node_modules' | grep -v '\.config\.' || true)
if [ -n "$SYNC_FS" ]; then
  warn "Sync file I/O found — use fs.promises in async paths:"
  echo "$SYNC_FS" | head -5 | sed 's/^/    /'
else
  pass "No sync file I/O"
fi

# ─── Infrastructure ───
echo -e "\n${BOLD}[8/8] Infrastructure${NC}"

NEW_PACKAGES=$(git diff --name-only HEAD 2>/dev/null | grep '^packages/[^/]*/package.json$' | grep -v node_modules || true)
if [ -n "$NEW_PACKAGES" ]; then
  DOCKERFILES="apps/runtime/Dockerfile apps/search-ai/Dockerfile apps/admin/Dockerfile apps/studio/Dockerfile"
  DOCKER_CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep 'Dockerfile' || true)
  if [ -z "$DOCKER_CHANGED" ]; then
    warn "New package.json changed but no Dockerfiles updated — check COPY lines in: $DOCKERFILES"
  else
    pass "Dockerfiles updated alongside package changes"
  fi
else
  pass "No new workspace packages"
fi

# ─── Summary ───
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}Results:${NC} ${GREEN}$PASS_COUNT passed${NC}, ${YELLOW}$WARN_COUNT warnings${NC}, ${RED}$FAIL_COUNT failed${NC}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "\n${RED}${BOLD}Fix failures before submitting PR.${NC}"
  exit 1
elif [ "$WARN_COUNT" -gt 0 ]; then
  echo -e "\n${YELLOW}${BOLD}Review warnings — some may be intentional.${NC}"
  exit 0
else
  echo -e "\n${GREEN}${BOLD}All checks passed!${NC}"
  exit 0
fi
