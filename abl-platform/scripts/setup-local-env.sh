#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

echo "=== ABL Platform — Local Environment Setup ==="
echo ""

# --- Check Docker is running ---
echo "[1/3] Checking Docker..."
if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker is not running. Please start Docker Desktop and try again."
  exit 1
fi
echo "      Docker is running."

# --- Start backend services ---
echo "[2/3] Starting backend services..."
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d
echo "      Services started."

# --- Create .env files from templates ---
echo "[3/3] Setting up .env files..."

copy_template() {
  local template="$1"
  local target="$2"
  local label="$3"

  if [ ! -f "$template" ]; then
    echo "      WARN: Template not found: $template — skipping $label"
    return
  fi

  if [ -f "$target" ] && [ "$FORCE" = false ]; then
    echo "      SKIP: $label .env already exists (use --force to overwrite)"
  else
    cp "$template" "$target"
    echo "      OK:   $label .env created from template"
  fi
}

copy_template "$REPO_ROOT/apps/runtime/.env.template" "$REPO_ROOT/apps/runtime/.env" "runtime"
copy_template "$REPO_ROOT/apps/studio/.env.template"  "$REPO_ROOT/apps/studio/.env"  "studio"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Backend services:"
echo "  MongoDB:        mongodb://admin:localdev@localhost:27017"
echo "  ClickHouse:     http://localhost:8123"
echo "  Redis:          redis://localhost:6379"
echo "  OTEL Collector: http://localhost:4317 (gRPC), http://localhost:4318 (HTTP)"
echo "  Jaeger UI:      http://localhost:16686"
echo ""
echo "Quick start:"
echo "  pnpm install        # install dependencies"
echo "  pnpm build          # build all packages"
echo "  pnpm dev            # start runtime + studio in dev mode"
echo ""
echo "Useful commands:"
echo "  docker compose ps        # check running services"
echo "  docker compose logs -f   # follow service logs"
echo "  docker compose down      # stop services"
echo "  docker compose down -v   # stop services and remove data"
