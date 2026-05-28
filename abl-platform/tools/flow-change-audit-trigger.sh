#!/bin/bash
#
# Pre-commit data-flow audit trigger — works for ANY committer.
#
# A single commit that crosses multiple boundary categories (schema, types,
# routes, serializers, caches, stores, SDK, workers) is the historical
# signature of a flow feature where one layer gets updated and a downstream
# layer silently drops the new value. ABLP-791/654/540/612 all match this
# shape.
#
# Behavior: if the staged set crosses >= 2 boundary categories, and no parity
# test or data-flow-audit log is in the staged set, warn the committer and
# suggest running the existing /data-flow-audit skill. Warning only — does
# not block.
#
# Skip with: SKIP_FLOW_AUDIT=1 git commit ...
#

if [ "${SKIP_FLOW_AUDIT:-0}" = "1" ]; then
  exit 0
fi

STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)
[ -z "$STAGED" ] && exit 0

# Skip docs-only / lockfile-only commits.
NON_DOC=$(echo "$STAGED" | grep -vE '^docs/|pnpm-lock\.yaml$|\.md$|^\.helix/|^\.claude/' || true)
[ -z "$NON_DOC" ] && exit 0

# Categorize each staged file. Categories chosen to match the layers along
# which prior parity bugs propagated.
classify() {
  local f="$1"
  case "$f" in
    *.model.ts|*.schema.ts) echo "schema" ;;
    packages/database/src/models/*|packages/database/src/schemas/*) echo "schema" ;;
    packages/types/*|packages/shared-kernel/src/types/*) echo "types" ;;
    apps/*/src/types/*|apps/*/src/types.ts) echo "types" ;;
    packages/*/src/types/*|packages/*/src/types.ts) echo "types" ;;
    apps/*/src/contracts/*|packages/*/src/contracts/*) echo "types" ;;
    apps/*/src/routes/*|apps/*/src/api/*|apps/*/src/server.ts) echo "route" ;;
    *serializer*.ts|*serialize*.ts|*/serialize/*|*/serialization/*) echo "serializer" ;;
    *deserializer*.ts|*deserialize*.ts) echo "serializer" ;;
    apps/*/src/services/stores/*|packages/*/src/stores/*) echo "store" ;;
    apps/web-sdk/*|packages/*-sdk/*|packages/sdk*) echo "sdk" ;;
    apps/*/src/workers/*|packages/*/src/workers/*|*/workers/*) echo "worker" ;;
    apps/studio/src/components/*|apps/studio/src/app/*|apps/studio/src/pages/*) echo "ui" ;;
    apps/*/src/middleware/*|packages/*/src/middleware/*) echo "middleware" ;;
    apps/*/src/handlers/*|packages/*/src/handlers/*) echo "handler" ;;
    *) echo "" ;;
  esac
}

CATEGORIES_HIT=""
declare -a TOUCHED_FILES_BY_CAT

while IFS= read -r f; do
  [ -z "$f" ] && continue
  cat=$(classify "$f")
  [ -z "$cat" ] && continue
  case "$f" in
    *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*__mocks__*) continue ;;
    *.d.ts) continue ;;
  esac
  if ! echo "$CATEGORIES_HIT" | grep -qw "$cat"; then
    CATEGORIES_HIT="$CATEGORIES_HIT $cat"
  fi
done <<< "$NON_DOC"

CATEGORIES_HIT=$(echo "$CATEGORIES_HIT" | xargs)
CAT_COUNT=$(echo "$CATEGORIES_HIT" | wc -w | xargs)

if [ "$CAT_COUNT" -lt 2 ]; then
  exit 0
fi

# Look for evidence the committer already did the audit:
#   - any staged parity / round-trip / propagation test file
#   - a staged data-flow-audit.md log
#   - a staged file under docs/sdlc-logs/ for this feature
HAS_PARITY_TEST=$(echo "$STAGED" | grep -E '(parity|round[-_]?trip|propagation|cross[-_]?boundary).*\.(test|spec)\.(ts|tsx)$' | head -1 || true)
HAS_AUDIT_LOG=$(echo "$STAGED" | grep -E 'docs/sdlc-logs/.*/(data-flow-audit|propagation)\.md$' | head -1 || true)

# If they staged either, treat the audit as performed.
if [ -n "$HAS_PARITY_TEST" ] || [ -n "$HAS_AUDIT_LOG" ]; then
  exit 0
fi

# Print the warning with the touched categories and the example files per cat
# (capped to keep output focused).
echo ""
echo "FLOW-CHANGE AUDIT TRIGGER — informational warning."
echo ""
echo "This commit crosses ${CAT_COUNT} boundary categories: ${CATEGORIES_HIT}"
echo ""
echo "Files by category (up to 3 each):"
for cat in $CATEGORIES_HIT; do
  echo "  [$cat]"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) continue ;;
      *.d.ts) continue ;;
    esac
    if [ "$(classify "$f")" = "$cat" ]; then
      echo "    - $f"
    fi
  done <<< "$NON_DOC" | head -3
done
echo ""
echo "Why this matters:"
echo "  Cross-layer commits are the historical shape of parity bugs:"
echo "    ABLP-791 — schema + serializer + route + sdk → 16 fix commits"
echo "    ABLP-654 — schema + serializer + sdk            →  4 fix commits"
echo "    ABLP-540 — schema + types + ui                  →  6 fix commits"
echo "    ABLP-612 — handler + route + middleware + ui    → 10 fix commits"
echo ""
echo "Required check before merging this work:"
echo "  1. Run /data-flow-audit on the value(s) crossing these layers."
echo "     (skill exists at .claude/skills/data-flow-audit/)"
echo "  2. Add at least one parity test that round-trips a fully-populated"
echo "     instance through every boundary touched. Name it *parity.test.ts"
echo "     so this hook recognises it on the follow-up commit."
echo "  3. Log the audit at docs/sdlc-logs/<slug>/data-flow-audit.md."
echo ""
echo "If this commit genuinely does NOT introduce a cross-boundary value"
echo "(e.g., parallel refactor, infra-only sweep), record that reason in the"
echo "commit message. Otherwise, defer the merge until the audit is complete."
echo ""
echo "Skip with: SKIP_FLOW_AUDIT=1 git commit ..."
echo "See CLAUDE.md \"Cross-Boundary Field Propagation\" + the data-flow-audit skill."
echo ""

exit 0
