#!/bin/bash
#
# Claude Code PreToolUse hook: warn when creating a new packages/*/package.json
# via the Write tool, reminding to add COPY lines to all Dockerfiles.
#

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // empty')

# Only trigger for packages/*/package.json paths
if ! echo "$FILE_PATH" | grep -qE 'packages/[^/]+/package\.json$'; then
  exit 0
fi

# Extract the package path segment (e.g., packages/my-new-pkg)
PKG_PATH=$(echo "$FILE_PATH" | grep -oE 'packages/[^/]+')

# Check if this is a NEW package (file doesn't exist yet)
if [ -f "$FILE_PATH" ]; then
  exit 0
fi

# Emit a warning — Claude Code will show this to the agent
cat <<EOF
WARNING: You are creating a new workspace package ($PKG_PATH/package.json).

You MUST add a COPY line to every Dockerfile that uses pnpm install --frozen-lockfile:

  COPY $PKG_PATH/package.json $PKG_PATH/package.json

Dockerfiles to update:
  - apps/runtime/Dockerfile
  - apps/search-ai/Dockerfile
  - apps/admin/Dockerfile
  - apps/studio/Dockerfile
  - apps/search-ai-runtime/Dockerfile
  - apps/multimodal-service/Dockerfile

Without this, Docker builds will fail because pnpm cannot resolve the dependency graph.

Run ./tools/verify-dockerfile-copies.sh to verify all packages are covered.
EOF

# Exit 0 — this is a warning, not a blocker
exit 0
