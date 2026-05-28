#!/usr/bin/env bash
# Semgrep security scanner wrapper for the agent-platform monorepo.
# Runs JavaScript/TypeScript security rules against apps/ and packages/.
#
# Usage:
#   ./tools/run-semgrep.sh           # scan all
#   ./tools/run-semgrep.sh apps/     # scan specific path

set -euo pipefail

if ! command -v semgrep >/dev/null 2>&1; then
  echo "ERROR: semgrep is not installed."
  echo ""
  echo "Install via one of:"
  echo "  brew install semgrep"
  echo "  pip install semgrep"
  echo "  pipx install semgrep"
  echo ""
  echo "Then re-run this script."
  exit 1
fi

if [ -z "${SSL_CERT_FILE:-}" ]; then
  if [ -f /etc/ssl/cert.pem ]; then
    export SSL_CERT_FILE=/etc/ssl/cert.pem
  elif [ -f /opt/homebrew/etc/ca-certificates/cert.pem ]; then
    export SSL_CERT_FILE=/opt/homebrew/etc/ca-certificates/cert.pem
  fi
fi

if [ -z "${SSL_CERT_DIR:-}" ] && [ -d /etc/ssl/certs ]; then
  export SSL_CERT_DIR=/etc/ssl/certs
fi

if [ "$#" -eq 0 ]; then
  TARGETS=(apps/ packages/)
else
  TARGETS=("$@")
fi

SCAN_TARGETS=()
for target in "${TARGETS[@]}"; do
  if [ -e "$target" ]; then
    SCAN_TARGETS+=("$target")
  fi
done

if [ "${#SCAN_TARGETS[@]}" -eq 0 ]; then
  echo "No existing Semgrep targets to scan. Skipping."
  exit 0
fi

exec semgrep \
  --config=p/javascript \
  --config=p/typescript \
  "${SCAN_TARGETS[@]}" \
  --exclude='**/node_modules/**' \
  --exclude='**/__tests__/**' \
  --exclude='**/dist/**' \
  --exclude='apps/studio/public/monaco-editor/**' \
  --exclude='**/*.test.ts' \
  --exclude='**/*.spec.ts'
