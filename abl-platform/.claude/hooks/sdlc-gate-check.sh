#!/bin/bash
# Hook: PreToolUse for Agent (implementer subagent spawning)
# Warns when implementing a feature without SDLC artifacts (feature spec, test spec, HLD, LLD).
# Exit code 0 = non-blocking warning (allow the action, but print guidance).
# This hook inspects the agent prompt for feature-related keywords and checks docs/.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')

# Only check Agent tool calls that look like implementation work
if [ "$TOOL_NAME" != "Agent" ]; then
  exit 0
fi

# Extract the prompt from the agent call
PROMPT=$(echo "$TOOL_INPUT" | jq -r '.prompt // empty')
SUBAGENT_TYPE=$(echo "$TOOL_INPUT" | jq -r '.subagent_type // empty')

# Only check implementer-type agents or prompts that mention implementing/building
if [ "$SUBAGENT_TYPE" != "implementer" ]; then
  if ! echo "$PROMPT" | grep -qiE "implement|build|create.*feature|add.*endpoint|add.*route|wire.*up"; then
    exit 0
  fi
fi

# Try to extract a feature name from the prompt
# Look for common patterns like "implement <feature>", "build <feature>", etc.
FEATURE_HINT=$(echo "$PROMPT" | grep -oiE "(implement|build|create|add|wire)\s+[a-z][a-z0-9 -]{2,30}" | head -1 | sed 's/^[a-z]* //i' | tr ' ' '-' | tr '[:upper:]' '[:lower:]')

if [ -z "$FEATURE_HINT" ]; then
  # Can't determine feature name — skip check
  exit 0
fi

# Check for SDLC artifacts
MISSING=""

# Check docs/features/ for a matching spec
if ! ls docs/features/*"$FEATURE_HINT"* 2>/dev/null | grep -q .; then
  if ! ls docs/features/sub-features/*"$FEATURE_HINT"* 2>/dev/null | grep -q .; then
    MISSING="$MISSING\n  - Feature spec: docs/features/<slug>.md (run /feature-spec)"
  fi
fi

# Check docs/testing/ for a matching test spec
if ! ls docs/testing/*"$FEATURE_HINT"* 2>/dev/null | grep -q .; then
  if ! ls docs/testing/sub-features/*"$FEATURE_HINT"* 2>/dev/null | grep -q .; then
    MISSING="$MISSING\n  - Test spec: docs/testing/<slug>.md (run /test-spec)"
  fi
fi

# Check docs/specs/ for a matching HLD
if ! ls docs/specs/*"$FEATURE_HINT"* 2>/dev/null | grep -q .; then
  MISSING="$MISSING\n  - HLD: docs/specs/<slug>.hld.md (run /hld)"
fi

# Check docs/plans/ for a matching LLD/plan
if ! ls docs/plans/*"$FEATURE_HINT"* 2>/dev/null | grep -q .; then
  MISSING="$MISSING\n  - LLD/Plan: docs/plans/<date>-<slug>-impl-plan.md (run /lld)"
fi

if [ -n "$MISSING" ]; then
  echo "SDLC Gate Warning: Starting implementation for '$FEATURE_HINT' but missing artifacts:" >&2
  echo -e "$MISSING" >&2
  echo "" >&2
  echo "Consider running the corresponding skills first. See CLAUDE.md 'SDLC Pipeline'." >&2
  # Exit 0 = non-blocking warning (allow the action to proceed)
  exit 0
fi

exit 0
