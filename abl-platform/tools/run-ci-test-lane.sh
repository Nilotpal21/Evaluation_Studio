#!/usr/bin/env bash

set -euo pipefail

lane="${1:-}"

if [ -z "${lane}" ]; then
  echo "Usage: $0 <unit|runtime-regression|integration|api-e2e|studio-browser-e2e>" >&2
  exit 1
fi

build_concurrency="${CI_BUILD_CONCURRENCY:-4}"
test_concurrency="${CI_TEST_CONCURRENCY:-4}"
export RUNTIME_TEST_LANE_TIMEOUT_MS="${RUNTIME_TEST_LANE_TIMEOUT_MS:-600000}"

build_targets() {
  if [ "$#" -eq 0 ]; then
    return
  fi

  echo "=== Build prerequisites: $* ==="
  pnpm turbo build "$@" --concurrency="${build_concurrency}"
}

run_vitest_lane() {
  local pkg="$1"
  local script="$2"
  local junit_file="$3"

  echo "=== ${pkg} :: ${script} ==="
  pnpm --filter "${pkg}" "${script}" -- --reporter=default --reporter=junit "--outputFile.junit=${junit_file}"
}

run_studio_lint() {
  echo "=== @agent-platform/studio :: lint ==="
  pnpm --dir apps/studio lint
}

case "${lane}" in
  unit)
    echo "=== Full unit / fast lane ==="
    echo "=== Runtime test lane timeout: ${RUNTIME_TEST_LANE_TIMEOUT_MS}ms ==="
    run_studio_lint
    pnpm turbo test:fast --concurrency="${test_concurrency}" -- --reporter=default --reporter=junit --outputFile.junit=junit-report.xml
    ;;

  runtime-regression)
    echo "=== Runtime test lane timeout: ${RUNTIME_TEST_LANE_TIMEOUT_MS}ms ==="
    build_targets --filter=@agent-platform/runtime
    run_vitest_lane "@agent-platform/runtime" "test:ci:regression" "junit-regression-runtime.xml"
    ;;

  integration)
    run_studio_lint
    build_targets \
      --filter=@agent-platform/runtime \
      --filter=@agent-platform/agent-transfer \
      --filter=@abl/crawler \
      --filter=@agent-platform/multimodal-service \
      --filter=@agent-platform/studio \
      --filter=@agent-platform/search-ai \
      --filter=@agent-platform/search-ai-runtime

    run_vitest_lane "@agent-platform/runtime" "test:integration" "junit-integration-runtime.xml"
    run_vitest_lane "@agent-platform/agent-transfer" "test:integration" "junit-integration-agent-transfer.xml"
    run_vitest_lane "@abl/crawler" "test:integration" "junit-integration-crawler.xml"
    run_vitest_lane "@agent-platform/multimodal-service" "test:integration" "junit-integration-multimodal-service.xml"
    run_vitest_lane "@agent-platform/studio" "test:full" "junit-integration-studio.xml"
    run_vitest_lane "@agent-platform/search-ai" "test" "junit-integration-search-ai.xml"
    run_vitest_lane "@agent-platform/search-ai-runtime" "test" "junit-integration-search-ai-runtime.xml"
    ;;

  api-e2e)
    build_targets --filter=@agent-platform/runtime --filter=@agent-platform/cli
    run_vitest_lane "@agent-platform/runtime" "test:e2e" "junit-e2e-runtime.xml"
    run_vitest_lane "@agent-platform/runtime" "test:connector-e2e" "junit-e2e-runtime-connectors.xml"
    run_vitest_lane "@agent-platform/cli" "test:e2e" "junit-e2e-cli.xml"
    ;;

  studio-browser-e2e)
    sh ./scripts/ensure-workspace-install.sh "studio browser E2E"
    build_targets \
      --filter=@agent-platform/runtime \
      --filter=@agent-platform/studio \
      --filter=@agent-platform/web-sdk

    export SDK_BROWSER_E2E_ISOLATED="${SDK_BROWSER_E2E_ISOLATED:-true}"
    export SDK_BROWSER_E2E_STRICT="${SDK_BROWSER_E2E_STRICT:-true}"
    export PLAYWRIGHT_JUNIT_OUTPUT_FILE="${PLAYWRIGHT_JUNIT_OUTPUT_FILE:-test-results/junit-e2e-studio-browser.xml}"

    echo "=== @agent-platform/studio :: test:e2e ==="
    pnpm --filter @agent-platform/studio exec playwright test --config=e2e-playwright.config.ts --reporter=line,junit
    ;;

  *)
    echo "Unknown CI test lane: ${lane}" >&2
    exit 1
    ;;
esac
