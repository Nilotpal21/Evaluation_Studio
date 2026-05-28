#!/bin/bash
# Hook: SubagentStop for implementer
# Checks if the implementer reported unresolved failures.
# Exit code 2 = block stop and send feedback to agent.

INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')

# Check if implementer reported unresolved failures
if echo "$LAST_MSG" | grep -qi "failed after 3 attempts"; then
  echo "Implementer has unresolved failures that need review." >&2
  exit 2
fi

# Check if implementer forgot to run prettier
if echo "$LAST_MSG" | grep -qi "prettier.*skip\|skipping.*prettier"; then
  echo "Must run npx prettier --write on all changed files before stopping." >&2
  exit 2
fi

exit 0
