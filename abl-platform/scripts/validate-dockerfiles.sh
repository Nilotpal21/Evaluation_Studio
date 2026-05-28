#!/usr/bin/env bash
# ------------------------------------------------------------------
# validate-dockerfiles.sh
#
# Fast pre-push check: for every Node.js Dockerfile that uses turbo
# build, verify that all workspace packages in turbo's build graph
# have their package.json listed as COPY lines. Catches CI failures
# where a new workspace dependency is added but the Dockerfile isn't
# updated, causing `node_modules missing` errors in Docker builds.
#
# Requires: pnpm, turbo (available in dev environment)
# Exit 0 = all good, Exit 1 = missing entries found.
# ------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ERRORS=0
EXCLUDED_PACKAGE_DIRS=("packages/helix")

# --- Build workspace package lookup ---
# Maps npm name -> relative dir via temp file lines
PKG_LOOKUP=$(mktemp)
trap 'rm -f "$PKG_LOOKUP" 2>/dev/null' EXIT

for pkg_json in "$REPO_ROOT"/packages/*/package.json "$REPO_ROOT"/apps/*/package.json; do
  [ -f "$pkg_json" ] || continue
  dir=$(dirname "$pkg_json")
  rel_dir="${dir#$REPO_ROOT/}"
  name=$(grep '"name"' "$pkg_json" | head -1 | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
  [ -n "$name" ] && echo "$name|$rel_dir" >> "$PKG_LOOKUP"
done

resolve_pkg_dir() {
  local match
  match=$(grep "^${1}|" "$PKG_LOOKUP" 2>/dev/null || true)
  [ -z "$match" ] && return 0
  echo "$match" | head -1 | cut -d'|' -f2
}

is_excluded_pkg_dir() {
  local pkg_dir="$1"

  for excluded in "${EXCLUDED_PACKAGE_DIRS[@]}"; do
    if [ "$pkg_dir" = "$excluded" ]; then
      return 0
    fi
  done

  return 1
}

# --- Validate each Node.js Dockerfile ---
for dockerfile in "$REPO_ROOT"/apps/*/Dockerfile; do
  [ -f "$dockerfile" ] || continue
  grep -q "pnpm install" "$dockerfile" || continue

  app_dir=$(basename "$(dirname "$dockerfile")")

  # Skip Dockerfiles that copy full packages/ before pnpm install (no individual COPY needed)
  # These use a simpler pattern: COPY packages/ packages/ before RUN pnpm install
  INSTALL_LINE=$(grep -n "pnpm install" "$dockerfile" | head -1 | cut -d: -f1)
  if [ -n "$INSTALL_LINE" ] && sed -n "1,${INSTALL_LINE}p" "$dockerfile" | grep -qE '^COPY[[:space:]]+packages/[[:space:]]'; then
    continue
  fi

  # Determine the turbo filter target from the Dockerfile
  turbo_filter=$(grep -oE -- '--filter=[^[:space:]]+' "$dockerfile" | head -1 | sed 's/--filter=//' || true)
  if [ -z "$turbo_filter" ]; then
    # Infer from the app's package.json name
    app_pkg="$REPO_ROOT/apps/$app_dir/package.json"
    [ -f "$app_pkg" ] || continue
    turbo_filter=$(grep '"name"' "$app_pkg" | head -1 | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  fi
  [ -z "$turbo_filter" ] && continue

  # Get turbo's build dependency graph (the packages turbo will build)
  TURBO_PKGS=$(pnpm turbo build --filter="$turbo_filter" --dry-run 2>/dev/null \
    | grep -E '^@' | sed 's/#build$//' | sort -u || true)

  [ -z "$TURBO_PKGS" ] && continue

  # Skip Dockerfiles that copy entire packages/ directory (all deps included)
  if grep -qE '^COPY[[:space:]]+packages/[[:space:]]' "$dockerfile"; then
    continue
  fi

  # Get list of package dirs whose package.json is COPYed in the Dockerfile
  COPIED_FILE=$(mktemp)
  (grep -E '^COPY[[:space:]]+(packages|apps)/[^/]+/package\.json' "$dockerfile" || true) \
    | awk '{print $2}' \
    | while IFS= read -r src; do dirname "$src"; done \
    > "$COPIED_FILE"

  # Check each turbo-required package has a COPY line
  MISSING=""
  for pkg_name in $TURBO_PKGS; do
    pkg_dir=$(resolve_pkg_dir "$pkg_name")
    [ -z "$pkg_dir" ] && continue
    is_excluded_pkg_dir "$pkg_dir" && continue

    # Skip the app itself (it's always copied separately via COPY apps/<app>/)
    case "$pkg_dir" in apps/"$app_dir") continue ;; esac

    if ! grep -qx "$pkg_dir" "$COPIED_FILE" 2>/dev/null; then
      MISSING="${MISSING}  COPY ${pkg_dir}/package.json $(printf '%-30s' '')${pkg_dir}/package.json\n"
    fi
  done

  rm -f "$COPIED_FILE"

  if [ -n "$MISSING" ]; then
    echo "ERROR: apps/$app_dir/Dockerfile is missing COPY lines for:"
    printf "$MISSING"
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo "Dockerfile validation failed. Add the missing COPY lines above."
  exit 1
fi

echo "Dockerfile workspace dependency check passed."
exit 0
