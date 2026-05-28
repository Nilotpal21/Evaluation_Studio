#!/usr/bin/env bash
# Run generate-insights-data.ts with env vars from .env.local auto-loaded.
#
# Usage:
#   pnpm insights
#
# Env file: scripts/conversation-testing/.env.local (gitignored)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." &>/dev/null && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.local"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: ${ENV_FILE} not found."
  echo "Create it with at minimum: ANTHROPIC_API_KEY=... and either SHARE_TOKEN=... or (STUDIO_EMAIL=... + PROJECT_ID=...)"
  exit 1
fi

# Load .env.local, but caller-provided env vars take precedence.
# (e.g. `RUNS=10 pnpm insights` must beat `RUNS=1` in the file.)
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip blank lines and comments
  [[ -z "${line// /}" || "$line" =~ ^[[:space:]]*# ]] && continue
  # Split on first '='
  key="${line%%=*}"
  value="${line#*=}"
  # Trim whitespace from key
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  # Must be a valid shell identifier
  [[ ! "$key" =~ ^[A-Za-z_][A-Za-z_0-9]*$ ]] && continue
  # Skip if already set by caller (env wins over file)
  [[ -n "${!key+x}" ]] && continue
  # Strip surrounding single or double quotes if present
  if [[ "$value" =~ ^\"(.*)\"$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  export "$key=$value"
done <"${ENV_FILE}"

cd "${REPO_ROOT}"
exec pnpm exec tsx scripts/generate-insights-data.ts "$@"
