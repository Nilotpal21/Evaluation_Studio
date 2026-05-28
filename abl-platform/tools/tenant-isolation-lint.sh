#!/usr/bin/env bash
# tenant-isolation-lint.sh
# Diff-aware tenant isolation checks for CI and local review.
#
# Default mode inspects added lines in the current working tree or, when clean,
# the latest commit. If no diff base is available, it falls back to a full scan.
# Use --all to scan full files directly.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="changed"
if [ "${1:-}" = "--all" ]; then
  MODE="all"
fi

FAIL_COUNT=0

is_source_file() {
  local file="$1"
  [[ "$file" =~ \.(ts|tsx)$ ]] || return 1
  [[ "$file" == *"/node_modules/"* ]] && return 1
  [[ "$file" == *"/dist/"* ]] && return 1
  [[ "$file" == *"/__tests__/"* ]] && return 1
  [[ "$file" == *".test.ts" ]] && return 1
  [[ "$file" == *".test.tsx" ]] && return 1
  [[ "$file" == *".spec.ts" ]] && return 1
  [[ "$file" == *".spec.tsx" ]] && return 1
  return 0
}

collect_changed_files() {
  local staged
  local unstaged
  local untracked
  local last_commit

  staged="$(git diff --cached --name-only -- apps packages tools .harness 2>/dev/null || true)"
  unstaged="$(git diff --name-only HEAD -- apps packages tools .harness 2>/dev/null || true)"
  untracked="$(git ls-files --others --exclude-standard -- apps packages tools .harness 2>/dev/null || true)"

  if [ -n "$staged$unstaged$untracked" ]; then
    printf '%s\n%s\n%s\n' "$staged" "$unstaged" "$untracked" | sed '/^$/d' | sort -u
    return
  fi

  if git rev-parse --verify HEAD^ >/dev/null 2>&1; then
    last_commit="$(git diff --name-only HEAD^ HEAD -- apps packages tools .harness 2>/dev/null || true)"
    if [ -n "$last_commit" ]; then
      printf '%s\n' "$last_commit" | sed '/^$/d' | sort -u
    fi
    return
  fi

  collect_all_files
}

collect_all_files() {
  find apps packages tools .harness \
    \( -path '*/node_modules/*' -o -path '*/dist/*' -o -path '*/__tests__/*' \) -prune -o \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.sh' -o -name '*.yaml' -o -name '*.yml' \) -print |
    sort -u
}

get_diff_for_file() {
  local file="$1"
  local diff=""
  diff="$(git diff --cached --unified=0 --no-color -- "$file" 2>/dev/null || true)"
  diff+=$'\n'"$(git diff --unified=0 --no-color HEAD -- "$file" 2>/dev/null || true)"

  if [ -z "$(printf '%s' "$diff" | tr -d '\n')" ] && git rev-parse --verify HEAD^ >/dev/null 2>&1; then
    diff="$(git diff --unified=0 --no-color HEAD^ HEAD -- "$file" 2>/dev/null || true)"
  fi

  printf '%s\n' "$diff"
}

scan_file() {
  local file="$1"
  local pattern="$2"

  if [ "$MODE" = "all" ] || ! git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
    grep -nE "$pattern" "$file" 2>/dev/null || true
    return
  fi

  get_diff_for_file "$file" | grep -E "^\+[^+].*${pattern}" 2>/dev/null || true
}

report_violation() {
  local title="$1"
  local details="$2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $title"
  printf '%s\n' "$details" | sed 's/^/  /'
  echo ""
}

tenant_header_allowlisted() {
  local file="$1"
  case "$file" in
    apps/search-ai/src/middleware/dev-auth.ts|apps/multimodal-service/src/routes/attachments.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

FILES=()
while IFS= read -r file; do
  FILES+=("$file")
done < <(
  if [ "$MODE" = "all" ]; then
    collect_all_files
  else
    collect_changed_files
  fi
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No files to check."
  exit 0
fi

echo "Tenant isolation lint (${MODE})"
echo "Checking ${#FILES[@]} files"
echo ""

# 1. Block new x-tenant-id request header reads in routes/middleware.
header_hits=""
for file in "${FILES[@]}"; do
  [[ "$file" == apps/*/src/routes/* || "$file" == apps/*/src/middleware/* ]] || continue
  tenant_header_allowlisted "$file" && continue
  matches="$(scan_file "$file" "req\\.headers\\[['\\\"]x-tenant-id['\\\"]\\]")"
  if [ -n "$matches" ]; then
    header_hits+="${file}"$'\n'"${matches}"$'\n'
  fi
done
if [ -n "$header_hits" ]; then
  report_violation \
    "Untrusted x-tenant-id header read in routes/middleware" \
    "$header_hits"
fi

# 2. Block new req.tenantContext! assertions in source files.
tenant_assertion_hits=""
for file in "${FILES[@]}"; do
  is_source_file "$file" || continue
  matches="$(scan_file "$file" "req\\.tenantContext!")"
  if [ -n "$matches" ]; then
    tenant_assertion_hits+="${file}"$'\n'"${matches}"$'\n'
  fi
done
if [ -n "$tenant_assertion_hits" ]; then
  report_violation \
    "New req.tenantContext! assertion" \
    "$tenant_assertion_hits"
fi

# 3. Block new Mongoose-style findById* usage.
find_by_id_hits=""
for file in "${FILES[@]}"; do
  is_source_file "$file" || continue
  matches="$(scan_file "$file" "\\b[A-Z][A-Za-z0-9_]*\\.(findById|findByIdAndUpdate|findByIdAndDelete|findByIdAndRemove)\\s*\\(")"
  if [ -n "$matches" ]; then
    find_by_id_hits+="${file}"$'\n'"${matches}"$'\n'
  fi
done
if [ -n "$find_by_id_hits" ]; then
  report_violation \
    "New findById* model call" \
    "$find_by_id_hits"
fi

# 4. Block new optional tenantId repo signatures.
optional_tenant_hits=""
for file in "${FILES[@]}"; do
  [[ "$file" == apps/*/src/repos/* || "$file" == packages/*/src/repos/* ]] || continue
  is_source_file "$file" || continue
  matches="$(scan_file "$file" "tenantId\\?:[[:space:]]*string([[:space:]]*\\||\\b)")"
  if [ -n "$matches" ]; then
    optional_tenant_hits+="${file}"$'\n'"${matches}"$'\n'
  fi
done
if [ -n "$optional_tenant_hits" ]; then
  report_violation \
    "New optional tenantId in repo signature" \
    "$optional_tenant_hits"
fi

# 5. For touched model files, require tenantIsolationPlugin whenever tenantId exists.
model_plugin_hits=""
for file in "${FILES[@]}"; do
  [[ "$file" == packages/database/src/models/*.model.ts ]] || continue
  [ -f "$file" ] || continue

  if grep -q 'tenantId' "$file" && ! grep -qE 'tenantIsolationPlugin|TENANT_PLUGIN_EXCEPTION' "$file"; then
    model_plugin_hits+="${file}"$'\n'"missing tenantIsolationPlugin for tenant-scoped model"$'\n'
    continue
  fi

  if grep -q 'tenantIsolationPlugin' "$file" && ! grep -q 'tenantId' "$file"; then
    model_plugin_hits+="${file}"$'\n'"tenantIsolationPlugin present but tenantId field missing"$'\n'
  fi
done
if [ -n "$model_plugin_hits" ]; then
  report_violation \
    "Touched model file has tenant isolation plugin mismatch" \
    "$model_plugin_hits"
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Tenant isolation lint failed with ${FAIL_COUNT} violation(s)."
  exit 1
fi

echo "Tenant isolation lint passed."
