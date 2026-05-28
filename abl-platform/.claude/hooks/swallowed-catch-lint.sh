#!/bin/bash
#
# Claude Code PreToolUse hook: block swallowed Promise catches.
#
# Banned patterns:
#   .catch(() => {})          — empty catch body
#   .catch((err) => {})       — catch with param but empty body
#   .catch((_) => {})         — underscore-prefixed unused param, empty body
#   .catch((_err) => {})      — underscore-prefixed unused param, empty body
#   .catch(() => undefined)   — catch returning undefined
#   .catch(() => null)        — catch returning null
#   .catch((_) => undefined)  — underscore param returning undefined/null
#
# Exception: allowed if content contains a comment with "intentional",
# "race", or "prevent unhandled" (e.g., race condition prevention).
#
# Never .catch(() => {}) — log or propagate every error.
# See CLAUDE.md Key Rules.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Extract file path
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check .ts/.tsx files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Skip test files
case "$FILE_PATH" in
  *__tests__*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) exit 0 ;;
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Pattern 1: .catch with empty body — .catch(() => {}) or .catch((err) => {})
EMPTY_BODY_MATCH=$(echo "$CONTENT" | grep -oE '\.catch\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{\s*\}\s*\)' | head -3)

# Pattern 2: .catch returning undefined or null — .catch(() => undefined) or .catch(() => null)
NULL_UNDEF_MATCH=$(echo "$CONTENT" | grep -oE '\.catch\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*(undefined|null)\s*\)' | head -3)

# Note: Patterns 1 and 2 use \w* which already covers underscore-prefixed
# unused params like (_), (_err), (_e) — no separate pattern needed.

# Combine all matches
ALL_MATCHES=""
if [ -n "$EMPTY_BODY_MATCH" ]; then ALL_MATCHES="${ALL_MATCHES}${EMPTY_BODY_MATCH}"$'\n'; fi
if [ -n "$NULL_UNDEF_MATCH" ]; then ALL_MATCHES="${ALL_MATCHES}${NULL_UNDEF_MATCH}"$'\n'; fi

# Remove trailing newline
ALL_MATCHES=$(echo "$ALL_MATCHES" | sed '/^$/d')

if [ -n "$ALL_MATCHES" ]; then
  # Check if the content contains an allowlist comment near the catch
  # Allow if the content has a comment with "intentional", "race", or "prevent unhandled"
  if echo "$CONTENT" | grep -qiE '//.*\b(intentional|race|prevent unhandled)\b|/\*.*\b(intentional|race|prevent unhandled)\b'; then
    exit 0  # Explicitly allowed via comment
  fi

  echo ""
  echo "Swallowed error detected. Never \`.catch(() => {})\` -- log or propagate every error. See CLAUDE.md Key Rules."
  echo ""
  echo "Matched pattern(s):"
  echo "$ALL_MATCHES" | while read -r line; do
    if [ -n "$line" ]; then
      echo "  $line"
    fi
  done
  echo ""
  echo "Fix: Log the error or propagate it. Example:"
  echo "  .catch((err) => { log.error('descriptive message', { error: err instanceof Error ? err.message : String(err) }); })"
  echo ""
  echo "If this is intentional (e.g., race condition prevention), add a comment:"
  echo "  // intentional: prevent unhandled rejection during shutdown"
  echo "  .catch((_) => {})"
  echo ""
  exit 2
fi

exit 0
