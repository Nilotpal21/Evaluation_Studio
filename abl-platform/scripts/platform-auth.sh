#!/usr/bin/env bash
# Platform Auth Helper — Generic authentication for all platform services
#
# Usage:
#   ./scripts/platform-auth.sh coroot [command]     # Coroot observability
#   ./scripts/platform-auth.sh abl-dev [command]     # ABL Dev Runtime
#   ./scripts/platform-auth.sh studio [command]      # ABL Dev Studio
#
# Examples:
#   # ClickHouse health
#   ./scripts/platform-auth.sh coroot app clickhouse-shard-0
#
#   # ClickHouse logs (errors only)
#   ./scripts/platform-auth.sh coroot logs clickhouse-shard-0 error
#
#   # Runtime logs
#   ./scripts/platform-auth.sh coroot logs runtime error
#
#   # Project status (all apps)
#   ./scripts/platform-auth.sh coroot status
#
#   # Session detail from runtime
#   ./scripts/platform-auth.sh abl-dev session <sessionId> <projectId>
#
#   # Diagnose agent
#   ./scripts/platform-auth.sh abl-dev diagnose <agentName> <projectId>

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

COROOT_BASE_URL="${COROOT_BASE_URL:-https://coroot-agents-dev.kore.ai}"
COROOT_EMAIL="${COROOT_USERNAME:-coroot-abl-dev@kore.ai}"
COROOT_PASS="${COROOT_PASSWORD:-kxHeS69xTNujXT4VTAOT7R7mXrts8eTn}"
COROOT_PROJECT="${COROOT_PROJECT_ID:-vz762g8o}"
COROOT_COOKIE_FILE="/tmp/coroot-session-cookie.txt"
COROOT_NS="abl-platform-dev"

ABL_DEV_URL="${ABL_DEV_URL:-https://agents-dev.kore.ai}"
ABL_DEV_COOKIE_FILE="/tmp/abl-dev-cookie.txt"

STUDIO_URL="${STUDIO_URL:-http://localhost:5173}"
DEV_EMAIL="${DEV_EMAIL:-dev@kore.ai}"
STUDIO_TOKEN_CACHE="/tmp/studio-dev-token"

# ─── Coroot App ID Aliases ──────────────────────────────────────────────────

resolve_coroot_app_id() {
  local short="$1"
  case "$short" in
    runtime)            echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-runtime" ;;
    studio)             echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-studio" ;;
    admin)              echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-admin" ;;
    search-ai)          echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-search-ai" ;;
    search-ai-runtime)  echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-search-ai-runtime" ;;
    mongodb|mongo)      echo "${COROOT_PROJECT}:${COROOT_NS}:StatefulSet:${COROOT_NS}-mongodb" ;;
    redis)              echo "${COROOT_PROJECT}:${COROOT_NS}:DatabaseCluster:${COROOT_NS}-redis" ;;
    clickhouse*)        echo "${COROOT_PROJECT}:${COROOT_NS}:StatefulSet:${COROOT_NS}-clickhouse-shard-0" ;;
    qdrant)             echo "${COROOT_PROJECT}:${COROOT_NS}:StatefulSet:${COROOT_NS}-qdrant" ;;
    workflow-engine)    echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-workflow-engine" ;;
    multimodal)         echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-multimodal-service" ;;
    bge-m3)             echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-bge-m3" ;;
    docling)            echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-docling" ;;
    preprocessing)      echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-preprocessing" ;;
    codetool-sandbox)   echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-codetool-sandbox" ;;
    livekit)            echo "${COROOT_PROJECT}:${COROOT_NS}:Deployment:${COROOT_NS}-livekit" ;;
    restate)            echo "${COROOT_PROJECT}:${COROOT_NS}:StatefulSet:${COROOT_NS}-restate" ;;
    *)                  echo "$short" ;;  # Pass through full IDs
  esac
}

# ─── Coroot Auth ─────────────────────────────────────────────────────────────

coroot_login() {
  # Check if existing cookie is still valid
  if [[ -f "$COROOT_COOKIE_FILE" ]]; then
    local status
    status=$(curl -sw '%{http_code}' -o /dev/null -b "$COROOT_COOKIE_FILE" \
      "${COROOT_BASE_URL}/api/project/${COROOT_PROJECT}/status" 2>/dev/null)
    if [[ "$status" == "200" ]]; then
      return 0
    fi
  fi

  # Login with Email/Password (Coroot Community uses capitalized field names)
  local http_code
  http_code=$(curl -sw '%{http_code}' -o /dev/null -X POST \
    "${COROOT_BASE_URL}/api/login" \
    -H 'Content-Type: application/json' \
    -d "{\"Email\":\"${COROOT_EMAIL}\",\"Password\":\"${COROOT_PASS}\"}" \
    -c "$COROOT_COOKIE_FILE" 2>/dev/null)

  if [[ "$http_code" != "200" ]]; then
    echo "ERROR: Coroot login failed (HTTP $http_code)" >&2
    echo "Check COROOT_USERNAME and COROOT_PASSWORD env vars" >&2
    return 1
  fi
}

coroot_api() {
  local path="$1"
  coroot_login
  curl -s -b "$COROOT_COOKIE_FILE" "${COROOT_BASE_URL}/api/project/${COROOT_PROJECT}${path}" 2>/dev/null
}

# ─── Coroot Commands ─────────────────────────────────────────────────────────

coroot_status() {
  echo "=== Platform Status ==="
  coroot_api "/status" | python3 -c "
import sys,json
data=json.load(sys.stdin)
ctx=data.get('context',{})
st=ctx.get('status',{})
print(f'Status: {st.get(\"status\",\"?\")}')
print(f'Prometheus: {st.get(\"prometheus\",{}).get(\"status\",\"?\")}')
print(f'Node Agent: {st.get(\"node_agent\",{}).get(\"status\",\"?\")} ({st.get(\"node_agent\",{}).get(\"nodes\",0)} nodes)')
print(f'KSM: {st.get(\"kube_state_metrics\",{}).get(\"status\",\"?\")} ({st.get(\"kube_state_metrics\",{}).get(\"applications\",0)} apps)')
" 2>/dev/null
}

coroot_app() {
  local short_name="$1"
  local app_id
  app_id=$(resolve_coroot_app_id "$short_name")

  echo "=== Health: $short_name ==="
  echo "App ID: $app_id"
  echo ""

  coroot_api "/app/${app_id}" | python3 -c "
import sys,json
data=json.load(sys.stdin)
reports=data.get('data',{}).get('reports',[])
for r in reports:
    name=r.get('name','')
    checks=r.get('checks',[])
    for c in checks:
        status=c.get('status','ok')
        title=c.get('title','')
        msg=c.get('message','')
        icon='✓' if status=='ok' else '⚠' if status=='warning' else '✗' if status in ('critical','error') else '?'
        line=f'  {icon} {title}'
        if msg:
            line += f' — {msg}'
        print(line)
    if checks:
        print()
" 2>/dev/null
}

coroot_logs() {
  local short_name="$1"
  local severity="${2:-}"
  local app_id
  app_id=$(resolve_coroot_app_id "$short_name")

  local query="limit=30"
  [[ -n "$severity" ]] && query+="&severity=$severity"

  echo "=== Logs: $short_name ($severity) ==="
  coroot_api "/app/${app_id}/logs?${query}" | python3 -c "
import sys,json,datetime
data=json.load(sys.stdin)
entries=data.get('entries',[])
print(f'Found {len(entries)} entries')
print()
for e in entries[:20]:
    ts=e.get('timestamp',0)
    dt=datetime.datetime.fromtimestamp(ts/1000000) if ts>1000000000000 else datetime.datetime.fromtimestamp(ts/1000)
    body=str(e.get('body',''))[:300]
    sev=e.get('severity','?')
    print(f'[{dt.strftime(\"%H:%M:%S\")}] [{sev}] {body}')
    print()
" 2>/dev/null
}

# ─── ABL Dev Commands ────────────────────────────────────────────────────────

abl_dev_session() {
  local session_id="$1"
  local project_id="${2:-proj-travel}"

  echo "=== Session Detail: $session_id ==="
  curl -s --max-time 25 \
    -b "$ABL_DEV_COOKIE_FILE" \
    "${ABL_DEV_URL}/api/runtime/sessions/${session_id}?projectId=${project_id}" 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
if data.get('success'):
    s=data.get('session',{})
    print(f'Agent: {s.get(\"agentName\",\"?\")}')
    print(f'Status: {s.get(\"status\",\"active\")}')
    print(f'Messages: {len(s.get(\"messages\",[]))}')
    print(f'Traces: {len(s.get(\"traceEvents\",[]))}')
    print(f'Created: {s.get(\"createdAt\",\"?\")}')
    print(f'Last Activity: {s.get(\"lastActivityAt\",\"?\")}')
else:
    err=data.get('error',{})
    if isinstance(err,dict):
        print(f'ERROR: [{err.get(\"code\",\"?\")}] {err.get(\"message\",\"?\")}')
    else:
        print(f'ERROR: {err}')
" 2>/dev/null
}

abl_dev_diagnose() {
  local target="$1"
  local project_id="${2:-proj-travel}"

  echo "=== Diagnose: $target ==="
  # Try as agent first, then as session
  local url="${ABL_DEV_URL}/api/runtime/projects/${project_id}/diagnostics/agents/${target}"
  curl -s --max-time 15 \
    -b "$ABL_DEV_COOKIE_FILE" \
    "$url" 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
if data.get('success'):
    r=data.get('data',{})
    print(f'Status: {r.get(\"status\",\"?\")}')
    print(f'Analyzers: {\", \".join(r.get(\"summary\",{}).get(\"analyzersRun\",[]))}')
    for f in r.get('findings',[]):
        icon='✗' if f['severity']=='error' else '⚠' if f['severity']=='warning' else 'ℹ'
        print(f'  {icon} [{f[\"analyzer\"]}] {f[\"title\"]}')
        print(f'    {f[\"suggestion\"]}')
else:
    print(f'ERROR: {data.get(\"error\",\"Unknown\")}')
" 2>/dev/null
}

# ─── Studio Auth ─────────────────────────────────────────────────────────────

studio_login() {
  local response
  response=$(curl -sf "${STUDIO_URL}/api/auth/dev-login" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${DEV_EMAIL}\"}" 2>&1) || {
    echo "ERROR: Dev login failed. Is Studio running at ${STUDIO_URL} with ENABLE_DEV_LOGIN=true?" >&2
    return 1
  }

  local token
  token=$(echo "$response" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$token" ]; then
    echo "ERROR: No accessToken in response" >&2
    return 1
  fi

  echo "$token" > "$STUDIO_TOKEN_CACHE"
  echo "$token"
}

studio_get_token() {
  # 1. Explicit env var
  if [ -n "${STUDIO_TOKEN:-}" ]; then
    echo "$STUDIO_TOKEN"
    return
  fi

  # 2. Cached token (< 55 min old — tokens expire in 60 min)
  if [ -f "$STUDIO_TOKEN_CACHE" ]; then
    local age
    if [[ "$OSTYPE" == "darwin"* ]]; then
      age=$(( $(date +%s) - $(stat -f%m "$STUDIO_TOKEN_CACHE") ))
    else
      age=$(( $(date +%s) - $(stat -c%Y "$STUDIO_TOKEN_CACHE") ))
    fi
    if [ "$age" -lt 3300 ]; then
      cat "$STUDIO_TOKEN_CACHE"
      return
    fi
  fi

  # 3. Fresh login
  studio_login
}

studio_request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local token
  token=$(studio_get_token)

  local curl_args=(
    -s
    -X "${method^^}"
    -H "Authorization: Bearer ${token}"
    -H "Content-Type: application/json"
  )

  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "${STUDIO_URL}${path}"
}

# ─── Main Dispatch ───────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 <service> <command> [args...]

Services:
  coroot    Coroot observability (auto-authenticates)
  abl-dev   ABL Dev environment (remote)
  studio    Studio API (local dev, auto-authenticates via dev-login)

Coroot commands:
  status                    Platform health overview
  app <name>                App health checks (runtime, clickhouse, redis, etc.)
  logs <name> [severity]    App logs (severity: error, warning, info)

ABL Dev commands:
  session <id> [projectId]  Session detail
  diagnose <name> [projId]  Run diagnostics on agent/session

Studio commands:
  login                              Get a dev token
  get    /api/path                   GET request (auto-authenticates)
  post   /api/path '{"key":"val"}'   POST request
  put    /api/path '{"key":"val"}'   PUT request
  delete /api/path                   DELETE request

App name aliases (Coroot):
  runtime, studio, admin, search-ai, mongodb, redis, clickhouse,
  qdrant, workflow-engine, multimodal, bge-m3, docling, preprocessing

Environment:
  STUDIO_URL      (default: http://localhost:5173)
  STUDIO_TOKEN    (skip login, use this token)
  DEV_EMAIL       (default: dev@kore.ai)
  ABL_DEV_URL     (default: https://agents-dev.kore.ai)
  COROOT_USERNAME (default: coroot-abl-dev@kore.ai)
  COROOT_PASSWORD (default: from settings)
EOF
}

case "${1:-}" in
  coroot)
    shift
    case "${1:-}" in
      status)     coroot_status ;;
      app)        coroot_app "${2:?Missing app name}" ;;
      logs)       coroot_logs "${2:?Missing app name}" "${3:-}" ;;
      *)          usage; exit 1 ;;
    esac
    ;;
  abl-dev)
    shift
    case "${1:-}" in
      session)    abl_dev_session "${2:?Missing session ID}" "${3:-proj-travel}" ;;
      diagnose)   abl_dev_diagnose "${2:?Missing agent/session}" "${3:-proj-travel}" ;;
      *)          usage; exit 1 ;;
    esac
    ;;
  studio)
    shift
    case "${1:-}" in
      login)    token=$(studio_login); echo "TOKEN=${token}"; echo "(Cached at ${STUDIO_TOKEN_CACHE})" ;;
      get|GET)       shift; studio_request GET "$@" ;;
      post|POST)     shift; studio_request POST "$@" ;;
      put|PUT)       shift; studio_request PUT "$@" ;;
      patch|PATCH)   shift; studio_request PATCH "$@" ;;
      delete|DELETE) shift; studio_request DELETE "$@" ;;
      *)          usage; exit 1 ;;
    esac
    ;;
  *)
    usage
    exit 1
    ;;
esac
