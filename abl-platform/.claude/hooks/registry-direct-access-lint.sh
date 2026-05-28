#!/bin/bash
#
# Claude Code PreToolUse hook: block direct reads of the legacy flat
# `ctx.agentRegistry[name]` map. Lookups that have a session in hand must go
# through `lookupAgentForSession` (see `apps/runtime/src/services/execution/agent-lookup.ts`)
# so they honor project + version isolation via the composite-key store.
#
# Direct reads bypass the store and can leak IR across projects or versions
# when the legacy Record is populated. See ABLP-366 and CLAUDE.md Core
# Invariant 1: Resource Isolation.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only check TypeScript server files under apps/runtime
case "$FILE_PATH" in
  *apps/runtime/*.ts) ;;
  *) exit 0 ;;
esac

# ALLOW: the registry + lookup module themselves
case "$FILE_PATH" in
  */services/execution/agent-registry.ts) exit 0 ;;
  */services/execution/agent-lookup.ts) exit 0 ;;
esac

# ALLOW: the runtime-executor itself — it owns the legacy map and the
# bootstrap/rehydrate compatibility path still writes + reads directly.
# Callers that don't own the map must go through lookupAgentForSession.
case "$FILE_PATH" in
  */services/runtime-executor.ts) exit 0 ;;
esac

# ALLOW: test files — test harnesses register unscoped agents and lookups
# are expected to fall through to the legacy Record.
case "$FILE_PATH" in
  *__tests__*) exit 0 ;;
  *.test.ts|*.test.tsx) exit 0 ;;
  *.spec.ts|*.spec.tsx) exit 0 ;;
esac

CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

if [ -z "$CONTENT" ]; then
  exit 0
fi

# Scan non-comment lines for direct indexed reads like:
#   ctx.agentRegistry[name]
#   this.ctx.agentRegistry[name]
#   this.agentRegistry[name]   (outside runtime-executor.ts, already allowed above)
FOUND=""
while IFS= read -r line; do
  trimmed=$(echo "$line" | sed 's/^[[:space:]]*//')
  # Skip comment lines
  if echo "$trimmed" | grep -qE '^(//|\*)'; then
    continue
  fi
  if echo "$line" | grep -qE '(^|[^A-Za-z0-9_])agentRegistry\['; then
    FOUND="$line"
    break
  fi
done <<< "$CONTENT"

if [ -n "$FOUND" ]; then
  echo ""
  echo "BLOCKED: direct indexed read of the legacy agentRegistry detected."
  echo ""
  echo "  $FOUND"
  echo ""
  echo "Use \`lookupAgentForSession(ctx, session, name)\` from"
  echo "\`services/execution/agent-lookup.ts\` instead. That helper routes through"
  echo "the composite-key AgentRegistryStore so project + version isolation is"
  echo "honored. Direct reads bypass the store and can leak IR across projects"
  echo "or versions."
  echo ""
  echo "See ABLP-366 and CLAUDE.md Core Invariant 1."
  exit 2
fi

exit 0
