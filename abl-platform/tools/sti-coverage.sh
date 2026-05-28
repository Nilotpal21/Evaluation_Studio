#!/usr/bin/env bash
# sti-coverage.sh — Track and enforce STI tracePath() instrumentation coverage.
#
# Usage:
#   tools/sti-coverage.sh              # Report coverage
#   tools/sti-coverage.sh --manifest   # Generate sti-manifest.json
#   tools/sti-coverage.sh --enforce    # Fail if critical paths are uninstrumented
#
# Outputs:
#   - Coverage count + list of all tracePath() paths
#   - sti-manifest.json (with --manifest)
#   - Exit code 1 if --enforce and critical paths are missing

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Extract all tracePath() path strings from source ──────────────────────

extract_paths() {
  # Handle both single-line tracePath('path', ...) and multi-line tracePath(\n  'path', ...)
  # Uses perl for multi-line matching across the entire file
  find "$ROOT/apps" "$ROOT/packages" -name "*.ts" \
    -not -path "*/node_modules/*" \
    -not -path "*/dist/*" \
    -not -path "*/__tests__/*" \
    -not -name "*.d.ts" \
    -exec perl -0777 -ne "while (/tracePath\(\s*['\"]([^'\"]+)['\"]/g) { print \"\$1\\n\" }" {} + \
    | sort -u
}

PATHS=$(extract_paths)
COUNT=$(echo "$PATHS" | grep -c . || true)

echo "=== STI tracePath() Coverage ==="
echo "Total instrumented paths: $COUNT"
echo ""
echo "$PATHS" | while read -r p; do
  echo "  $p"
done

# ── Critical paths that MUST be instrumented ──────────────────────────────
# These are the "top 10 hot paths" from the design doc.
# Add new entries as the taxonomy grows.

CRITICAL_PATHS=(
  "runtime/executor/llm-call"
  "runtime/executor/tool-call"
  "runtime/executor/constraint-check"
  "runtime/executor/handoff"
  "runtime/executor/agent-exit"
  "runtime/executor/decision"
  "runtime/executor/delegate"
  "runtime/executor/flow/step-exit"
  "runtime/executor/flow/transition"
)

# ── Manifest generation ───────────────────────────────────────────────────

if [[ "${1:-}" == "--manifest" ]]; then
  MANIFEST="$ROOT/sti-manifest.json"
  echo ""
  echo "Generating $MANIFEST ..."

  # Build JSON array
  echo "{" > "$MANIFEST"
  echo "  \"generated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$MANIFEST"
  echo "  \"count\": $COUNT," >> "$MANIFEST"
  echo "  \"paths\": [" >> "$MANIFEST"

  # Build entries using a temp file to avoid subshell variable scope issues
  ENTRIES_FILE=$(mktemp)
  echo "$PATHS" | while read -r p; do
    # Find the file containing this path (use perl for multi-line)
    FILE=$(find "$ROOT/apps" "$ROOT/packages" -name "*.ts" \
      -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/__tests__/*" \
      -exec grep -l "$p" {} + 2>/dev/null | head -1 | sed "s|$ROOT/||")
    echo "    { \"path\": \"$p\", \"file\": \"${FILE:-unknown}\" }" >> "$ENTRIES_FILE"
  done

  # Join entries with commas
  paste -sd',' "$ENTRIES_FILE" | sed 's/,/,\n/g' >> "$MANIFEST"
  rm -f "$ENTRIES_FILE"

  echo "" >> "$MANIFEST"
  echo "  ]" >> "$MANIFEST"
  echo "}" >> "$MANIFEST"

  echo "Written to $MANIFEST"
fi

# ── Enforcement ───────────────────────────────────────────────────────────

if [[ "${1:-}" == "--enforce" ]]; then
  echo ""
  echo "=== Checking critical paths ==="
  MISSING=0

  for cp in "${CRITICAL_PATHS[@]}"; do
    if echo "$PATHS" | grep -q "^${cp}$"; then
      echo "  ✓ $cp"
    else
      echo "  ✗ $cp  MISSING"
      MISSING=$((MISSING + 1))
    fi
  done

  echo ""
  if [ "$MISSING" -gt 0 ]; then
    echo "FAIL: $MISSING critical paths are not instrumented."
    echo "Add tracePath('$cp', ...) wrappers for the missing paths."
    exit 1
  else
    echo "PASS: All ${#CRITICAL_PATHS[@]} critical paths are instrumented."
  fi
fi
