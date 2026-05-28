#!/bin/bash
#
# Claude Code PreToolUse hook: block deletion of entire packages/apps directories.
#
# Why: 3 incidents of wrongly deleted packages in this repo's history. This hook
# prevents accidental recursive deletion of package or app directories that may
# be standalone tools, SDKs, or externally consumed packages.
#
# How: Intercepts Bash tool calls, checks if the command would recursively delete
# a packages/ or apps/ directory. Individual file deletions are allowed.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Bash tool calls
if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Check for recursive deletion of packages/ or apps/ directories
# Matches: rm -rf, rm -Rf, rm -r -f, rm --recursive, git rm -r, etc.
# Does NOT match: rm packages/foo/src/bar.ts (no -r flag)
# Case-insensitive (-i) to catch -Rf/-rF variants. Also catches --recursive long flag.
if echo "$COMMAND" | grep -iqE '(rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+|-\w+\s+)*(\.\/)?((packages|apps)\/[a-zA-Z])|git\s+rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+|-\w+\s+)*(\.\/)?((packages|apps)\/[a-zA-Z]))' && echo "$COMMAND" | grep -iqE '(-[a-zA-Z]*r[a-zA-Z]*|--recursive)'; then
  echo "BLOCKED: Deleting entire package/app directory. 3 incidents of wrongly deleted packages in this repo's history. Verify this is not a standalone tool, SDK, or externally consumed package before deleting. If intentional, delete files individually or get explicit user approval."
  exit 2
fi

exit 0
