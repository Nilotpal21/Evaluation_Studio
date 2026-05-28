#!/bin/bash
# Verify all workspace packages have COPY lines in Dockerfiles
# Prevents: "pnpm install --frozen-lockfile" failures in Docker builds
#
# Usage:
#   ./tools/verify-dockerfile-copies.sh          # check all Dockerfiles
#   ./tools/verify-dockerfile-copies.sh --ci      # same, but for CI pipelines
#
# Exit codes:
#   0 — all packages accounted for in all Dockerfiles
#   1 — missing COPY lines detected (details printed to stderr)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# 1. Discover all workspace packages (packages/* and packages/connectors/*)
# ---------------------------------------------------------------------------
WORKSPACE_PACKAGES=()
EXCLUDED_PACKAGES=(
  "packages/helix"
)

for pkg_json in "$REPO_ROOT"/packages/*/package.json; do
  pkg_dir="$(dirname "$pkg_json")"
  pkg_name="$(basename "$pkg_dir")"
  # Relative path from repo root: packages/<name>
  WORKSPACE_PACKAGES+=("packages/$pkg_name")
done

for pkg_json in "$REPO_ROOT"/packages/connectors/*/package.json; do
  [ -f "$pkg_json" ] || continue
  pkg_dir="$(dirname "$pkg_json")"
  pkg_name="$(basename "$pkg_dir")"
  WORKSPACE_PACKAGES+=("packages/connectors/$pkg_name")
done

if [ ${#WORKSPACE_PACKAGES[@]} -eq 0 ]; then
  echo "ERROR: No workspace packages found under $REPO_ROOT/packages/" >&2
  exit 1
fi

is_excluded_package() {
  local pkg_path="$1"
  for excluded in "${EXCLUDED_PACKAGES[@]}"; do
    if [ "$pkg_path" = "$excluded" ]; then
      return 0
    fi
  done

  return 1
}

# ---------------------------------------------------------------------------
# 2. Find Dockerfiles that use pnpm install --frozen-lockfile AND copy
#    individual package.json files (not bulk COPY packages/ packages/)
# ---------------------------------------------------------------------------
DOCKERFILES=()

for dockerfile in "$REPO_ROOT"/apps/*/Dockerfile "$REPO_ROOT"/packages/*/Dockerfile; do
  [ -f "$dockerfile" ] || continue

  # Skip Dockerfiles that don't use frozen-lockfile pnpm install
  if ! grep -q 'pnpm install --frozen-lockfile' "$dockerfile"; then
    continue
  fi

  # Skip Dockerfiles that copy packages/ wholesale (e.g., workflow-engine)
  # These don't need individual package.json COPY lines since they copy everything
  if grep -qE '^COPY packages/ packages/' "$dockerfile" && \
     ! grep -qE '^COPY packages/[a-z]' "$dockerfile"; then
    continue
  fi

  DOCKERFILES+=("$dockerfile")
done

if [ ${#DOCKERFILES[@]} -eq 0 ]; then
  echo "No Dockerfiles with pnpm install --frozen-lockfile found. Nothing to check."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Check each Dockerfile for missing package COPY lines
# ---------------------------------------------------------------------------
MISSING=()
CHECKED=0

for dockerfile in "${DOCKERFILES[@]}"; do
  dockerfile_label="${dockerfile#$REPO_ROOT/}"

  for pkg_path in "${WORKSPACE_PACKAGES[@]}"; do
    if is_excluded_package "$pkg_path"; then
      continue
    fi

    CHECKED=$((CHECKED + 1))
    # Look for: COPY <pkg_path>/package.json <pkg_path>/package.json
    # Allow flexible whitespace between source and dest
    if ! grep -qE "^COPY[[:space:]]+${pkg_path}/package\.json[[:space:]]" "$dockerfile"; then
      MISSING+=("$dockerfile_label  missing  $pkg_path/package.json")
    fi
  done
done

# ---------------------------------------------------------------------------
# 4. Report results
# ---------------------------------------------------------------------------
if [ ${#MISSING[@]} -eq 0 ]; then
  echo "OK: All ${#WORKSPACE_PACKAGES[@]} workspace packages are COPY'd in ${#DOCKERFILES[@]} Dockerfiles ($CHECKED checks)."
  exit 0
fi

echo "" >&2
echo "ERROR: ${#MISSING[@]} missing package.json COPY line(s) in Dockerfiles:" >&2
echo "" >&2
printf "  %s\n" "${MISSING[@]}" >&2
echo "" >&2
echo "Fix: Add a COPY line for each missing package to the Dockerfile's" >&2
echo "     'Copy all workspace package.json files' section. Example:" >&2
echo "" >&2
echo "  COPY packages/<name>/package.json packages/<name>/package.json" >&2
echo "" >&2
exit 1
