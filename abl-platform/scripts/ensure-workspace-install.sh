#!/bin/sh

set -eu

context="${1:-}"

if [ -n "$context" ]; then
  context_suffix=" for ${context}"
else
  context_suffix=""
fi

find_missing_workspace_node_modules() {
  for manifest in packages/*/package.json packages/connectors/*/package.json apps/*/package.json; do
    [ -f "$manifest" ] || continue

    case "$manifest" in
      packages/helix/package.json | apps/_platform-retired/package.json)
        continue
        ;;
    esac

    if ! grep -Eq '"(dependencies|devDependencies|optionalDependencies|peerDependencies)"[[:space:]]*:' "$manifest"; then
      continue
    fi

    pkg_dir=$(dirname "$manifest")

    if [ ! -d "$pkg_dir/node_modules" ]; then
      printf '%s\n' "$pkg_dir"
      return 0
    fi
  done

  return 1
}

# Harness restores the cached root node_modules directory, but workspace-level
# node_modules symlinks may still be absent for some packages. Re-run install
# whenever the cache looks incomplete so newly added packages resolve correctly.
if [ -x node_modules/.bin/turbo ] && [ -d node_modules/.pnpm ]; then
  missing_dir=$(find_missing_workspace_node_modules || true)

  if [ -n "$missing_dir" ]; then
    echo "=== Workspace install incomplete${context_suffix} (missing ${missing_dir}/node_modules) — running pnpm install ==="
    pnpm install --frozen-lockfile
  else
    echo "=== Reusing cached workspace install${context_suffix} ==="
  fi
else
  echo "=== No cached workspace install found${context_suffix} — running pnpm install ==="
  pnpm install --frozen-lockfile
fi
