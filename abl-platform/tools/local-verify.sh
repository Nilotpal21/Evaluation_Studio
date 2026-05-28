#!/usr/bin/env bash

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

MODE="${1:-all}"
BASE_REF_INPUT="${2:-${LOCAL_VERIFY_REF:-}}"

case "$MODE" in
  all | plan | build | typecheck | test) ;;
  *)
    echo "Usage: bash tools/local-verify.sh [plan|build|typecheck|test|all] [base-ref]"
    echo ""
    echo "Examples:"
    echo "  bash tools/local-verify.sh plan"
    echo "  bash tools/local-verify.sh all origin/develop"
    echo "  LOCAL_VERIFY_REF=origin/main bash tools/local-verify.sh test"
    exit 1
    ;;
esac

append_unique() {
  local array_name=$1
  local value=$2
  local item
  local count

  [ -z "$value" ] && return 0

  eval "count=\${#${array_name}[@]}"
  if [ "$count" -gt 0 ]; then
    eval "for item in \"\${${array_name}[@]}\"; do
      if [ \"\$item\" = \"\$value\" ]; then
        return 0
      fi
    done"
  fi

  eval "$array_name+=(\"\$value\")"
}

join_by() {
  local delimiter=$1
  shift || true
  local first=1
  local value

  for value in "$@"; do
    if [ "$first" -eq 1 ]; then
      printf '%s' "$value"
      first=0
    else
      printf '%s%s' "$delimiter" "$value"
    fi
  done
}

map_runtime_domain() {
  local path=$1

  case "$path" in
    apps/runtime/src/__tests__/execution/* | apps/runtime/src/contexts/* | apps/runtime/src/*reasoning* | apps/runtime/src/*flow* | apps/runtime/src/*runtime-executor* | apps/runtime/src/*guardrail* | apps/runtime/src/*event-bus*)
      echo "execution"
      ;;
    apps/runtime/src/__tests__/channels/* | apps/runtime/src/*channel* | apps/runtime/src/*voice* | apps/runtime/src/*webhook* | apps/runtime/src/*websocket* | apps/runtime/src/*livekit* | apps/runtime/src/*omnichannel* | apps/runtime/src/adapters/* | apps/runtime/src/services/agent-transfer/*)
      echo "channels"
      ;;
    apps/runtime/src/__tests__/auth/* | apps/runtime/src/*auth* | apps/runtime/src/*sdk* | apps/runtime/src/*kms* | apps/runtime/src/*encryption* | apps/runtime/src/middleware/*)
      echo "auth"
      ;;
    apps/runtime/src/__tests__/extraction/* | apps/runtime/src/*extract* | apps/runtime/src/*constraint* | apps/runtime/src/*gather* | apps/runtime/src/*field*)
      echo "extraction"
      ;;
    apps/runtime/src/__tests__/routing/* | apps/runtime/src/*routing* | apps/runtime/src/*delegate* | apps/runtime/src/*fan-out* | apps/runtime/src/*prompt-builder*)
      echo "routing"
      ;;
    apps/runtime/src/__tests__/sessions/* | apps/runtime/src/*session* | apps/runtime/src/*repo* | apps/runtime/src/*store* | apps/runtime/src/*migration*)
      echo "sessions"
      ;;
    apps/runtime/src/__tests__/tools-deployment/* | apps/runtime/src/*attachment* | apps/runtime/src/*tool* | apps/runtime/src/*deployment* | apps/runtime/src/*module*)
      echo "tools-deployment"
      ;;
    apps/runtime/src/__tests__/observability/* | apps/runtime/src/*trace* | apps/runtime/src/*observ* | apps/runtime/src/*clickhouse* | apps/runtime/src/*circuit-breaker*)
      echo "observability"
      ;;
    *)
      echo ""
      ;;
  esac
}

map_studio_target() {
  local path=$1

  case "$path" in
    apps/studio/src/__tests__/api-routes/* | apps/studio/src/app/api/*)
      echo "node:api-routes"
      ;;
    apps/studio/src/__tests__/e2e/*)
      echo "node:e2e"
      ;;
    apps/studio/src/__tests__/integration/*)
      echo "node:integration"
      ;;
    apps/studio/src/__tests__/search-ai/* | apps/studio/src/components/search-ai/* | apps/studio/src/app/search-ai/* | apps/studio/src/lib/*search* | apps/studio/src/lib/*crawl*)
      echo "split:search-ai"
      ;;
    apps/studio/src/__tests__/arch-ai/* | apps/studio/src/app/arch/* | apps/studio/src/lib/arch*)
      echo "split:arch-ai"
      ;;
    apps/studio/src/__tests__/components/* | apps/studio/src/components/*)
      echo "split:components"
      ;;
    apps/studio/src/__tests__/hooks/* | apps/studio/src/hooks/*)
      echo "split:hooks"
      ;;
    apps/studio/src/__tests__/stores/* | apps/studio/src/store/* | apps/studio/src/lib/*)
      echo "split:stores"
      ;;
    *)
      echo ""
      ;;
  esac
}

resolve_base_ref() {
  if [ -n "$BASE_REF_INPUT" ]; then
    echo "$BASE_REF_INPUT"
    return 0
  fi

  git rev-parse @{upstream} 2> /dev/null || git rev-parse origin/develop 2> /dev/null || echo ""
}

collect_changed_files() {
  local base_ref=$1

  {
    if [ -n "$base_ref" ]; then
      git diff --name-only "$base_ref"...HEAD 2> /dev/null || git diff --name-only "$base_ref" HEAD 2> /dev/null || true
    fi
    git diff --name-only HEAD 2> /dev/null || true
    git ls-files --others --exclude-standard 2> /dev/null || true
  } | awk 'NF && !seen[$0]++'
}

resolve_changed_packages() {
  node -e '
const fs = require("fs");
const path = require("path");

const changedFiles = fs
  .readFileSync(0, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const rootConfigPattern =
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.npmrc|\.nvmrc|tsconfig\.json|package\.json|coverage-thresholds\.json|\.eslintrc\.base\.json|commitlint\.config\.ts)$/;

if (changedFiles.some((file) => rootConfigPattern.test(file))) {
  process.stdout.write("FULL_REPO=true\n");
  process.stdout.write("CHANGED_PACKAGES=\n");
  process.exit(0);
}

function collectPackageFiles(rootDir, depth) {
  const results = [];
  if (!fs.existsSync(rootDir)) {
    return results;
  }

  function walk(currentDir, currentDepth) {
    if (currentDepth > depth) {
      return;
    }

    const packageJson = path.join(currentDir, "package.json");
    if (fs.existsSync(packageJson)) {
      results.push(packageJson);
    }

    if (currentDepth === depth) {
      return;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      walk(path.join(currentDir, entry.name), currentDepth + 1);
    }
  }

  walk(rootDir, 0);
  return results;
}

const packageFiles = [
  ...collectPackageFiles("apps", 2),
  ...collectPackageFiles("packages", 3),
];

const workspaceMappings = packageFiles
  .map((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data.name) {
        return null;
      }

      return {
        dir: path.posix.dirname(file.split(path.sep).join(path.posix.sep)),
        name: data.name,
      };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((left, right) => right.dir.length - left.dir.length);

const packages = new Set();

for (const changedFile of changedFiles) {
  for (const mapping of workspaceMappings) {
    if (changedFile === mapping.dir || changedFile.startsWith(`${mapping.dir}/`)) {
      packages.add(mapping.name);
      break;
    }
  }
}

process.stdout.write("FULL_REPO=false\n");
process.stdout.write(`CHANGED_PACKAGES=${Array.from(packages).join(",")}\n`);
'
}

turbo_query() {
  local task=$1
  shift

  pnpm turbo "$task" "$@" --dry=json 2> /dev/null
}

turbo_task_count() {
  local task=$1
  shift

  turbo_query "$task" "$@" | node -e '
const fs = require("fs");

const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("{");
if (start === -1) {
  console.log("0");
  process.exit(0);
}

const data = JSON.parse(raw.slice(start));
console.log(Array.isArray(data.tasks) ? data.tasks.length : 0);
'
}

turbo_has_package() {
  local task=$1
  local package_name=$2
  shift 2

  turbo_query "$task" "$@" | PACKAGE_NAME="$package_name" node -e '
const fs = require("fs");

const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("{");
if (start === -1) {
  console.log("false");
  process.exit(0);
}

const data = JSON.parse(raw.slice(start));
const packageName = process.env.PACKAGE_NAME;
const tasks = Array.isArray(data.tasks) ? data.tasks : [];
console.log(tasks.some((task) => task.package === packageName) ? "true" : "false");
'
}

print_command() {
  local value
  for value in "$@"; do
    printf '%q ' "$value"
  done
  echo ""
}

run_or_print() {
  if [ "$MODE" = "plan" ]; then
    echo "  would run: $(print_command "$@")"
  else
    "$@"
  fi
}

run_mock_export_drift_check() {
  echo "━━━ Mock Export Drift"

  if [ "${SKIP_MOCK_DRIFT:-}" = "1" ]; then
    echo "  skip: SKIP_MOCK_DRIFT=1"
    echo ""
    return 0
  fi

  if [ ! -f "$ROOT/tools/mock-export-drift-check.mjs" ]; then
    echo "  skip: detector not present"
    echo ""
    return 0
  fi

  if [ "$FULL_REPO" != "true" ]; then
    if ! printf '%s\n' "$CHANGED_FILES" | grep -qE '\.(ts|tsx)$'; then
      echo "  skip: no TypeScript source/test changes"
      echo ""
      return 0
    fi
  fi

  if [ -n "$BASE_REF" ]; then
    run_or_print node tools/mock-export-drift-check.mjs --base "$BASE_REF"
  else
    run_or_print node tools/mock-export-drift-check.mjs
  fi
  echo ""
}

BASE_REF="$(resolve_base_ref)"
CHANGED_FILES="$(collect_changed_files "$BASE_REF")"
CHANGED_FILE_COUNT=$(printf '%s\n' "$CHANGED_FILES" | sed '/^$/d' | wc -l | tr -d ' ')

PACKAGE_RESULT="$(printf '%s\n' "$CHANGED_FILES" | resolve_changed_packages)"
FULL_REPO="$(printf '%s\n' "$PACKAGE_RESULT" | sed -n 's/^FULL_REPO=//p')"
CHANGED_PACKAGES_CSV="$(printf '%s\n' "$PACKAGE_RESULT" | sed -n 's/^CHANGED_PACKAGES=//p')"

CHANGED_PACKAGES=()
HAS_CHANGED_PACKAGES=0
if [ -n "$CHANGED_PACKAGES_CSV" ]; then
  IFS=',' read -r -a CHANGED_PACKAGES <<<"$CHANGED_PACKAGES_CSV"
  HAS_CHANGED_PACKAGES=1
fi

PACKAGE_FILTER_ARGS=()
HAS_PACKAGE_FILTER_ARGS=0
if [ "$FULL_REPO" != "true" ] && [ "$HAS_CHANGED_PACKAGES" = "1" ]; then
  for pkg in "${CHANGED_PACKAGES[@]-}"; do
    [ -z "$pkg" ] && continue
    PACKAGE_FILTER_ARGS+=( "--filter=...$pkg" )
  done
  HAS_PACKAGE_FILTER_ARGS=1
fi

runtime_domains=()
runtime_domain_filters=()
studio_split_domains=()
studio_split_filters=()
studio_node_domains=()
studio_node_filters=()
RUNTIME_MAPPING_AMBIGUOUS=0
STUDIO_MAPPING_AMBIGUOUS=0
RUNTIME_WS_GUARD_CHANGED=0

while IFS= read -r changed_path; do
  [ -z "$changed_path" ] && continue

  case "$changed_path" in
    apps/runtime/test-session-api.mjs | apps/studio/src/* | apps/studio/public/* | benchmarks/* | packages/kore-platform-cli/src/* | packages/mcp-debug/src/* | packages/web-sdk/src/* | scripts/*)
      RUNTIME_WS_GUARD_CHANGED=1
      ;;
  esac

  RUNTIME_DOMAIN="$(map_runtime_domain "$changed_path")"
  if [ -n "$RUNTIME_DOMAIN" ]; then
    append_unique runtime_domains "$RUNTIME_DOMAIN"
    append_unique runtime_domain_filters "apps/runtime/src/__tests__/$RUNTIME_DOMAIN/"
  elif [[ "$changed_path" == apps/runtime/* ]] || [[ "$changed_path" == packages/web-sdk/src/* ]] || [[ "$changed_path" == packages/mcp-debug/src/* ]] || [[ "$changed_path" == packages/kore-platform-cli/src/* ]] || [[ "$changed_path" == benchmarks/* ]] || [[ "$changed_path" == scripts/* ]]; then
    RUNTIME_MAPPING_AMBIGUOUS=1
  fi

  STUDIO_TARGET="$(map_studio_target "$changed_path")"
  if [ -n "$STUDIO_TARGET" ]; then
    case "$STUDIO_TARGET" in
      split:*)
        STUDIO_DOMAIN=${STUDIO_TARGET#split:}
        append_unique studio_split_domains "$STUDIO_DOMAIN"
        append_unique studio_split_filters "src/__tests__/$STUDIO_DOMAIN/"
        ;;
      node:*)
        STUDIO_DOMAIN=${STUDIO_TARGET#node:}
        append_unique studio_node_domains "$STUDIO_DOMAIN"
        append_unique studio_node_filters "src/__tests__/$STUDIO_DOMAIN/"
        ;;
    esac
  elif [[ "$changed_path" == apps/studio/* ]] || [[ "$changed_path" == packages/web-sdk/src/* ]]; then
    STUDIO_MAPPING_AMBIGUOUS=1
  fi
done <<<"$CHANGED_FILES"

if [ "$FULL_REPO" = "true" ]; then
  if [ "${#runtime_domain_filters[@]}" -eq 0 ]; then
    RUNTIME_MAPPING_AMBIGUOUS=1
  fi
  if [ "${#studio_split_filters[@]}" -eq 0 ] && [ "${#studio_node_filters[@]}" -eq 0 ]; then
    STUDIO_MAPPING_AMBIGUOUS=1
  fi
fi

HAS_PACKAGE_IMPACT=0
if [ "$FULL_REPO" = "true" ] || [ "$HAS_PACKAGE_FILTER_ARGS" = "1" ]; then
  HAS_PACKAGE_IMPACT=1
fi

HAS_RUNTIME=0
HAS_STUDIO=0
if [ "$FULL_REPO" = "true" ]; then
  HAS_RUNTIME=1
  HAS_STUDIO=1
else
  if [ "$HAS_PACKAGE_FILTER_ARGS" = "1" ] && [ "$(turbo_has_package test:smoke @agent-platform/runtime "${PACKAGE_FILTER_ARGS[@]-}")" = "true" ]; then
    HAS_RUNTIME=1
  fi
  if [ "$HAS_PACKAGE_FILTER_ARGS" = "1" ] && [ "$(turbo_has_package test:fast @agent-platform/studio "${PACKAGE_FILTER_ARGS[@]-}")" = "true" ]; then
    HAS_STUDIO=1
  fi
fi

if [ "$RUNTIME_WS_GUARD_CHANGED" = "1" ]; then
  HAS_RUNTIME=1
fi

BUILD_ALREADY_RAN=0

print_header() {
  echo "╔══════════════════════════════════════════════════╗"
  echo "║        Local Verify — ${MODE}"
  echo "╚══════════════════════════════════════════════════╝"
  if [ -n "$BASE_REF" ]; then
    echo "Base ref: $BASE_REF"
  else
    echo "Base ref: <none>"
  fi
  echo "Changed files: $CHANGED_FILE_COUNT"
  if [ "$FULL_REPO" = "true" ]; then
    echo "Package scope: full repo (root config changed)"
  elif [ "$HAS_CHANGED_PACKAGES" = "1" ]; then
    echo "Changed packages: $(join_by ', ' "${CHANGED_PACKAGES[@]-}")"
  else
    echo "Changed packages: none"
  fi
  echo ""
}

run_build() {
  local build_task_count=0
  local build_args=(pnpm turbo build)

  echo "━━━ Build"
  if [ "$FULL_REPO" != "true" ] && [ "$HAS_CHANGED_PACKAGES" != "1" ]; then
    echo "  skip: no workspace package changes"
    echo ""
    BUILD_ALREADY_RAN=1
    return 0
  fi

  if [ "$FULL_REPO" = "true" ]; then
    build_task_count="$(turbo_task_count build)"
  else
    build_args+=("${PACKAGE_FILTER_ARGS[@]-}")
    build_task_count="$(turbo_task_count build "${PACKAGE_FILTER_ARGS[@]-}")"
  fi

  if [ "$build_task_count" = "0" ]; then
    echo "  skip: no build tasks affected"
    echo ""
    BUILD_ALREADY_RAN=1
    return 0
  fi

  if [ "${LOW_MEM:-}" = "1" ]; then
    build_args+=(--concurrency=1)
  else
    build_args+=(--concurrency="${LOCAL_BUILD_CONCURRENCY:-4}")
  fi

  echo "  tasks: $build_task_count"
  if [ "$MODE" = "plan" ]; then
    if [ "${LOW_MEM:-}" = "1" ]; then
      echo "  env: NODE_OPTIONS=--expose-gc --max-old-space-size=7168"
      echo "  would run: NODE_OPTIONS=--expose-gc\\ --max-old-space-size=7168 $(print_command "${build_args[@]}")"
    else
      echo "  would run: $(print_command "${build_args[@]}")"
    fi
  else
    if [ "${LOW_MEM:-}" = "1" ]; then
      NODE_OPTIONS="--expose-gc --max-old-space-size=7168" "${build_args[@]}"
    else
      "${build_args[@]}"
    fi
  fi
  echo ""
  BUILD_ALREADY_RAN=1
}

run_typecheck() {
  local typecheck_task_count=0
  local typecheck_args=(pnpm turbo typecheck)

  echo "━━━ Typecheck"
  if [ "$FULL_REPO" != "true" ] && [ "$HAS_CHANGED_PACKAGES" != "1" ]; then
    echo "  skip: no workspace package changes"
    echo ""
    return 0
  fi

  if [ "$FULL_REPO" = "true" ]; then
    typecheck_task_count="$(turbo_task_count typecheck)"
  else
    typecheck_args+=("${PACKAGE_FILTER_ARGS[@]-}")
    typecheck_task_count="$(turbo_task_count typecheck "${PACKAGE_FILTER_ARGS[@]-}")"
  fi

  if [ "$typecheck_task_count" = "0" ]; then
    echo "  skip: no typecheck tasks affected"
    echo ""
    return 0
  fi

  if [ "${LOW_MEM:-}" = "1" ]; then
    typecheck_args+=(--concurrency=1)
  else
    typecheck_args+=(--concurrency="${LOCAL_TYPECHECK_CONCURRENCY:-4}")
  fi

  echo "  tasks: $typecheck_task_count"
  run_or_print "${typecheck_args[@]}"
  echo ""
}

run_tests() {
  local heavy_packages=("@agent-platform/search-ai" "@agent-platform/multimodal-service" "@agent-platform/web-sdk" "@agent-platform/studio")
  local affected_heavy_packages=()
  local exclude_filters=("--filter=!@agent-platform/runtime")
  local package_test_count=0

  echo "━━━ Tests"

  if [ "$BUILD_ALREADY_RAN" != "1" ]; then
    run_build
  fi

  run_mock_export_drift_check

  if [ "$HAS_PACKAGE_IMPACT" = "0" ] && [ "$HAS_RUNTIME" = "0" ] && [ "$HAS_STUDIO" = "0" ]; then
    echo "  skip: no affected build/test targets"
    echo ""
    return 0
  fi

  if [ "$HAS_RUNTIME" = "1" ]; then
    if [ "${#runtime_domains[@]}" -gt 0 ] && [ "$RUNTIME_MAPPING_AMBIGUOUS" = "0" ]; then
      echo "  runtime domains: $(join_by ', ' "${runtime_domains[@]}")"
    else
      echo "  runtime: smoke fallback"
    fi

    run_or_print pnpm --dir apps/runtime test:smoke

    if [ "${#runtime_domain_filters[@]}" -gt 0 ] && [ "$RUNTIME_MAPPING_AMBIGUOUS" = "0" ]; then
      run_or_print pnpm --dir apps/runtime exec vitest run --config vitest.fast.config.ts "${runtime_domain_filters[@]}" --passWithNoTests
    fi
  fi

  if [ "$HAS_STUDIO" = "1" ]; then
    exclude_filters+=("--filter=!@agent-platform/studio")
    if [ "$STUDIO_MAPPING_AMBIGUOUS" = "0" ] && { [ "${#studio_split_filters[@]}" -gt 0 ] || [ "${#studio_node_filters[@]}" -gt 0 ]; }; then
      if [ "${#studio_split_domains[@]}" -gt 0 ]; then
        echo "  studio split domains: $(join_by ', ' "${studio_split_domains[@]}")"
        run_or_print pnpm --dir apps/studio test:fast -- "${studio_split_filters[@]}" --passWithNoTests
      fi

      if [ "${#studio_node_domains[@]}" -gt 0 ]; then
        echo "  studio node domains: $(join_by ', ' "${studio_node_domains[@]}")"
        run_or_print pnpm --dir apps/studio exec vitest run --config vitest.node.config.ts "${studio_node_filters[@]}" --passWithNoTests
      fi
    else
      echo "  studio: full test:fast fallback"
      run_or_print pnpm --dir apps/studio test:fast
    fi
  fi

  if [ "$FULL_REPO" = "true" ]; then
    affected_heavy_packages=("${heavy_packages[@]}")
  elif [ "$HAS_PACKAGE_FILTER_ARGS" = "1" ]; then
    for pkg in "${heavy_packages[@]-}"; do
      [ -z "$pkg" ] && continue
      if [ "$(turbo_has_package test:fast "$pkg" "${PACKAGE_FILTER_ARGS[@]-}")" = "true" ]; then
        affected_heavy_packages+=("$pkg")
      fi
    done
  fi

  if [ "${#affected_heavy_packages[@]}" -gt 0 ]; then
    local heavy_args=(pnpm turbo test:fast)
    local pkg
    echo "  heavy packages: $(join_by ', ' "${affected_heavy_packages[@]}")"
    for pkg in "${affected_heavy_packages[@]}"; do
      heavy_args+=("--filter=$pkg")
      exclude_filters+=("--filter=!$pkg")
    done
    heavy_args+=(--concurrency=1)

    if [ "$MODE" = "plan" ]; then
      echo "  env: NODE_OPTIONS=--max-old-space-size=8192"
      echo "  would run: NODE_OPTIONS=--max-old-space-size=8192 $(print_command "${heavy_args[@]}")"
    else
      NODE_OPTIONS="--max-old-space-size=8192" "${heavy_args[@]}"
    fi
  else
    for pkg in "${heavy_packages[@]}"; do
      exclude_filters+=("--filter=!$pkg")
    done
  fi

  if [ "$HAS_PACKAGE_IMPACT" = "0" ]; then
    echo ""
    return 0
  fi

  if [ "$FULL_REPO" = "true" ]; then
    package_test_count="$(turbo_task_count test:fast "${exclude_filters[@]}")"
  else
    package_test_count="$(turbo_task_count test:fast "${PACKAGE_FILTER_ARGS[@]-}" "${exclude_filters[@]}")"
  fi

  if [ "$package_test_count" = "0" ]; then
    echo "  remaining package tests: skip"
    echo ""
    return 0
  fi

  local remaining_args=(pnpm turbo test:fast)
  if [ "$FULL_REPO" != "true" ]; then
    remaining_args+=("${PACKAGE_FILTER_ARGS[@]-}")
  fi
  remaining_args+=("${exclude_filters[@]}")

  if [ "${LOW_MEM:-}" = "1" ]; then
    remaining_args+=(--concurrency=1)
  else
    remaining_args+=(--concurrency="${LOCAL_TEST_CONCURRENCY:-3}")
  fi

  echo "  remaining package test tasks: $package_test_count"
  if [ "$MODE" = "plan" ] && [ "${LOW_MEM:-}" = "1" ]; then
    echo "  env: NODE_OPTIONS=--max-old-space-size=6144"
    echo "  would run: NODE_OPTIONS=--max-old-space-size=6144 $(print_command "${remaining_args[@]}")"
  elif [ "${LOW_MEM:-}" = "1" ]; then
    NODE_OPTIONS="--max-old-space-size=6144" "${remaining_args[@]}"
  else
    run_or_print "${remaining_args[@]}"
  fi
  echo ""
}

print_header

case "$MODE" in
  plan)
    run_build
    run_typecheck
    run_tests
    ;;
  build)
    run_build
    ;;
  typecheck)
    run_typecheck
    ;;
  test)
    run_tests
    ;;
  all)
    run_build
    run_typecheck
    run_tests
    ;;
esac
