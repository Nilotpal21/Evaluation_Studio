#!/bin/bash
#
# Claude Code PreToolUse hook: warn when using .lean() on encrypted Mongoose models.
#
# The encryption plugin decrypts fields (encryptedApiKey, encryptedEndpoint) in
# post-find hooks. .lean() may skip these hooks depending on Mongoose version,
# returning raw encrypted blobs instead of decrypted values.
#
# Encrypted models: LLMCredential, AuthProfile
# Safe: AgentModelConfig, ModelConfig, TenantModel (no encryption plugin)
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Check for .lean() on LLMCredential or AuthProfile queries
if echo "$CONTENT" | grep -qE 'LLMCredential\.[a-zA-Z]+\(.*\).*\.lean\(\)'; then
  echo ""
  echo "WARNING: .lean() used on LLMCredential query"
  echo ""
  echo "LLMCredential uses an encryption plugin that decrypts encryptedApiKey"
  echo "and encryptedEndpoint in post-find hooks. .lean() may skip these hooks,"
  echo "returning raw encrypted blobs instead of plaintext values."
  echo ""
  echo "Remove .lean() from this query. See SearchAI tenant-model-adapter.ts"
  echo "for the correct pattern."
  exit 2
fi

exit 0
