#!/usr/bin/env bash
set -euo pipefail

# Service group category definitions.
# Sourced by local-run-suite.sh, cloud-run-suite.sh, saturation-run-suite.sh.
#
# Usage:
#   source "$(dirname "$0")/lib/service-groups.sh"
#   resolved=$(resolve_services "$SERVICES")

# IMPORTANT: Keep synchronized with
# packages/kore-platform-cli/src/commands/benchmark/service-registry.ts

CATEGORY_COMPUTE=(runtime studio admin)
CATEGORY_DATA_STORES=(mongodb redis opensearch qdrant clickhouse neo4j)
CATEGORY_AI=(search-ai search-ai-runtime bge-m3 docling preprocessing workflow-engine)

# resolve_services <comma-separated-services>
# Outputs resolved service names, one per line. Handles @category expansion.
# Special return values: "__ALL__" means run everything.
resolve_services() {
  local input="${1:-}"
  if [ -z "$input" ]; then
    echo "__ALL__"
    return
  fi

  local names=()
  local include_all_integration=false

  IFS=',' read -ra tokens <<< "$input"
  for token in "${tokens[@]}"; do
    token=$(echo "$token" | xargs)
    case "$token" in
      @all)
        echo "__ALL__"
        return
        ;;
      @compute)
        names+=("${CATEGORY_COMPUTE[@]}")
        ;;
      @data-stores)
        names+=("${CATEGORY_DATA_STORES[@]}")
        ;;
      @ai)
        names+=("${CATEGORY_AI[@]}")
        ;;
      @integration)
        include_all_integration=true
        ;;
      *)
        names+=("$token")
        ;;
    esac
  done

  if [ "$include_all_integration" = true ]; then
    echo "__ALL_INTEGRATION__"
  fi

  if [ ${#names[@]} -gt 0 ]; then
    printf '%s\n' "${names[@]}" | sort -u
  fi
}

# filter_scripts <resolved-names> <script-path> [<script-path> ...]
# Outputs matching script paths, one per line.
filter_scripts() {
  local resolved="$1"
  shift
  local scripts=("$@")

  for script in "${scripts[@]}"; do
    local base
    base=$(basename "$script" .ts)

    if echo "$resolved" | grep -qx "__ALL__"; then
      echo "$script"
    elif echo "$script" | grep -q "integration/" && echo "$resolved" | grep -qx "__ALL_INTEGRATION__"; then
      echo "$script"
    elif echo "$resolved" | grep -qx "$base"; then
      echo "$script"
    fi
  done
}

# print_service_selection <services-env-value> <resolved-names>
print_service_selection() {
  local services_env="${1:-}"
  local resolved="$2"

  if [ -z "$services_env" ] || echo "$resolved" | grep -qx "__ALL__"; then
    echo "  Services:   ALL (default)"
  else
    local count
    count=$(echo "$resolved" | grep -v "^__" | wc -l | xargs)
    echo "  Services:   ${services_env}"
    echo "  Resolved:   ${count} service(s)/integration(s)"
  fi
}
