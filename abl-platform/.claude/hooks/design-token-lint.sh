#!/usr/bin/env bash
# design-token-lint.sh — Warns on hardcoded Tailwind palette colors in UI code
#
# Catches: bg-blue-500, text-red-400, border-emerald-500/25, etc.
# Allows: Tailwind config files, test files, SVG brand icons, syntax highlighting

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL" = "Write" ]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
else
  exit 0
fi

[ -z "$FILE" ] && exit 0

# Only check .tsx and .ts files in UI apps
case "$FILE" in
  */apps/studio/src/*.tsx|*/apps/studio/src/*.ts|\
  */apps/admin/src/*.tsx|*/apps/admin/src/*.ts|\
  */packages/admin-ui/src/*.tsx|*/packages/admin-ui/src/*.ts)
    ;;
  *)
    exit 0
    ;;
esac

# Skip files that legitimately use raw colors
case "$FILE" in
  *tailwind.config*|*.test.*|*.spec.*|*__tests__/*|\
  *SourceViewer.tsx|*ProviderIcons.tsx|*channel-icons.tsx|\
  *LoginButton.tsx|*SandboxConfigForm.tsx|*ABLEditor.tsx|\
  *global-error.tsx|*event-colors.ts)
    exit 0
    ;;
esac

# Pattern: raw Tailwind palette colors (bg-blue-500, text-red-400, etc.)
PALETTE_PATTERN='(bg|text|border|ring|from|to|via)-(blue|red|green|yellow|amber|emerald|teal|cyan|indigo|violet|pink|rose|sky|fuchsia|lime|slate|zinc|gray|neutral|stone)-[0-9]'

VIOLATIONS=$(echo "$CONTENT" | grep -nE "$PALETTE_PATTERN" 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  echo "WARNING: Hardcoded Tailwind palette colors detected."
  echo "  File: $FILE"
  echo ""
  echo "  Use semantic tokens instead:"
  echo "    bg-blue-500 -> bg-info or bg-accent"
  echo "    text-red-400 -> text-error"
  echo "    text-emerald-400 -> text-success"
  echo "    bg-amber-500 -> bg-warning"
  echo ""
  echo "  Violations:"
  echo "$VIOLATIONS" | head -10
  exit 0
fi

exit 0
