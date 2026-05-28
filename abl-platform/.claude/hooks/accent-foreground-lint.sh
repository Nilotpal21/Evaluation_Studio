#!/usr/bin/env bash
# accent-foreground-lint.sh — Blocks bg-accent text-foreground in UI files.
#
# The accent token is a monochrome neutral: near-white in dark mode (93%),
# near-black in light mode (13%). Pairing it with text-foreground (also near-white
# in dark / near-black in light) produces invisible text on the button/chip.
# The correct semantic pair is bg-accent text-accent-foreground, which always
# provides maximum contrast (foreground is the inverse of the background).
#
# Rule: bg-accent text-foreground → BLOCKED (use text-accent-foreground)

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Only check UI source files (.tsx/.ts in studio/admin/packages)
case "$FILE" in
  *.tsx|*.ts) ;;
  *) exit 0 ;;
esac

case "$FILE" in
  */apps/studio/src/*|*/apps/admin/src/*|*/packages/admin-ui/src/*|*/packages/ui/src/*) ;;
  *) exit 0 ;;
esac

# Skip test files
case "$FILE" in
  *.test.*|*.spec.*|*__tests__/*|*.e2e.*|*.integration.*) exit 0 ;;
esac

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

[ -z "$CONTENT" ] && exit 0

# Detect: bg-accent followed by text-foreground (same or adjacent tokens in className)
# Matches both "bg-accent text-foreground" and "bg-accent ... text-foreground" (with other classes between)
VIOLATIONS=$(echo "$CONTENT" | grep -nE "bg-accent[^'\"]*text-foreground[^-]" 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "BLOCKED: bg-accent text-foreground detected in $FILE"
  echo ""
  echo "  In dark mode: accent=93% lightness, foreground=98% lightness → white on white."
  echo "  In light mode: accent=13% lightness, foreground=9% lightness → black on black."
  echo "  Either way the text is invisible."
  echo ""
  echo "  Fix: replace text-foreground with text-accent-foreground"
  echo "       text-accent-foreground is the semantic inverse (dark/light flips correctly)."
  echo ""
  echo "  Violations:"
  echo "$VIOLATIONS" | head -5
  exit 2
fi

exit 0
