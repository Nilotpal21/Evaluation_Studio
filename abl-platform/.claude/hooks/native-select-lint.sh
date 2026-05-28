#!/usr/bin/env bash
# native-select-lint.sh — Warns on native <select> in studio component files.
#
# Studio uses @radix-ui/react-select via apps/studio/src/components/ui/Select.tsx.
# Native <select> elements do not inherit the design system theme in dark mode —
# browsers render them with system defaults (light background, dark text) regardless
# of CSS variables. They also lack keyboard navigation, animations, and accessibility
# attributes provided by the Radix component.
#
# Exceptions (intentionally allowed):
#   - apps/studio/src/components/ui/  — the UI primitives themselves
#   - DynamicForm.tsx                 — renders arbitrary server-defined schemas
#   - Pagination.tsx                  — page-size picker (acceptable native control)
#   - ParameterEditor.tsx             — JSON schema editor with complex enum rendering
#   - ProviderConfigForm.tsx          — search-ai pipeline schema-driven config

set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Only check .tsx files in studio components/pages
case "$FILE" in
  */apps/studio/src/components/*.tsx|*/apps/studio/src/app/*.tsx) ;;
  *) exit 0 ;;
esac

# Skip test files
case "$FILE" in
  *.test.*|*.spec.*|*__tests__/*) exit 0 ;;
esac

# Skip allowed exceptions
case "$FILE" in
  */components/ui/*|\
  */DynamicForm.tsx|\
  */Pagination.tsx|\
  */ParameterEditor.tsx|\
  */ProviderConfigForm.tsx)
    exit 0
    ;;
esac

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

[ -z "$CONTENT" ] && exit 0

VIOLATIONS=$(echo "$CONTENT" | grep -nE "<select(\s|>)" 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "WARNING: Native <select> detected in $FILE"
  echo ""
  echo "  Native selects do not inherit the Studio design system theme."
  echo "  Use the themed component instead:"
  echo ""
  echo "    import { Select } from '../ui/Select';"
  echo "    <Select options={opts} value={val} onChange={setVal} />"
  echo ""
  echo "  For toolbar/filter dropdowns:"
  echo "    import { FilterSelect } from '../ui/FilterSelect';"
  echo ""
  echo "  Violations:"
  echo "$VIOLATIONS" | head -5
  exit 0
fi

exit 0
