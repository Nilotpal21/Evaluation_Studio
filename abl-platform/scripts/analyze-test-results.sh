#!/bin/bash
# Analyze test results from RFC-001 bulk testing
# Usage: ./scripts/analyze-test-results.sh

RESULTS_DIR="./test-results"

if [ ! -d "$RESULTS_DIR" ]; then
  echo "Error: Results directory not found: $RESULTS_DIR"
  exit 1
fi

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║            RFC-001 TEST RESULTS ANALYSIS                       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Find all result files (excluding -documents.json files)
RESULT_FILES=$(find "$RESULTS_DIR" -name "*.json" ! -name "*-documents.json" -type f)
TOTAL_FILES=$(echo "$RESULT_FILES" | wc -l | tr -d ' ')

if [ "$TOTAL_FILES" -eq 0 ]; then
  echo "No test results found in $RESULTS_DIR"
  exit 0
fi

echo "Found $TOTAL_FILES test result(s)"
echo ""

# Initialize aggregates
TOTAL_TESTS=0
COMPLETED=0
FAILED=0
NEEDS_INPUT=0

TOTAL_DOCS=0
TOTAL_INDEXED=0
TOTAL_FAILED_DOCS=0
TOTAL_CHUNKS=0

SUM_QUALITY=0
SUM_NOISE=0
SUM_CONTENT=0
SUM_STRUCTURE=0
SUM_METADATA=0

SUM_RAW_SIZE=0
SUM_CLEANED_SIZE=0
SUM_REDUCTION=0

EXCELLENT=0
GOOD=0
FAIR=0
POOR=0

echo "════════════════════════════════════════════════════════════════"
echo "INDIVIDUAL TEST RESULTS"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Process each result file
while IFS= read -r file; do
  TOTAL_TESTS=$((TOTAL_TESTS + 1))

  SITE=$(jq -r '.site' "$file")
  STATUS=$(jq -r '.status' "$file")
  DOCS=$(jq -r '.ingestion.documentsCreated // 0' "$file")
  QUALITY=$(jq -r '.quality.avgOverallScore // 0' "$file")
  NOISE=$(jq -r '.quality.avgNoiseReduction // 0' "$file")
  CHUNKS=$(jq -r '.extraction.totalChunks // 0' "$file")

  printf "%-30s" "$SITE"

  if [ "$STATUS" = "completed" ]; then
    COMPLETED=$((COMPLETED + 1))
    printf " ✓ Completed | Docs: %3d | Quality: %5.1f | Noise: %5.1f%% | Chunks: %4d\n" \
      "$DOCS" "$QUALITY" "$NOISE" "$CHUNKS"

    # Aggregate
    TOTAL_DOCS=$((TOTAL_DOCS + DOCS))
    TOTAL_CHUNKS=$((TOTAL_CHUNKS + CHUNKS))

    SUM_QUALITY=$(echo "$SUM_QUALITY + $QUALITY" | bc)
    SUM_NOISE=$(echo "$SUM_NOISE + $NOISE" | bc)
    SUM_CONTENT=$(echo "$SUM_CONTENT + $(jq -r '.quality.avgContentPreservation // 0' "$file")" | bc)
    SUM_STRUCTURE=$(echo "$SUM_STRUCTURE + $(jq -r '.quality.avgStructurePreservation // 0' "$file")" | bc)
    SUM_METADATA=$(echo "$SUM_METADATA + $(jq -r '.quality.avgMetadataExtraction // 0' "$file")" | bc)

    SUM_RAW_SIZE=$(echo "$SUM_RAW_SIZE + $(jq -r '.size.avgRawBytes // 0' "$file")" | bc)
    SUM_CLEANED_SIZE=$(echo "$SUM_CLEANED_SIZE + $(jq -r '.size.avgCleanedBytes // 0' "$file")" | bc)
    SUM_REDUCTION=$(echo "$SUM_REDUCTION + $(jq -r '.size.avgReduction // 0' "$file")" | bc)

    # Distribution
    EXCELLENT=$((EXCELLENT + $(jq -r '.quality.distribution.excellent // 0' "$file")))
    GOOD=$((GOOD + $(jq -r '.quality.distribution.good // 0' "$file")))
    FAIR=$((FAIR + $(jq -r '.quality.distribution.fair // 0' "$file")))
    POOR=$((POOR + $(jq -r '.quality.distribution.poor // 0' "$file")))

  elif [ "$STATUS" = "needs_user_input" ]; then
    NEEDS_INPUT=$((NEEDS_INPUT + 1))
    printf " ⚠ Needs user input\n"
  else
    FAILED=$((FAILED + 1))
    ERROR=$(jq -r '.crawl.error // .error // "Unknown error"' "$file")
    printf " ✗ Failed: %s\n" "$ERROR"
  fi
done <<< "$RESULT_FILES"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "AGGREGATE METRICS"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Calculate averages
if [ "$COMPLETED" -gt 0 ]; then
  AVG_QUALITY=$(echo "scale=1; $SUM_QUALITY / $COMPLETED" | bc)
  AVG_NOISE=$(echo "scale=1; $SUM_NOISE / $COMPLETED" | bc)
  AVG_CONTENT=$(echo "scale=1; $SUM_CONTENT / $COMPLETED" | bc)
  AVG_STRUCTURE=$(echo "scale=1; $SUM_STRUCTURE / $COMPLETED" | bc)
  AVG_METADATA=$(echo "scale=1; $SUM_METADATA / $COMPLETED" | bc)

  AVG_RAW_SIZE=$(echo "scale=0; $SUM_RAW_SIZE / $COMPLETED" | bc)
  AVG_CLEANED_SIZE=$(echo "scale=0; $SUM_CLEANED_SIZE / $COMPLETED" | bc)
  AVG_REDUCTION=$(echo "scale=1; $SUM_REDUCTION / $COMPLETED" | bc)

  AVG_CHUNKS=$(echo "scale=1; $TOTAL_CHUNKS / $TOTAL_DOCS" | bc)
else
  AVG_QUALITY=0
  AVG_NOISE=0
  AVG_CONTENT=0
  AVG_STRUCTURE=0
  AVG_METADATA=0
  AVG_RAW_SIZE=0
  AVG_CLEANED_SIZE=0
  AVG_REDUCTION=0
  AVG_CHUNKS=0
fi

SUCCESS_RATE=$(echo "scale=1; ($COMPLETED / $TOTAL_TESTS) * 100" | bc)

echo "Test Outcomes:"
echo "  Total Tests:       $TOTAL_TESTS"
echo "  Completed:         $COMPLETED ($(echo "scale=1; ($COMPLETED / $TOTAL_TESTS) * 100" | bc)%)"
echo "  Failed:            $FAILED"
echo "  Needs Input:       $NEEDS_INPUT"
echo ""

echo "Documents:"
echo "  Total Created:     $TOTAL_DOCS"
echo "  Avg per Test:      $(echo "scale=1; $TOTAL_DOCS / $COMPLETED" | bc)"
echo ""

echo "Quality Scores (Average):"
echo "  Overall:           $AVG_QUALITY / 100"
echo "  Noise Reduction:   $AVG_NOISE / 100"
echo "  Content Preserv:   $AVG_CONTENT / 100"
echo "  Structure Pres:    $AVG_STRUCTURE / 100"
echo "  Metadata Extr:     $AVG_METADATA / 100"
echo ""

echo "Size Metrics:"
echo "  Avg Raw Size:      $AVG_RAW_SIZE bytes"
echo "  Avg Cleaned Size:  $AVG_CLEANED_SIZE bytes"
echo "  Avg Reduction:     $AVG_REDUCTION%"
echo ""

echo "Chunking:"
echo "  Total Chunks:      $TOTAL_CHUNKS"
echo "  Avg per Doc:       $AVG_CHUNKS"
echo ""

echo "Quality Distribution:"
echo "  Excellent (90+):   $EXCELLENT docs ($(echo "scale=1; ($EXCELLENT / $TOTAL_DOCS) * 100" | bc 2>/dev/null || echo "0")%)"
echo "  Good (70-89):      $GOOD docs ($(echo "scale=1; ($GOOD / $TOTAL_DOCS) * 100" | bc 2>/dev/null || echo "0")%)"
echo "  Fair (50-69):      $FAIR docs ($(echo "scale=1; ($FAIR / $TOTAL_DOCS) * 100" | bc 2>/dev/null || echo "0")%)"
echo "  Poor (<50):        $POOR docs ($(echo "scale=1; ($POOR / $TOTAL_DOCS) * 100" | bc 2>/dev/null || echo "0")%)"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "TARGET VALIDATION"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Targets from RFC
TARGET_SUCCESS=90
TARGET_QUALITY=80
TARGET_NOISE=40
TARGET_CONTENT=95
TARGET_REDUCTION=40

# Success rate
if (( $(echo "$SUCCESS_RATE >= $TARGET_SUCCESS" | bc -l) )); then
  echo "✓ Success Rate:        $SUCCESS_RATE% >= $TARGET_SUCCESS%"
else
  echo "✗ Success Rate:        $SUCCESS_RATE% < $TARGET_SUCCESS% (BELOW TARGET)"
fi

# Quality score
if (( $(echo "$AVG_QUALITY >= $TARGET_QUALITY" | bc -l) )); then
  echo "✓ Quality Score:       $AVG_QUALITY >= $TARGET_QUALITY"
else
  echo "✗ Quality Score:       $AVG_QUALITY < $TARGET_QUALITY (BELOW TARGET)"
fi

# Noise reduction
if (( $(echo "$AVG_NOISE >= $TARGET_NOISE" | bc -l) )); then
  echo "✓ Noise Reduction:     $AVG_NOISE% >= $TARGET_NOISE%"
else
  echo "✗ Noise Reduction:     $AVG_NOISE% < $TARGET_NOISE% (BELOW TARGET)"
fi

# Content preservation
if (( $(echo "$AVG_CONTENT >= $TARGET_CONTENT" | bc -l) )); then
  echo "✓ Content Preservation: $AVG_CONTENT% >= $TARGET_CONTENT%"
else
  echo "✗ Content Preservation: $AVG_CONTENT% < $TARGET_CONTENT% (BELOW TARGET)"
fi

# Size reduction
if (( $(echo "$AVG_REDUCTION >= $TARGET_REDUCTION" | bc -l) )); then
  echo "✓ Size Reduction:      $AVG_REDUCTION% >= $TARGET_REDUCTION%"
else
  echo "✗ Size Reduction:      $AVG_REDUCTION% < $TARGET_REDUCTION% (BELOW TARGET)"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Report saved to: $RESULTS_DIR/summary-$(date +%Y%m%d-%H%M%S).txt"
echo ""

# Save summary
SUMMARY_FILE="$RESULTS_DIR/summary-$(date +%Y%m%d-%H%M%S).txt"
{
  echo "RFC-001 Crawler Test Results Summary"
  echo "Generated: $(date)"
  echo ""
  echo "Tests: $TOTAL_TESTS | Completed: $COMPLETED | Failed: $FAILED"
  echo "Documents: $TOTAL_DOCS | Chunks: $TOTAL_CHUNKS"
  echo ""
  echo "Quality: $AVG_QUALITY | Noise: $AVG_NOISE% | Content: $AVG_CONTENT%"
  echo "Size Reduction: $AVG_REDUCTION%"
  echo "Avg Chunks/Doc: $AVG_CHUNKS"
} > "$SUMMARY_FILE"

echo "Next Steps:"
echo "  1. Review detailed results: ls $RESULTS_DIR/"
echo "  2. Manual content review for failed tests"
echo "  3. Fill out RFC-001 test template"
echo "  4. Create follow-up RFCs for improvements"
echo ""
