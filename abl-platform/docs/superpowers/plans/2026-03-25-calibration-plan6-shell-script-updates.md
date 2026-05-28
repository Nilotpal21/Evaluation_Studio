# Calibration Pipeline — Plan 6: Shell Script Updates (Service Groups)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `SERVICES` env var support to `local-run-suite.sh` and `cloud-run-suite.sh` so operators can run subsets of benchmarks by service name or `@category` group. Create a shared `service-groups.sh` library and a new `saturation-run-suite.sh` convenience wrapper.

**Architecture:** A shared Bash library (`benchmarks/scripts/lib/service-groups.sh`) defines category-to-service mappings and a `resolve_services()` function. Both suite scripts source this library and use it to filter their script arrays when `SERVICES` is set. When `SERVICES` is unset or empty, all scripts run (backward-compatible default). A new `saturation-run-suite.sh` wraps the CLI `sizing benchmark` command with the same `SERVICES` env var pattern.

**Tech Stack:** Bash, existing k6 scripts, `kore-platform-cli` CLI

**Spec:** `docs/superpowers/specs/2026-03-24-benchmark-sizing-calibration-design.md` — Section 16 (Usage Guide: Service Selection, Service Groups)

**Plan series:** This is Plan 6 of 6. Builds on all prior plans; no code dependencies on Plans 1-5 (shell-only changes).

| Plan         | Subsystem                                      | Status |
| ------------ | ---------------------------------------------- | ------ |
| 1            | Data Model + Traffic Model + Sizing Calculator | —      |
| 2            | Saturation k6 Scripts + Shared Lib             | —      |
| 3            | Coroot Metrics Collector                       | —      |
| 4            | CLI Benchmark Orchestrator                     | —      |
| 5            | Report Generation                              | —      |
| **6 (this)** | Shell Script Updates (Service Groups)          | —      |

---

## File Structure

### New Files

| File                                         | Responsibility                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `benchmarks/scripts/lib/service-groups.sh`   | Shared library: category definitions, `resolve_services()` function, `filter_scripts()` helper |
| `benchmarks/scripts/saturation-run-suite.sh` | Convenience wrapper for `npx kore-platform-cli sizing benchmark` with `SERVICES` env var       |

### Modified Files

| File                                    | Changes                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `benchmarks/scripts/local-run-suite.sh` | Source `lib/service-groups.sh`, filter `SERVICE_SCRIPTS` and `INTEGRATION_SCRIPTS` via `SERVICES` env var                    |
| `benchmarks/scripts/cloud-run-suite.sh` | Source `lib/service-groups.sh`, filter `PUBLIC_SCRIPTS`, `INTEGRATION_SCRIPTS`, and `PRIVATE_SCRIPTS` via `SERVICES` env var |

---

## Task 1: Shared Service Groups Library

**Files:**

- Create: `benchmarks/scripts/lib/service-groups.sh`

This is the core reusable library sourced by all suite scripts.

- [ ] **Step 1: Create the lib directory and service-groups.sh with category arrays** (~3 min)

Create `benchmarks/scripts/lib/service-groups.sh` with `#!/usr/bin/env bash` and `set -euo pipefail`. Define category arrays as read-only associative data:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Service group category definitions.
# Sourced by local-run-suite.sh, cloud-run-suite.sh, saturation-run-suite.sh.
#
# Usage:
#   source "$(dirname "$0")/lib/service-groups.sh"
#   resolved=$(resolve_services "$SERVICES")

# -- Category definitions (service names, not script paths) -----------------
# IMPORTANT: Keep category definitions synchronized with
# packages/kore-platform-cli/src/commands/benchmark/service-registry.ts (Plan 4).
# Both must agree on which services belong to each category.

CATEGORY_COMPUTE=(runtime studio admin)
CATEGORY_DATA_STORES=(mongodb redis opensearch qdrant clickhouse neo4j)
CATEGORY_AI=(search-ai search-ai-runtime bge-m3 docling preprocessing workflow-engine)
# @integration is handled specially — it selects ALL integration/* scripts
```

Commit: `[ABLP-2] feat(benchmarks): add service-groups.sh library with category definitions`

- [ ] **Step 2: Add resolve_services() function** (~5 min)

Add `resolve_services()` to `service-groups.sh`. This function takes a comma-separated string (e.g., `@compute,bge-m3,agent-conversation-e2e`) and outputs a deduplicated, newline-separated list of resolved service/integration names.

Logic:

1. Split input on commas
2. For each token:
   - If `@all` — return special sentinel `__ALL__`
   - If `@compute` — append `CATEGORY_COMPUTE` members
   - If `@data-stores` — append `CATEGORY_DATA_STORES` members
   - If `@ai` — append `CATEGORY_AI` members
   - If `@integration` — return special sentinel `__ALL_INTEGRATION__`
   - Otherwise — append the literal name (e.g., `runtime`, `agent-conversation-e2e`)
3. Deduplicate via `sort -u`
4. Print to stdout (one name per line)

```bash
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
    token=$(echo "$token" | xargs)  # trim whitespace
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

  # Deduplicate and output
  printf '%s\n' "${names[@]}" | sort -u
}
```

Commit: `[ABLP-2] feat(benchmarks): add resolve_services() function to service-groups.sh`

- [ ] **Step 3: Add filter_scripts() helper function** (~4 min)

Add `filter_scripts()` to `service-groups.sh`. This function takes a Bash array of script paths and the resolved service list, and outputs only the scripts whose base name (minus `.ts` extension and path prefix) matches a resolved name.

```bash
# filter_scripts <resolved-names> <script-path> [<script-path> ...]
# Outputs matching script paths, one per line.
# If resolved-names contains "__ALL__", all scripts pass through.
# If resolved-names contains "__ALL_INTEGRATION__" and script is under integration/, it passes.
filter_scripts() {
  local resolved="$1"
  shift
  local scripts=("$@")

  for script in "${scripts[@]}"; do
    # Extract base name: "services/runtime.ts" -> "runtime", "integration/agent-conversation-e2e.ts" -> "agent-conversation-e2e"
    # Also handle "benchmarks/services/runtime.ts" prefix used by cloud-run-suite.sh
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
```

The matching logic:

- `__ALL__` in resolved list means pass all scripts through
- `__ALL_INTEGRATION__` passes through any script under `integration/`
- Otherwise, match script basename (without `.ts`) against resolved names

Commit: `[ABLP-2] feat(benchmarks): add filter_scripts() helper to service-groups.sh`

- [ ] **Step 4: Add print_service_selection() diagnostic function** (~2 min)

Add a helper that prints the resolved selection for operator feedback:

```bash
# print_service_selection <services-env-value> <resolved-names>
# Prints a human-readable summary of what was selected.
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
```

Commit: `[ABLP-2] feat(benchmarks): add print_service_selection() to service-groups.sh`

---

## Task 2: Update local-run-suite.sh

**Files:**

- Modify: `benchmarks/scripts/local-run-suite.sh`

- [ ] **Step 1: Source the shared library and resolve SERVICES** (~3 min)

Add, after the `REPO_ROOT` line (line 17) and before the config sourcing:

```bash
# Source service group library
# shellcheck disable=SC1091
source "${REPO_ROOT}/benchmarks/scripts/lib/service-groups.sh"
```

After the `HEALTH_CHECK` export (line 37), add:

```bash
# Resolve service selection
SERVICES="${SERVICES:-}"
RESOLVED_SERVICES=$(resolve_services "$SERVICES")
```

Update the header echo block to include service selection info:

```bash
echo "=== k6 Local Suite Run ==="
echo "  Tier:       ${TIER}"
print_service_selection "$SERVICES" "$RESOLVED_SERVICES"
echo "  Results:    ${RESULTS_DIR}"
echo "  Timestamp:  ${TIMESTAMP}"
echo ""
```

Commit: `[ABLP-2] feat(benchmarks): source service-groups.sh in local-run-suite.sh`

- [ ] **Step 2: Filter SERVICE_SCRIPTS and INTEGRATION_SCRIPTS arrays** (~4 min)

Replace the direct iteration of `SERVICE_SCRIPTS` and `INTEGRATION_SCRIPTS` with filtered versions. After the arrays are defined (after line 103) and before the TOTAL/PASSED/FAILED counters, add:

```bash
# Filter scripts based on SERVICES selection
if ! echo "$RESOLVED_SERVICES" | grep -qx "__ALL__"; then
  FILTERED_SERVICE_SCRIPTS=()
  while IFS= read -r script; do
    [ -n "$script" ] && FILTERED_SERVICE_SCRIPTS+=("$script")
  done < <(filter_scripts "$RESOLVED_SERVICES" "${SERVICE_SCRIPTS[@]}")

  FILTERED_INTEGRATION_SCRIPTS=()
  while IFS= read -r script; do
    [ -n "$script" ] && FILTERED_INTEGRATION_SCRIPTS+=("$script")
  done < <(filter_scripts "$RESOLVED_SERVICES" "${INTEGRATION_SCRIPTS[@]}")

  SERVICE_SCRIPTS=("${FILTERED_SERVICE_SCRIPTS[@]+"${FILTERED_SERVICE_SCRIPTS[@]}"}")
  INTEGRATION_SCRIPTS=("${FILTERED_INTEGRATION_SCRIPTS[@]+"${FILTERED_INTEGRATION_SCRIPTS[@]}"}")
fi
```

The `${arr[@]+"${arr[@]}"}` syntax handles empty arrays safely under `set -u`.

Verify: `SERVICES=runtime ./benchmarks/scripts/local-run-suite.sh` should only run the runtime service script. `SERVICES=@ai ./benchmarks/scripts/local-run-suite.sh` should run search-ai, search-ai-runtime, etc. Omitting `SERVICES` runs all (backward-compatible).

Commit: `[ABLP-2] feat(benchmarks): filter local-run-suite.sh scripts via SERVICES env var`

- [ ] **Step 3: Update usage comment header** (~2 min)

Update the script header comment (lines 1-9) to document the `SERVICES` env var:

```bash
#!/usr/bin/env bash
# Run the k6 benchmark suite locally with tier-based settings.
#
# Usage:
#   TIER=s ./benchmarks/scripts/local-run-suite.sh
#   TIER=m SERVICES=runtime,search-ai ./benchmarks/scripts/local-run-suite.sh
#   SERVICES=@compute ./benchmarks/scripts/local-run-suite.sh
#   SERVICES=@ai,agent-conversation-e2e ./benchmarks/scripts/local-run-suite.sh
#
# SERVICES accepts: service names, integration names, @category groups, or combinations.
# Categories: @compute, @data-stores, @ai, @integration, @all
# Default (SERVICES unset): runs all services and integration scripts.
#
# The script uses each test's built-in scenario options (VUs, duration, stages).
# Results are exported to /tmp/k6-suite-<tier>-<timestamp>/.
#
# Prerequisites:
#   1. Fill in benchmarks/config/cloud.env with AUTH_TOKEN + REFRESH_TOKEN
#   2. Run benchmark bootstrap first (creates agents, KBs, etc.)
```

Also change the shebang from `#!/bin/bash` to `#!/usr/bin/env bash`.

Commit: `[ABLP-2] docs(benchmarks): update local-run-suite.sh header with SERVICES usage`

---

## Task 3: Update cloud-run-suite.sh

**Files:**

- Modify: `benchmarks/scripts/cloud-run-suite.sh`

- [ ] **Step 1: Source the shared library and resolve SERVICES** (~3 min)

Add after the `CLOUD_RUN` variable assignment (line 17):

```bash
# Source service group library
# shellcheck disable=SC1091
source "${REPO_ROOT}/benchmarks/scripts/lib/service-groups.sh"

# Resolve service selection
SERVICES="${SERVICES:-}"
RESOLVED_SERVICES=$(resolve_services "$SERVICES")
```

Update the header echo block to include service selection:

```bash
echo "=== k6 Cloud Suite Run ==="
echo "  Tier: ${TIER:-m}"
echo "  Env:  ${ENV:-staging}"
print_service_selection "$SERVICES" "$RESOLVED_SERVICES"
if [ ${#EXTRA_K6_ARGS[@]} -gt 0 ]; then
  echo "  Extra: ${EXTRA_K6_ARGS[*]}"
fi
echo ""
```

Commit: `[ABLP-2] feat(benchmarks): source service-groups.sh in cloud-run-suite.sh`

- [ ] **Step 2: Filter PUBLIC_SCRIPTS, INTEGRATION_SCRIPTS, and PRIVATE_SCRIPTS** (~4 min)

After the script arrays are defined (after line 50) and before `EXTRA_K6_ARGS`, add the filtering block:

```bash
# Filter scripts based on SERVICES selection
if ! echo "$RESOLVED_SERVICES" | grep -qx "__ALL__"; then
  FILTERED=()
  while IFS= read -r s; do
    [ -n "$s" ] && FILTERED+=("$s")
  done < <(filter_scripts "$RESOLVED_SERVICES" "${PUBLIC_SCRIPTS[@]}")
  PUBLIC_SCRIPTS=("${FILTERED[@]+"${FILTERED[@]}"}")

  FILTERED=()
  while IFS= read -r s; do
    [ -n "$s" ] && FILTERED+=("$s")
  done < <(filter_scripts "$RESOLVED_SERVICES" "${INTEGRATION_SCRIPTS[@]}")
  INTEGRATION_SCRIPTS=("${FILTERED[@]+"${FILTERED[@]}"}")

  FILTERED=()
  while IFS= read -r s; do
    [ -n "$s" ] && FILTERED+=("$s")
  done < <(filter_scripts "$RESOLVED_SERVICES" "${PRIVATE_SCRIPTS[@]}")
  PRIVATE_SCRIPTS=("${FILTERED[@]+"${FILTERED[@]}"}")
fi
```

Verify: `SERVICES=runtime ./benchmarks/scripts/cloud-run-suite.sh` should only run the runtime public script. `SERVICES=@data-stores ./benchmarks/scripts/cloud-run-suite.sh` should run only the private data store scripts (which are currently skipped but still listed).

Commit: `[ABLP-2] feat(benchmarks): filter cloud-run-suite.sh scripts via SERVICES env var`

- [ ] **Step 3: Update usage comment and shebang** (~2 min)

Update the header:

```bash
#!/usr/bin/env bash
# Run all critical k6 benchmark scripts on Grafana k6 Cloud.
#
# Usage:
#   ./benchmarks/scripts/cloud-run-suite.sh
#   TIER=l ./benchmarks/scripts/cloud-run-suite.sh
#   SERVICES=runtime,search-ai ./benchmarks/scripts/cloud-run-suite.sh
#   SERVICES=@compute ./benchmarks/scripts/cloud-run-suite.sh
#
# SERVICES accepts: service names, integration names, @category groups, or combinations.
# Categories: @compute, @data-stores, @ai, @integration, @all
# Default (SERVICES unset): runs all services and integration scripts.
#
# Prerequisites: same as cloud-run.sh
```

Also change the shebang from `#!/bin/bash` to `#!/usr/bin/env bash`.

Commit: `[ABLP-2] docs(benchmarks): update cloud-run-suite.sh header with SERVICES usage`

---

## Task 4: Saturation Run Suite Script

**Files:**

- Create: `benchmarks/scripts/saturation-run-suite.sh`

- [ ] **Step 1: Create the saturation-run-suite.sh wrapper** (~5 min)

Create `benchmarks/scripts/saturation-run-suite.sh` as a convenience wrapper around `npx kore-platform-cli sizing benchmark`. This script:

- Uses `#!/usr/bin/env bash` and `set -euo pipefail`
- Sources `lib/service-groups.sh` (not strictly needed since CLI handles `--services` internally, but used for validation and diagnostic output)
- Reads `SERVICES`, `TIER`, output path env vars
- Forwards to the CLI command

```bash
#!/usr/bin/env bash
# Run saturation benchmarks (calibration pipeline) for selected services.
#
# Usage:
#   TIER=m ./benchmarks/scripts/saturation-run-suite.sh
#   SERVICES=@compute TIER=m ./benchmarks/scripts/saturation-run-suite.sh
#   SERVICES=runtime,search-ai TIER=m ./benchmarks/scripts/saturation-run-suite.sh
#
# SERVICES accepts: service names, integration names, @category groups, or combinations.
# Categories: @compute, @data-stores, @ai, @integration, @all
# Default (SERVICES unset): runs all services.
#
# This is a convenience wrapper around:
#   npx kore-platform-cli sizing benchmark --tier <TIER> --services <SERVICES> ...
#
# Prerequisites:
#   1. kubectl access to AKS cluster (see design spec Section 15)
#   2. Coroot MCP connected via .mcp.json
#   3. benchmarks/config/cloud.env configured

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

# Source config
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
else
  echo "ERROR: $CONFIG_FILE not found."
  exit 1
fi

# Source service group library for validation/diagnostics
# shellcheck disable=SC1091
source "${REPO_ROOT}/benchmarks/scripts/lib/service-groups.sh"

TIER="${TIER:-m}"
SERVICES="${SERVICES:-}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/benchmarks/results/saturation}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Resolve for diagnostic output
RESOLVED_SERVICES=$(resolve_services "$SERVICES")

echo "=== Saturation Benchmark Suite ==="
echo "  Tier:       ${TIER}"
print_service_selection "$SERVICES" "$RESOLVED_SERVICES"
echo "  Output:     ${OUTPUT_DIR}"
echo "  Timestamp:  ${TIMESTAMP}"
echo ""

# Build CLI arguments
CLI_ARGS=(
  sizing benchmark
  --tier "$TIER"
  --output-calibration "${OUTPUT_DIR}/calibration-${TIER}-${TIMESTAMP}.json"
  --output-report "${OUTPUT_DIR}/report-${TIER}-${TIMESTAMP}.md"
)

# Add --services flag only when SERVICES is explicitly set
if [ -n "$SERVICES" ]; then
  CLI_ARGS+=(--services "$SERVICES")
fi

# Forward extra arguments (e.g., --dry-run, --scenario-weights)
if [ $# -gt 0 ]; then
  CLI_ARGS+=("$@")
fi

mkdir -p "$OUTPUT_DIR"

echo "Running: npx kore-platform-cli ${CLI_ARGS[*]}"
echo ""

npx kore-platform-cli "${CLI_ARGS[@]}"

echo ""
echo "=== Saturation Suite Complete ==="
echo "  Calibration: ${OUTPUT_DIR}/calibration-${TIER}-${TIMESTAMP}.json"
echo "  Report:      ${OUTPUT_DIR}/report-${TIER}-${TIMESTAMP}.md"
```

Make the script executable: `chmod +x benchmarks/scripts/saturation-run-suite.sh`

Commit: `[ABLP-2] feat(benchmarks): add saturation-run-suite.sh convenience wrapper`

- [ ] **Step 2: Create results output directory** (~1 min)

Add a `.gitkeep` to `benchmarks/results/saturation/` so the output directory structure is tracked:

```bash
mkdir -p benchmarks/results/saturation
touch benchmarks/results/saturation/.gitkeep
```

Ensure `benchmarks/results/` is in `.gitignore` except for `.gitkeep` (check existing `.gitignore` entries first).

Commit: `[ABLP-2] chore(benchmarks): add saturation results directory with .gitkeep`

---

## Task 5: Verification and Smoke Testing

- [ ] **Step 1: Verify service-groups.sh can be sourced without errors** (~2 min)

Run a quick shell verification:

```bash
cd benchmarks
source scripts/lib/service-groups.sh

# Test resolve_services
echo "--- @compute ---"
resolve_services "@compute"

echo "--- @data-stores ---"
resolve_services "@data-stores"

echo "--- @ai ---"
resolve_services "@ai"

echo "--- mixed ---"
resolve_services "@compute,bge-m3,agent-conversation-e2e"

echo "--- empty (should be __ALL__) ---"
resolve_services ""

echo "--- @all ---"
resolve_services "@all"
```

Expected output:

- `@compute` resolves to: `admin`, `runtime`, `studio`
- `@data-stores` resolves to: `clickhouse`, `mongodb`, `neo4j`, `opensearch`, `qdrant`, `redis`
- `@ai` resolves to: `bge-m3`, `docling`, `preprocessing`, `search-ai`, `search-ai-runtime`
- mixed resolves to: `admin`, `agent-conversation-e2e`, `bge-m3`, `runtime`, `studio`
- empty resolves to: `__ALL__`
- `@all` resolves to: `__ALL__`

- [ ] **Step 2: Verify filter_scripts() works with local-run-suite.sh paths** (~2 min)

```bash
source scripts/lib/service-groups.sh

resolved=$(resolve_services "@compute")
echo "--- Filtered service scripts for @compute ---"
filter_scripts "$resolved" "services/runtime.ts" "services/studio.ts" "services/search-ai.ts" "services/search-ai-runtime.ts" "services/crawler.ts"
# Expected: services/runtime.ts, services/studio.ts (crawler and search-ai* are NOT in @compute)
```

Note: `admin` is in `@compute` but there is no `services/admin.ts` script yet, so it simply has no match (which is correct — it will match once the script exists).

- [ ] **Step 3: Verify filter_scripts() works with cloud-run-suite.sh paths** (~2 min)

Cloud scripts use `benchmarks/` prefix:

```bash
source scripts/lib/service-groups.sh

resolved=$(resolve_services "@data-stores")
echo "--- Filtered private scripts for @data-stores ---"
filter_scripts "$resolved" "benchmarks/services/bge-m3.ts" "benchmarks/services/mongodb.ts" "benchmarks/services/opensearch.ts" "benchmarks/services/clickhouse.ts" "benchmarks/services/qdrant.ts" "benchmarks/services/neo4j.ts" "benchmarks/services/redis.ts" "benchmarks/services/restate.ts" "benchmarks/services/docling.ts" "benchmarks/services/preprocessing.ts"
# Expected: mongodb, opensearch, clickhouse, qdrant, neo4j, redis (NOT bge-m3, restate, docling, preprocessing)
```

- [ ] **Step 4: Verify backward compatibility (no SERVICES set)** (~2 min)

```bash
# Unset SERVICES and verify scripts would run all
unset SERVICES
source scripts/lib/service-groups.sh

resolved=$(resolve_services "${SERVICES:-}")
echo "$resolved"
# Expected: __ALL__
```

Confirm that when `__ALL__` is in the resolved list, `filter_scripts` passes all scripts through.

- [ ] **Step 5: Verify all scripts have correct shebang and permissions** (~2 min)

```bash
# Check shebangs
head -1 scripts/lib/service-groups.sh scripts/saturation-run-suite.sh scripts/local-run-suite.sh scripts/cloud-run-suite.sh

# Ensure executable
ls -la scripts/lib/service-groups.sh scripts/saturation-run-suite.sh scripts/local-run-suite.sh scripts/cloud-run-suite.sh
```

All scripts should have `#!/usr/bin/env bash` and executable permissions (`chmod +x`).

Commit: (no commit for verification — these are manual checks)

---

## Task 6: Final Formatting and Cleanup

- [ ] **Step 1: Run prettier on all changed files** (~1 min)

```bash
npx prettier --write \
  benchmarks/scripts/lib/service-groups.sh \
  benchmarks/scripts/saturation-run-suite.sh \
  benchmarks/scripts/local-run-suite.sh \
  benchmarks/scripts/cloud-run-suite.sh
```

Note: Prettier may not format `.sh` files (no built-in Bash support). If it skips them, that is fine — shell scripts are not covered by the pre-commit prettier check.

Commit: `[ABLP-2] style(benchmarks): format shell scripts`

---

## Summary of Commits

| #   | Message                                                                              | Files                                        |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| 1   | `[ABLP-2] feat(benchmarks): add service-groups.sh library with category definitions` | `benchmarks/scripts/lib/service-groups.sh`   |
| 2   | `[ABLP-2] feat(benchmarks): add resolve_services() function to service-groups.sh`    | `benchmarks/scripts/lib/service-groups.sh`   |
| 3   | `[ABLP-2] feat(benchmarks): add filter_scripts() helper to service-groups.sh`        | `benchmarks/scripts/lib/service-groups.sh`   |
| 4   | `[ABLP-2] feat(benchmarks): add print_service_selection() to service-groups.sh`      | `benchmarks/scripts/lib/service-groups.sh`   |
| 5   | `[ABLP-2] feat(benchmarks): source service-groups.sh in local-run-suite.sh`          | `benchmarks/scripts/local-run-suite.sh`      |
| 6   | `[ABLP-2] feat(benchmarks): filter local-run-suite.sh scripts via SERVICES env var`  | `benchmarks/scripts/local-run-suite.sh`      |
| 7   | `[ABLP-2] docs(benchmarks): update local-run-suite.sh header with SERVICES usage`    | `benchmarks/scripts/local-run-suite.sh`      |
| 8   | `[ABLP-2] feat(benchmarks): source service-groups.sh in cloud-run-suite.sh`          | `benchmarks/scripts/cloud-run-suite.sh`      |
| 9   | `[ABLP-2] feat(benchmarks): filter cloud-run-suite.sh scripts via SERVICES env var`  | `benchmarks/scripts/cloud-run-suite.sh`      |
| 10  | `[ABLP-2] docs(benchmarks): update cloud-run-suite.sh header with SERVICES usage`    | `benchmarks/scripts/cloud-run-suite.sh`      |
| 11  | `[ABLP-2] feat(benchmarks): add saturation-run-suite.sh convenience wrapper`         | `benchmarks/scripts/saturation-run-suite.sh` |
| 12  | `[ABLP-2] chore(benchmarks): add saturation results directory with .gitkeep`         | `benchmarks/results/saturation/.gitkeep`     |
| 13  | `[ABLP-2] style(benchmarks): format shell scripts`                                   | All changed `.sh` files                      |
