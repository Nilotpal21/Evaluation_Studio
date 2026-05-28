#!/usr/bin/env bash
#
# verify-i18n-keys.sh
#
# Checks that every i18n key referenced in apps/studio/src/ via
# useTranslations / getTranslations + t('key') actually exists
# in the English translation JSON files.
#
# Exit 0 = all keys found, Exit 1 = missing keys detected.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFY_SCRIPT="$REPO_ROOT/tools/verify-i18n-keys.js"

if [ ! -f "$VERIFY_SCRIPT" ]; then
  echo "ERROR: Verifier script not found: $VERIFY_SCRIPT"
  exit 1
fi

REPO_ROOT="$REPO_ROOT" node "$VERIFY_SCRIPT"
