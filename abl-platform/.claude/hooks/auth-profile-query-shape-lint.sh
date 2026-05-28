#!/bin/bash
#
# Claude Code PreToolUse hook: BLOCK AuthProfile queries that omit tenantId.
#
# CK-1 / TI-1 contract (auth-profiles HLD): every AuthProfile.find / findOne /
# findById call outside packages/database/ MUST include `tenantId` in the
# filter. A query that omits tenantId can cross-tenant leak — defense in
# depth against the GAP-7 incident class.
#
# Heuristic: if the file content contains a call like
#   AuthProfile.findOne(...
# whose argument doesn't mention `tenantId` within the next ~3 lines of
# source, the hook fails the edit. The 3-line window catches the common
# multi-line filter object pattern.
#
# Exit codes:
#   0 — pass (or non-applicable)
#   2 — block
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only enforce on TypeScript source files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip when the file lives inside packages/database — the model owns its
# canonical filters and is allowed to enumerate without tenantId.
if echo "$FILE_PATH" | grep -qE '(^|/)packages/database/'; then
  exit 0
fi

# Tests can legitimately mock AuthProfile in ways that don't carry tenantId
# (mock fixtures, non-production sandboxes). Production correctness still
# applies, so we only skip files explicitly inside __tests__ directories.
if echo "$FILE_PATH" | grep -qE '(^|/)__tests__/|(^|/)test/|\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$'; then
  exit 0
fi

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Cheap escape if the call shape isn't even present.
if ! echo "$CONTENT" | grep -qE '\bAuthProfile\.(find|findOne|findById)\b'; then
  exit 0
fi

# Operators may add `// AUTH-PROFILE-QUERY-SHAPE-OK: <reason>` immediately
# before a query that is intentionally cross-tenant (admin scans, rotation
# jobs). The lint honours that suppression so the surrounding edit isn't
# blocked.
SUPPRESSION_REGEX='AUTH-PROFILE-QUERY-SHAPE-OK'

# Only inline-literal filters are checkable from a single edit window
# (`AuthProfile.find({ ... })`). Bare-variable filters (`AuthProfile.find(filter)`)
# build their predicate upstream and require IDE-grade analysis to validate;
# the CI mirror is the right place for a broader sweep.
#
# For each `AuthProfile.<find|findOne|findById>(` followed immediately by an
# opening brace `{` (allowing line breaks), look at the next 3 lines for
# `tenantId`. If a single occurrence has no `tenantId` in its window, block
# the edit.
VIOLATION=""
PREV_LINE=""
while IFS= read -r line; do
  if echo "$line" | grep -qE '\bAuthProfile\.(find|findOne|findById)\(\s*\{?\s*$'; then
    block="$line"
    for _ in 1 2 3; do
      if IFS= read -r nxt; then
        block="$block"$'\n'"$nxt"
      fi
    done
    # Skip if the preceding line carries an explicit suppression marker.
    if echo "$PREV_LINE" | grep -q "$SUPPRESSION_REGEX"; then
      PREV_LINE="$line"
      continue
    fi
    if echo "$block" | grep -qE '\.(find|findOne|findById)\(\s*\{' && ! echo "$block" | grep -q 'tenantId'; then
      VIOLATION=$(echo "$block" | head -4)
      break
    fi
  fi
  PREV_LINE="$line"
done <<< "$CONTENT"

if [ -n "$VIOLATION" ]; then
  echo ""
  echo "BLOCKED: AuthProfile query without tenantId in filter (CK-1 / TI-1 violation)"
  echo ""
  echo "File: $FILE_PATH"
  echo ""
  echo "Offending fragment:"
  echo "$VIOLATION" | sed 's/^/  /'
  echo ""
  echo "Every AuthProfile.find / findOne / findById call outside packages/database/"
  echo "MUST include \`tenantId\` in the filter — defense in depth against"
  echo "cross-tenant leaks (auth-profiles HLD §CK-1, §TI-1)."
  echo ""
  echo "Examples (allowed):"
  echo "  await AuthProfile.findOne({ _id: profileId, tenantId, status: 'active' })"
  echo "  await AuthProfile.find({ tenantId, \$or: [{ projectId: null }, { projectId }] })"
  echo ""
  echo "If this file legitimately needs to enumerate without a tenant scope,"
  echo "move the model touch into packages/database/ where the contract owner"
  echo "lives, or document an explicit exemption in the source comment."
  exit 2
fi

exit 0
