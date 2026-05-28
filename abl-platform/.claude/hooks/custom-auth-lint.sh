#!/bin/bash
#
# Claude Code PreToolUse hook: block custom JWT verification outside auth packages.
#
# Custom token verification MUST use `createUnifiedAuthMiddleware`/`requireAuth`
# from `@abl/shared-auth`. Direct jsonwebtoken usage or manual Authorization
# header parsing outside the auth packages is forbidden.
#
# See CLAUDE.md Core Invariant 2: Centralized Auth.
#

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Write and Edit tools
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Determine file path (same jq path for both Write and Edit)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check .ts and .tsx files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# ALLOW: files within the auth packages
case "$FILE_PATH" in
  */packages/shared-auth/*) exit 0 ;;
  */packages/shared-auth-profile/*) exit 0 ;;
esac

# ALLOW: test files
case "$FILE_PATH" in
  *__tests__*) exit 0 ;;
  *.test.ts|*.test.tsx) exit 0 ;;
  *.spec.ts|*.spec.tsx) exit 0 ;;
esac

# Get the content being written
CONTENT=""
if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
fi

# Check for direct jsonwebtoken usage: jwt.verify(, jwt.decode(, import from jsonwebtoken, require jsonwebtoken
if echo "$CONTENT" | grep -qE 'jwt\.(verify|decode)\s*\(|from\s+['"'"'"]jsonwebtoken['"'"'"]|require\s*\(\s*['"'"'"]jsonwebtoken['"'"'"]\s*\)'; then
  echo ""
  echo "Custom token verification detected (jsonwebtoken)."
  echo ""
  echo "Use \`createUnifiedAuthMiddleware\`/\`requireAuth\` from \`@abl/shared-auth\`."
  echo "Never implement custom JWT verification."
  echo "See CLAUDE.md Core Invariant 2."
  exit 2
fi

# Check for jose library usage (alternative JWT library)
if echo "$CONTENT" | grep -qE 'from\s+['"'"'"]jose['"'"'"]|require\s*\(\s*['"'"'"]jose['"'"'"]\s*\)|jwtVerify\s*\(|SignJWT|importSPKI|importPKCS8'; then
  echo ""
  echo "Custom token verification detected (jose library)."
  echo ""
  echo "Use \`createUnifiedAuthMiddleware\`/\`requireAuth\` from \`@abl/shared-auth\`."
  echo "Never implement custom JWT verification."
  echo "See CLAUDE.md Core Invariant 2."
  exit 2
fi

# Check for manual Authorization header parsing
if echo "$CONTENT" | grep -qE 'headers\[?\.?['"'"'"]?authorization['"'"'"]?\]?\s*\.\s*(split|replace|substring|slice)'; then
  echo ""
  echo "Custom token verification detected."
  echo ""
  echo "Use \`createUnifiedAuthMiddleware\`/\`requireAuth\` from \`@abl/shared-auth\`."
  echo "Never implement custom JWT verification."
  echo "See CLAUDE.md Core Invariant 2."
  exit 2
fi

exit 0
