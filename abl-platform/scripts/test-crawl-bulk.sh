#!/bin/bash
# Bulk crawler test script for RFC-001
# Runs tests against multiple websites and aggregates results

set -e

RESULTS_DIR="./test-results"
mkdir -p "$RESULTS_DIR"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║            RFC-001 BULK CRAWLER TESTING                        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Test configuration
declare -A TEST_SITES=(
  # Category A: Documentation Sites
  ["docs.kore.ai"]="https://docs.kore.ai/gettingstarted/"
  ["docs.python.org"]="https://docs.python.org/3/tutorial/"
  ["developer.mozilla.org"]="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide"
  ["react.dev"]="https://react.dev/learn"

  # Category B: News/Blog Sites
  ["techcrunch.com"]="https://techcrunch.com/"
  ["medium.com"]="https://medium.com/topic/technology"
  ["arstechnica.com"]="https://arstechnica.com/"
  ["blog.cloudflare.com"]="https://blog.cloudflare.com/"

  # Category C: E-commerce/API Docs
  ["stripe.com"]="https://stripe.com/docs/api"
  ["shopify.dev"]="https://shopify.dev/docs"

  # Category D: SPA/Dynamic Sites
  ["notion.so"]="https://www.notion.so/product"
  ["figma.com"]="https://www.figma.com/community"

  # Category E: Edge Cases
  ["wikipedia.org"]="https://en.wikipedia.org/wiki/Web_crawler"
  ["stackoverflow.com"]="https://stackoverflow.com/questions/tagged/web-scraping"
)

# Test parameters
MAX_PAGES=5
MAX_DEPTH=1
DELAY_BETWEEN_TESTS=10  # seconds

# Summary tracking
TOTAL_TESTS=0
COMPLETED_TESTS=0
FAILED_TESTS=0
START_TIME=$(date +%s)

echo "Configuration:"
echo "  Sites:        ${#TEST_SITES[@]}"
echo "  Max Pages:    $MAX_PAGES per site"
echo "  Max Depth:    $MAX_DEPTH"
echo "  Delay:        ${DELAY_BETWEEN_TESTS}s between tests"
echo "  Results:      $RESULTS_DIR/"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""

# Run tests
for site in "${!TEST_SITES[@]}"; do
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  url="${TEST_SITES[$site]}"

  echo ""
  echo "▶ [$TOTAL_TESTS/${#TEST_SITES[@]}] Testing: $site"
  echo "  URL: $url"
  echo ""

  # Run test
  if ./scripts/test-crawl-site.sh "$url" "$site" "$MAX_PAGES" "$MAX_DEPTH"; then
    COMPLETED_TESTS=$((COMPLETED_TESTS + 1))
    echo "  ✓ Test completed successfully"
  else
    FAILED_TESTS=$((FAILED_TESTS + 1))
    echo "  ✗ Test failed"
  fi

  # Delay between tests
  if [ $TOTAL_TESTS -lt ${#TEST_SITES[@]} ]; then
    echo ""
    echo "  Waiting ${DELAY_BETWEEN_TESTS}s before next test..."
    sleep $DELAY_BETWEEN_TESTS
  fi
done

END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    BULK TEST SUMMARY                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Tests:       $TOTAL_TESTS"
echo "Completed:         $COMPLETED_TESTS"
echo "Failed:            $FAILED_TESTS"
echo "Success Rate:      $(echo "scale=1; ($COMPLETED_TESTS / $TOTAL_TESTS) * 100" | bc)%"
echo "Total Duration:    ${TOTAL_DURATION}s ($(echo "scale=1; $TOTAL_DURATION / 60" | bc)m)"
echo ""
echo "Results Directory: $RESULTS_DIR/"
echo ""
echo "Next Steps:"
echo "  1. Analyze results: ./scripts/analyze-test-results.sh"
echo "  2. Generate report:  node scripts/analyze-test-results.ts"
echo "  3. Review RFC-001:   cat docs/rfcs/RFC-001-CRAWLER-END-USER-TESTING.md"
echo ""
