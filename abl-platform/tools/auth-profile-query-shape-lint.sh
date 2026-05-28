#!/usr/bin/env bash
# auth-profile-query-shape-lint.sh
# CI mirror of .claude/hooks/auth-profile-query-shape-lint.sh
#
# CK-1 / TI-1 (auth-profiles HLD): every `AuthProfile.find / findOne /
# findById` call outside `packages/database/` MUST include `tenantId` in the
# filter. Defense in depth against cross-tenant leaks (GAP-7 incident class).
#
# This script is the CI-side enforcement so `git commit --no-verify` cannot
# bypass the PreToolUse hook. It scans the full source tree (apps/ +
# packages/) and fails if any TypeScript file outside `packages/database/`
# and outside test directories has an offending call shape.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

FAIL_COUNT=0

is_enforced_file() {
  local file="$1"
  [[ "$file" =~ \.(ts|tsx)$ ]] || return 1
  [[ "$file" == *"/node_modules/"* ]] && return 1
  [[ "$file" == *"/dist/"* ]] && return 1
  [[ "$file" == *"/packages/database/"* ]] && return 1
  [[ "$file" == *"/__tests__/"* ]] && return 1
  [[ "$file" == *".test.ts" ]] && return 1
  [[ "$file" == *".test.tsx" ]] && return 1
  [[ "$file" == *".spec.ts" ]] && return 1
  [[ "$file" == *".spec.tsx" ]] && return 1
  return 0
}

# Use `git ls-files` so we honour .gitignore and stay reproducible across
# clean and dirty trees. Fall back to find when not in a git tree (rare).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  FILES=$(git ls-files 'apps/**/*.ts' 'apps/**/*.tsx' 'packages/**/*.ts' 'packages/**/*.tsx')
else
  FILES=$(find apps packages -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null)
fi

# AWK pass: for each AuthProfile.(find|findOne|findById)( occurrence, examine
# the next 3 lines (4-line window total) for `tenantId`. Emit the offending
# location if not found.
report_violations() {
  # Same scope-restriction rule as the PreToolUse mirror: only inline-literal
  # filters (`AuthProfile.find({ ... })`) are evaluated. Bare-variable forms
  # (`AuthProfile.find(filter)`) require whole-function analysis and would
  # produce false positives that drown the signal. An explicit
  # `// AUTH-PROFILE-QUERY-SHAPE-OK: <reason>` comment on the line preceding
  # the query suppresses the warning for legitimate admin / scanner code.
  local file="$1"
  awk -v file="$file" '
    BEGIN { window_size = 4; prev = "" }
    /AuthProfile\.(find|findOne|findById)\(/ {
      buf = $0
      match_line = NR
      for (i = 1; i <= window_size - 1; i++) {
        if ((getline next_line) > 0) {
          buf = buf "\n" next_line
        } else {
          break
        }
      }
      # Honour the explicit suppression marker when the prior line carries it.
      if (prev ~ /AUTH-PROFILE-QUERY-SHAPE-OK/) {
        prev = $0
        next
      }
      if (buf ~ /\.(find|findOne|findById)\(\s*\{/ && buf !~ /tenantId/) {
        printf "%s:%d: AuthProfile query without tenantId in filter\n", file, match_line
        printf "  %s\n", buf
        printf "\n"
        violations++
      }
    }
    { prev = $0 }
    END { exit (violations > 0 ? 1 : 0) }
  ' "$file"
}

while IFS= read -r file; do
  [ -z "$file" ] && continue
  is_enforced_file "$file" || continue
  if ! report_violations "$file"; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done <<< "$FILES"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "===================================================================="
  echo "BLOCKED: $FAIL_COUNT file(s) contain AuthProfile queries without"
  echo "tenantId. CK-1 / TI-1 mandates tenant scoping on every name-based or"
  echo "ID-based query outside packages/database/. See:"
  echo "  - docs/specs/auth-profiles.hld.md §CK-1, §TI-1"
  echo "  - .claude/hooks/auth-profile-query-shape-lint.sh (PreToolUse mirror)"
  echo "===================================================================="
  exit 1
fi

echo "auth-profile query-shape lint: OK ($(echo "$FILES" | wc -l) files scanned)"
exit 0
