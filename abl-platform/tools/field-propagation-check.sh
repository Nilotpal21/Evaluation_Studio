#!/bin/bash
#
# Pre-commit field-propagation check — works for ANY committer (Claude, Codex,
# Cursor, Aider, human). Reads staged diffs and warns when an exported
# interface/type gets a new property in a type-defining or cross-boundary file
# without the diff also touching the type's consumers.
#
# Companion to .claude/hooks/field-propagation-lint.sh, which only fires when
# Claude Code is editing. This script runs from .husky/pre-commit and catches
# everyone.
#
# Behavior: warn-only (exit 0). The point is to make implicit consumers
# explicit so the agent / human stops missing them. Hard-blocking would create
# false positives on legitimately additive optional fields.
#
# Skip with: SKIP_FIELD_PROPAGATION=1 git commit ...
#

if [ "${SKIP_FIELD_PROPAGATION:-0}" = "1" ]; then
  exit 0
fi

# Cross-boundary type-name pattern. Mirrors .claude/hooks/field-propagation-lint.sh.
CROSS_BOUNDARY_PATTERN='(Envelope|Metadata|Provenance|Companion|AuthProfile|ProviderConfig|ModelChain|CacheKey|SessionSource|TraceEvent|ToolCall|ToolResult|ContentBlock|ChannelConfig|Fact|MemoryRecord|WorkflowContext|ImportPlan|ExportPlan|GitDiff|PromptBundle)'

is_type_defining() {
  case "$1" in
    *.model.ts|*.schema.ts) return 0 ;;
    packages/database/src/models/*) return 0 ;;
    packages/database/src/schemas/*) return 0 ;;
    packages/types/*) return 0 ;;
    packages/shared-kernel/*) return 0 ;;
    packages/*/src/types/*|packages/*/src/types.ts) return 0 ;;
    apps/*/src/types/*|apps/*/src/types.ts) return 0 ;;
    apps/*/src/contracts/*|packages/*/src/contracts/*) return 0 ;;
  esac
  return 1
}

# Collect candidate staged files: TypeScript only, no tests, no generated.
STAGED=$(git diff --cached --name-only --diff-filter=ACM -- '*.ts' '*.tsx' 2>/dev/null | \
  grep -vE '__tests__|\.test\.|\.spec\.|/dist/|/build/|/node_modules/|\.d\.ts$|/\.next/|/\.turbo/' || true)

if [ -z "$STAGED" ]; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel)

# Track which files have already-staged-in changes so we don't re-warn the
# committer about consumers they already updated.
STAGED_SET=$(echo "$STAGED" | sort -u)

ANY_WARNING=0
WARNING_BUFFER=""

while IFS= read -r REL_FILE; do
  [ -z "$REL_FILE" ] && continue

  IS_TD=0
  if is_type_defining "$REL_FILE"; then
    IS_TD=1
  fi

  # Get the staged diff for this file.
  DIFF=$(git diff --cached -- "$REL_FILE")
  if [ -z "$DIFF" ]; then
    continue
  fi

  # Count added vs removed property-shaped lines (`+  ident: type`, `-  ident: type`).
  # If added > removed, the type body grew.
  ADDED_PROP_LINES=$(echo "$DIFF" | grep -cE '^\+[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:[[:space:]]*[^=]' || true)
  REMOVED_PROP_LINES=$(echo "$DIFF" | grep -cE '^-[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:[[:space:]]*[^=]' || true)

  ADDED_PROP_LINES=$(echo "$ADDED_PROP_LINES" | tr -d '[:space:]')
  REMOVED_PROP_LINES=$(echo "$REMOVED_PROP_LINES" | tr -d '[:space:]')
  [ -z "$ADDED_PROP_LINES" ] && ADDED_PROP_LINES=0
  [ -z "$REMOVED_PROP_LINES" ] && REMOVED_PROP_LINES=0

  if [ "$ADDED_PROP_LINES" -le "$REMOVED_PROP_LINES" ]; then
    continue
  fi

  # Extract interface/type/class names from the post-image of the file.
  POST_IMAGE=$(git show ":$REL_FILE" 2>/dev/null)
  [ -z "$POST_IMAGE" ] && continue

  TYPES=$(echo "$POST_IMAGE" | \
    grep -oE 'export[[:space:]]+(interface|type|class)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' | \
    awk '{print $NF}' | sort -u)

  if [ -z "$TYPES" ]; then
    continue
  fi

  # Decide which types to track.
  TRACKED=""
  for t in $TYPES; do
    if [ "$IS_TD" -eq 1 ]; then
      TRACKED="$TRACKED $t"
      continue
    fi
    if echo "$t" | grep -qE "$CROSS_BOUNDARY_PATTERN"; then
      TRACKED="$TRACKED $t"
    fi
  done
  TRACKED=$(echo "$TRACKED" | xargs)
  [ -z "$TRACKED" ] && continue

  # Try to extract added property names from the diff for the warning.
  ADDED_PROPS=$(echo "$DIFF" | grep -E '^\+[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:[[:space:]]*[^=]' | \
    sed -E 's/^\+[[:space:]]+([a-zA-Z_][a-zA-Z0-9_]*)\??[[:space:]]*:.*/\1/' | sort -u | xargs)

  for sym in $TRACKED; do
    # Find consumers — anything that mentions the symbol elsewhere in the repo.
    if command -v rg >/dev/null 2>&1; then
      ALL_CONSUMERS=$(rg -l --type ts -e "\\b${sym}\\b" \
        "$REPO_ROOT/apps" "$REPO_ROOT/packages" 2>/dev/null | \
        grep -v "^${REPO_ROOT}/${REL_FILE}$" | \
        grep -vE '__tests__|\.test\.|\.spec\.|/dist/|/build/|/node_modules/|\.d\.ts$' || true)
    else
      ALL_CONSUMERS=$(grep -rl --include="*.ts" --include="*.tsx" \
        --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
        --exclude-dir=.next --exclude-dir=coverage --exclude-dir=.turbo \
        -E "\b${sym}\b" \
        "$REPO_ROOT/apps" "$REPO_ROOT/packages" 2>/dev/null | \
        grep -v "^${REPO_ROOT}/${REL_FILE}$" | \
        grep -vE '__tests__|\.test\.|\.spec\.' || true)
    fi

    [ -z "$ALL_CONSUMERS" ] && continue

    # Filter out consumers that the committer already updated in this commit.
    UNSTAGED_CONSUMERS=""
    while IFS= read -r consumer; do
      [ -z "$consumer" ] && continue
      REL_CONSUMER="${consumer#$REPO_ROOT/}"
      if ! echo "$STAGED_SET" | grep -qx "$REL_CONSUMER"; then
        UNSTAGED_CONSUMERS="${UNSTAGED_CONSUMERS}${REL_CONSUMER}
"
      fi
    done <<< "$ALL_CONSUMERS"

    UNSTAGED_CONSUMERS=$(echo "$UNSTAGED_CONSUMERS" | sed '/^$/d' | head -8)
    [ -z "$UNSTAGED_CONSUMERS" ] && continue

    COUNT=$(echo "$UNSTAGED_CONSUMERS" | wc -l | xargs)
    BLOCK="
  Source: ${REL_FILE}
  Type: ${sym}
  Added properties: ${ADDED_PROPS:-(see diff)}
  Unstaged consumers (${COUNT} shown):"
    while IFS= read -r line; do
      BLOCK="${BLOCK}
    - ${line}"
    done <<< "$UNSTAGED_CONSUMERS"
    WARNING_BUFFER="${WARNING_BUFFER}${BLOCK}
"
    ANY_WARNING=1
  done
done <<< "$STAGED"

if [ "$ANY_WARNING" -eq 0 ]; then
  exit 0
fi

cat <<EOF

FIELD-PROPAGATION CHECK — informational warning.
${WARNING_BUFFER}
This commit adds properties to exported interface/type declarations. The
listed consumer files are NOT in this commit.

For each consumer above, verify one of the following:
  - It has been updated in a separate (already-merged) commit.
  - It does not need to handle the new field (internal-only / optional with
    safe default / flag-guarded). Note the reason in the commit message.
  - You will follow up with a separate commit (record the ticket).

Why this matters:
  ABLP-791 (companion metadata, 16 fix commits), ABLP-654 (provenance, 4),
  ABLP-540 (voice tier, 6), ABLP-612 (action submit envelope, 10) all started
  as schema/type additions where downstream readers silently dropped the
  field. Each cost a multi-commit hardening sweep.

This is a warning, not a block. Skip with: SKIP_FIELD_PROPAGATION=1 git commit ...
See CLAUDE.md "Cross-Boundary Field Propagation" rule.
EOF

exit 0
