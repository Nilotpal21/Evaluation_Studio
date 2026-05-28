#!/bin/bash
#
# Claude Code PreToolUse hook: warn when a diff adds a field to an exported
# interface/type without touching the files that consume it.
#
# Problem: ABLP-791 (companion metadata), ABLP-654 (provenance metadata tail),
# ABLP-540 (voice tier), ABLP-612 (action submit envelope) all had the same
# shape: a value was added at one layer (schema / type) but downstream readers
# (serializers, git export, studio prefill, SDK contracts) silently dropped it.
# The hardening sweeps that followed cost dozens of fix commits each.
#
# Behavior: when an Edit/Write modifies a file in a type-defining location and
# adds property-shaped lines to an exported interface/type body, this hook
# greps the repo for every file that imports or references the modified type
# name and prints them as a checklist. The agent must verify each consumer
# either updates to handle the new field or has a documented reason it does
# not need to.
#
# Exit codes:
#   0 — pass or warn-only (always exit 0; this is informational, not blocking)
#
# This is deliberately a warning, not a block. Adding a single optional field
# to a type does not always require touching every consumer. The hook's job is
# to make the implicit set of consumers explicit so the agent stops missing them.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip tests, generated files, declaration files
case "$FILE_PATH" in
  *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*__mocks__*) exit 0 ;;
  */dist/*|*/build/*|*/node_modules/*|*.d.ts|*/.next/*|*/.turbo/*) exit 0 ;;
esac

# Only apply to type-defining locations. Anywhere else, additions are local.
IS_TYPE_DEFINING=0
case "$FILE_PATH" in
  *.model.ts|*.schema.ts) IS_TYPE_DEFINING=1 ;;
  */packages/database/src/models/*) IS_TYPE_DEFINING=1 ;;
  */packages/database/src/schemas/*) IS_TYPE_DEFINING=1 ;;
  */packages/types/*) IS_TYPE_DEFINING=1 ;;
  */packages/shared-kernel/*) IS_TYPE_DEFINING=1 ;;
  */packages/*/src/types/*|*/packages/*/src/types.ts) IS_TYPE_DEFINING=1 ;;
  */src/types/*|*/src/types.ts) IS_TYPE_DEFINING=1 ;;
  */src/contracts/*) IS_TYPE_DEFINING=1 ;;
esac

# Also apply to any file that defines an exported interface/type whose name
# matches known cross-boundary value patterns. This catches in-app type files
# like apps/runtime/src/services/.../action-envelope.ts.
CROSS_BOUNDARY_PATTERN='(Envelope|Metadata|Provenance|Companion|AuthProfile|ProviderConfig|ModelChain|CacheKey|SessionSource|TraceEvent|ToolCall|ToolResult|ContentBlock|ChannelConfig|Fact|MemoryRecord|WorkflowContext|ImportPlan|ExportPlan|GitDiff|PromptBundle)'

OLD_CONTENT=""
NEW_CONTENT=""

if [ "$TOOL" = "Edit" ]; then
  OLD_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')
  NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
elif [ "$TOOL" = "Write" ]; then
  if [ ! -f "$FILE_PATH" ]; then
    exit 0  # New file — no propagation to old consumers possible
  fi
  OLD_CONTENT=$(cat "$FILE_PATH" 2>/dev/null)
  NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
fi

if [ -z "$OLD_CONTENT" ] || [ -z "$NEW_CONTENT" ]; then
  exit 0
fi

# Extract names of exported interface/type declarations present in old_string.
# These are the candidates for "type whose body was expanded".
# Note: BSD grep/sed (macOS) does not support \s — use [[:space:]] instead.
OLD_TYPES=$(echo "$OLD_CONTENT" | grep -oE 'export[[:space:]]+(interface|type|class)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' | \
  awk '{print $NF}' | sort -u)

if [ -z "$OLD_TYPES" ] && [ "$IS_TYPE_DEFINING" -eq 0 ]; then
  exit 0
fi

# Filter to types worth tracking: anything in a type-defining file, or any type
# whose name matches a known cross-boundary pattern.
TRACKED_TYPES=""
for t in $OLD_TYPES; do
  if [ "$IS_TYPE_DEFINING" -eq 1 ]; then
    TRACKED_TYPES="$TRACKED_TYPES $t"
    continue
  fi
  if echo "$t" | grep -qE "$CROSS_BOUNDARY_PATTERN"; then
    TRACKED_TYPES="$TRACKED_TYPES $t"
  fi
done

TRACKED_TYPES=$(echo "$TRACKED_TYPES" | xargs)

if [ -z "$TRACKED_TYPES" ]; then
  exit 0
fi

# Heuristic: a type's body has grown if the new_string has more property-shaped
# lines (matching `identifier:`) than the old_string. We do this on the whole
# diff blob rather than per-type because per-type body extraction in shell is
# fragile. False positives are acceptable — this is a warning.
OLD_PROP_LINES=$(echo "$OLD_CONTENT" | grep -cE '^[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:[[:space:]]*' || echo 0)
NEW_PROP_LINES=$(echo "$NEW_CONTENT" | grep -cE '^[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:[[:space:]]*' || echo 0)

# Strip newlines from the counts (some platforms emit trailing whitespace)
OLD_PROP_LINES=$(echo "$OLD_PROP_LINES" | tr -d '[:space:]')
NEW_PROP_LINES=$(echo "$NEW_PROP_LINES" | tr -d '[:space:]')

if [ -z "$OLD_PROP_LINES" ]; then OLD_PROP_LINES=0; fi
if [ -z "$NEW_PROP_LINES" ]; then NEW_PROP_LINES=0; fi

if [ "$NEW_PROP_LINES" -le "$OLD_PROP_LINES" ]; then
  exit 0  # No new properties added (or properties were removed — that's the
          # exported-symbol-guard's job, not ours).
fi

# Identify the added property names. Cheap diff: grep property lines from each,
# subtract.
OLD_PROPS=$(echo "$OLD_CONTENT" | grep -oE '^[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:' | \
  sed -E 's/^[[:space:]]*//; s/\??[[:space:]]*:[[:space:]]*$//' | sort -u)
NEW_PROPS=$(echo "$NEW_CONTENT" | grep -oE '^[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*\??[[:space:]]*:' | \
  sed -E 's/^[[:space:]]*//; s/\??[[:space:]]*:[[:space:]]*$//' | sort -u)

ADDED_PROPS=$(comm -13 <(echo "$OLD_PROPS") <(echo "$NEW_PROPS") | xargs)

if [ -z "$ADDED_PROPS" ]; then
  exit 0
fi

# For each tracked type that still exists in new_content, look up consumers.
# Cap output to keep noise manageable.
REPO_ROOT=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(pwd)"
fi

REL_FILE="${FILE_PATH#$REPO_ROOT/}"

WARNED=0
WARNING_BUFFER=""

for sym in $TRACKED_TYPES; do
  # Confirm the symbol is still present in new_content (not renamed/removed).
  if ! echo "$NEW_CONTENT" | grep -qE "(interface|type|class)[[:space:]]+${sym}([[:space:]]|<|\{|=)"; then
    continue
  fi

  # Find consumers — files that import the symbol or destructure its shape.
  # Use ripgrep if available (faster, monorepo-aware), fall back to grep.
  if command -v rg >/dev/null 2>&1; then
    CONSUMERS=$(rg -l --type ts -e "\\b${sym}\\b" \
      "$REPO_ROOT/apps" "$REPO_ROOT/packages" 2>/dev/null | \
      grep -v "^${FILE_PATH}$" | \
      grep -vE '__tests__|\.test\.|\.spec\.|/dist/|/build/|/node_modules/|\.d\.ts$' | \
      head -8)
  else
    CONSUMERS=$(grep -rl --include="*.ts" --include="*.tsx" \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
      --exclude-dir=.next --exclude-dir=coverage --exclude-dir=.turbo \
      -E "\b${sym}\b" \
      "$REPO_ROOT/apps" "$REPO_ROOT/packages" 2>/dev/null | \
      grep -v "^${FILE_PATH}$" | \
      grep -vE '__tests__|\.test\.|\.spec\.' | \
      head -8)
  fi

  if [ -z "$CONSUMERS" ]; then
    continue
  fi

  COUNT=$(echo "$CONSUMERS" | wc -l | xargs)
  WARNING_BUFFER="${WARNING_BUFFER}
  Type: ${sym}
  Consumers (${COUNT} shown, possibly more):"
  while IFS= read -r consumer; do
    REL_CONSUMER="${consumer#$REPO_ROOT/}"
    WARNING_BUFFER="${WARNING_BUFFER}
    - ${REL_CONSUMER}"
  done <<< "$CONSUMERS"
  WARNED=1
done

if [ "$WARNED" -eq 0 ]; then
  exit 0
fi

cat <<EOF

FIELD PROPAGATION CHECK — informational warning.

File: ${REL_FILE}
Added properties: ${ADDED_PROPS}
${WARNING_BUFFER}

Why this matters:
  ABLP-791 (companion metadata), ABLP-654 (provenance), ABLP-540 (voice tier),
  ABLP-612 (action envelope) all originated as schema/type additions where
  downstream readers, serializers, or UI prefill silently dropped the new
  field. Each cost 4-16 fix commits to harden after the fact.

Required check (do this before declaring done):
  1. For each consumer above, confirm whether it must read or write the new
     field. If yes — update it in this same change.
  2. If a consumer does NOT need to handle the new field, note why (field is
     internal-only, optional with a safe default, or guarded behind a flag).
  3. Add or extend a round-trip parity test that constructs the type with the
     new property populated, sends it through the affected boundary, and
     asserts the field survives.

This hook lists consumers; only you can verify each one. It will not block
the edit, but the next agent reviewing the diff will check that you did this.

See CLAUDE.md "Cross-Boundary Field Propagation" rule and the data-flow-audit
skill (run /data-flow-audit if propagation crosses 3+ layers).
EOF

exit 0
