#!/usr/bin/env bash
# ============================================================================
# AFG Blue Advisory — Automated Setup Script
# ============================================================================
#
# Usage:
#   1. Fill in setup.env with your credentials
#   2. Run: ./setup.sh
#
# Prerequisites:
#   - pnpm build (platform must be built)
#   - Studio running at STUDIO_API_URL
#   - kore-platform-cli available (or uses curl fallback)
#
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/setup.env"

# ── Load config (layer: root .env → runtime .env → setup.env) ────────────────
# Earlier sources are overridden by later ones, so setup.env wins.

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

set -a

# 1. Root .env — has OPENAI_API_KEY, Qwen keys, AFG_SEARCHAI_TOKEN
if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env"
fi

# 2. Runtime .env — may have additional overrides
if [[ -f "$REPO_ROOT/apps/runtime/.env" ]]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/apps/runtime/.env"
fi

# 3. setup.env — user overrides (AUTH_TOKEN, PROJECT_ID, Bitbucket, etc.)
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

set +a

# Map Qwen env var names (root .env uses dotted names, setup.env uses underscored)
QWEN_API_KEY="${QWEN_API_KEY:-${Qwen3_5_35B_A3B_API_KEY:-}}"
# Handle the dotted env var name that bash can't source directly
if [[ -z "$QWEN_API_KEY" ]]; then
  QWEN_API_KEY=$(grep -E '^Qwen3\.5-35B-A3B_API_KEY=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
fi
QWEN_ENDPOINT_URL="${QWEN_ENDPOINT_URL:-}"
if [[ -z "$QWEN_ENDPOINT_URL" ]]; then
  QWEN_ENDPOINT_URL=$(grep -E '^Qwen3\.5-35B-A3B_URL=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
fi

API="${STUDIO_API_URL:-http://localhost:5173}"

if [[ -z "${AUTH_TOKEN:-}" ]]; then
  echo "ERROR: AUTH_TOKEN is required in setup.env"
  echo "  Get one by running: kore-platform-cli login"
  echo "  Then paste it into: $ENV_FILE"
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

api() {
  local method="$1" path="$2"
  shift 2
  curl -s -X "$method" "${API}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    "$@"
}

check_success() {
  local response="$1" step="$2"
  local success
  success=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "False")
  if [[ "$success" != "True" ]]; then
    echo "FAILED: $step"
    echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    exit 1
  fi
}

echo "============================================"
echo "  AFG Blue Advisory — Setup"
echo "============================================"
echo ""
echo "  API:        $API"
echo "  Project:    ${PROJECT_ID:-<will create>}"
echo "  Bitbucket:  ${BITBUCKET_REPO_URL:-<skipped>}"
echo ""

# ── Step 1: Create or verify project ────────────────────────────────────────

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "── Step 1: Creating project '${PROJECT_NAME}'..."
  RESPONSE=$(api POST "/api/projects" \
    -d "{\"name\": \"${PROJECT_NAME}\", \"description\": \"Multi-brand retail and automotive advisory system\"}")
  check_success "$RESPONSE" "Create project"
  PROJECT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('id', d.get('id','')))")
  echo "  Created project: $PROJECT_ID"
else
  echo "── Step 1: Using existing project: $PROJECT_ID"
fi

echo ""

# ── Step 2: Configure LLM models ────────────────────────────────────────────

echo "── Step 2: Configuring LLM models..."

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  echo "  Adding gpt-4.1 (OpenAI)..."
  RESPONSE=$(api POST "/api/models" \
    -d "{
      \"provider\": \"openai\",
      \"model\": \"gpt-4.1\",
      \"apiKey\": \"${OPENAI_API_KEY}\",
      \"displayName\": \"GPT-4.1\"
    }")
  # Model may already exist — not a fatal error
  echo "  $(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message', 'OK'))" 2>/dev/null || echo "OK")"
else
  echo "  SKIP: OPENAI_API_KEY not set"
fi

if [[ -n "${QWEN_API_KEY:-}" && -n "${QWEN_ENDPOINT_URL:-}" ]]; then
  echo "  Adding qwen35-a3b-35b..."
  RESPONSE=$(api POST "/api/models" \
    -d "{
      \"provider\": \"openai-compatible\",
      \"model\": \"qwen35-a3b-35b\",
      \"apiKey\": \"${QWEN_API_KEY}\",
      \"baseUrl\": \"${QWEN_ENDPOINT_URL}\",
      \"displayName\": \"Qwen 3.5-35B-A3B\"
    }")
  echo "  $(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message', 'OK'))" 2>/dev/null || echo "OK")"
else
  echo "  SKIP: QWEN_API_KEY or QWEN_ENDPOINT_URL not set"
fi

echo ""

# ── Step 3: Import agent package ─────────────────────────────────────────────

echo "── Step 3: Importing AFG Blue Advisory agents..."

# Build file map from the example directory
FILES_JSON=$(python3 -c "
import json, os

base = '${SCRIPT_DIR}'
files = {}
skip_dirs = {'fixtures', '.git', 'node_modules'}
skip_files = {'setup.env', 'setup.sh'}

for root, dirs, fnames in os.walk(base):
    dirs[:] = [d for d in dirs if d not in skip_dirs]
    for f in fnames:
        if f in skip_files:
            continue
        full = os.path.join(root, f)
        rel = os.path.relpath(full, base)
        try:
            with open(full, 'r') as fh:
                files[rel] = fh.read()
        except UnicodeDecodeError:
            pass  # skip binary files

print(json.dumps({'files': files}))
")

# Preview
echo "  Previewing import..."
PREVIEW=$(echo "$FILES_JSON" | api POST "/api/projects/${PROJECT_ID}/import/preview" -d @-)
VALID=$(echo "$PREVIEW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('preview',{}).get('valid', d.get('valid', False)))" 2>/dev/null || echo "False")

if [[ "$VALID" != "True" ]]; then
  echo "  WARNING: Import preview has issues:"
  echo "$PREVIEW" | python3 -m json.tool 2>/dev/null || echo "$PREVIEW"
  echo ""
  echo "  Proceeding with import anyway..."
fi

# Apply
echo "  Applying import..."
APPLY=$(echo "$FILES_JSON" | api POST "/api/projects/${PROJECT_ID}/import/apply" -d @-)
echo "  $(echo "$APPLY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d.get('applied', d.get('data', {}))
if isinstance(a, dict):
    print(f\"Created: {a.get('created',0)}, Updated: {a.get('updated',0)}, Deleted: {a.get('deleted',0)}\")
else:
    print('Import applied')
" 2>/dev/null || echo "Import applied")"

echo ""

# ── Step 4: Set project environment variables ────────────────────────────────

echo "── Step 4: Setting project environment variables..."

if [[ -n "${AFG_SEARCHAI_ENDPOINT:-}" ]]; then
  echo "  Setting AFG_SEARCHAI_ENDPOINT..."
  api POST "/api/projects/${PROJECT_ID}/env" \
    -d "{\"key\": \"AFG_SEARCHAI_ENDPOINT\", \"value\": \"${AFG_SEARCHAI_ENDPOINT}\"}" > /dev/null
  echo "  OK"
else
  echo "  SKIP: AFG_SEARCHAI_ENDPOINT not set"
fi

if [[ -n "${AFG_SEARCHAI_TOKEN:-}" ]]; then
  echo "  Setting AFG_SEARCHAI_TOKEN..."
  api POST "/api/projects/${PROJECT_ID}/env" \
    -d "{\"key\": \"AFG_SEARCHAI_TOKEN\", \"value\": \"${AFG_SEARCHAI_TOKEN}\", \"secret\": true}" > /dev/null
  echo "  OK"
else
  echo "  SKIP: AFG_SEARCHAI_TOKEN not set"
fi

echo ""

# ── Step 5: Connect Bitbucket (optional) ─────────────────────────────────────

if [[ -n "${BITBUCKET_REPO_URL:-}" ]]; then
  echo "── Step 5: Connecting Bitbucket repository..."
  echo "  Repo: ${BITBUCKET_REPO_URL}"
  echo "  Branch: ${BITBUCKET_BRANCH:-main}"

  RESPONSE=$(api POST "/api/projects/${PROJECT_ID}/git" \
    -d "{
      \"provider\": \"bitbucket\",
      \"repositoryUrl\": \"${BITBUCKET_REPO_URL}\",
      \"defaultBranch\": \"${BITBUCKET_BRANCH:-main}\",
      \"syncPath\": \"/\",
      \"credentials\": {
        \"type\": \"pat\",
        \"token\": \"${BITBUCKET_AUTH_TOKEN:-}\",
        \"authMode\": \"${BITBUCKET_AUTH_MODE:-api_token}\"
      }
    }")
  echo "  $(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message', 'Connected'))" 2>/dev/null || echo "Connected")"

  # ── Step 6: Push to Bitbucket ───────────────────────────────────────────────

  echo ""
  echo "── Step 6: Pushing project to Bitbucket..."
  RESPONSE=$(api POST "/api/projects/${PROJECT_ID}/git/push" \
    -d "{\"commitMessage\": \"initial: AFG Blue Advisory v2 export\", \"branch\": \"${BITBUCKET_BRANCH:-main}\"}")
  echo "  $(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Branch: {d.get('branch','?')}, Commit: {d.get('commitSha','?')[:8]}, Files: {d.get('filesChanged','?')}\")
" 2>/dev/null || echo "Pushed")"
else
  echo "── Step 5: Skipping Bitbucket (BITBUCKET_REPO_URL not set)"
  echo "── Step 6: Skipping push (no Bitbucket)"
fi

echo ""

# ── Step 7: Run import doctor ────────────────────────────────────────────────

echo "── Step 7: Running import doctor..."
DOCTOR=$(api GET "/api/projects/${PROJECT_ID}/import/doctor")
echo "$DOCTOR" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('data', {})
status = d.get('status', 'unknown')
print(f'  Status: {status}')
prov = d.get('provisioning_required', {})
if prov.get('env_vars'):
    print(f\"  Missing env vars: {', '.join(prov['env_vars'])}\")
if prov.get('connectors_needing_credentials'):
    print(f\"  Connectors need creds: {', '.join(prov['connectors_needing_credentials'])}\")
if not prov.get('env_vars') and not prov.get('connectors_needing_credentials'):
    print('  All provisioning complete!')
" 2>/dev/null || echo "  Doctor check complete"

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "  Project ID:  $PROJECT_ID"
echo "  Studio URL:  ${API}/projects/${PROJECT_ID}"
if [[ -n "${BITBUCKET_REPO_URL:-}" ]]; then
  echo "  Bitbucket:   ${BITBUCKET_REPO_URL}"
fi
echo ""
echo "  Next steps:"
echo "    1. Open Studio and verify the 3 agents are imported"
echo "    2. Test with: 'Hi' → should route to Advisor_Agent"
echo "    3. Run evals from the Evals tab"
echo ""
