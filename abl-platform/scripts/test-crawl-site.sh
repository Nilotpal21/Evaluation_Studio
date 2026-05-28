#!/bin/bash
# Single site crawler test script for RFC-001
# Usage: ./scripts/test-crawl-site.sh <url> <site-name> <max-pages> <max-depth>

set -e

# Arguments
START_URL="${1:-https://docs.kore.ai/gettingstarted/}"
SITE_NAME="${2:-docs.kore.ai}"
MAX_PAGES="${3:-5}"
MAX_DEPTH="${4:-1}"

# Configuration
API_BASE="${API_BASE:-http://localhost:3001}"
TENANT_ID="${TENANT_ID:-tenant-1}"
PROJECT_ID="${PROJECT_ID:-project-1}"
RESULTS_DIR="./test-results"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create results directory
mkdir -p "$RESULTS_DIR"

# Test metadata
TEST_ID="test-$(date +%s)-$(echo $SITE_NAME | tr '.' '-')"
TEST_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESULT_FILE="$RESULTS_DIR/${SITE_NAME}-${TEST_ID}.json"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         CRAWLER TEST - RFC-001 End-User Validation            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Test ID:      $TEST_ID"
echo "Site:         $SITE_NAME"
echo "URL:          $START_URL"
echo "Max Pages:    $MAX_PAGES"
echo "Max Depth:    $MAX_DEPTH"
echo "API:          $API_BASE"
echo "Tenant:       $TENANT_ID"
echo "Results:      $RESULT_FILE"
echo ""

# Initialize result JSON
cat > "$RESULT_FILE" <<EOF
{
  "testId": "$TEST_ID",
  "site": "$SITE_NAME",
  "startUrl": "$START_URL",
  "testedAt": "$TEST_START",
  "config": {
    "maxPages": $MAX_PAGES,
    "maxDepth": $MAX_DEPTH
  },
  "status": "running"
}
EOF

# Function to update result JSON
update_result() {
  local key=$1
  local value=$2
  local temp_file=$(mktemp)
  jq "$key = $value" "$RESULT_FILE" > "$temp_file" && mv "$temp_file" "$RESULT_FILE"
}

# Function to log with timestamp
log() {
  echo "[$(date +%H:%M:%S)] $1"
}

# Function to log success
log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

# Function to log error
log_error() {
  echo -e "${RED}✗${NC} $1"
}

# Function to log warning
log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# Trap errors
trap 'log_error "Test failed at line $LINENO"; update_result ".status" "\"failed\""; exit 1' ERR

echo "════════════════════════════════════════════════════════════════"
echo "STEP 1/6: Setup - Create Knowledge Base and Source"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Create Knowledge Base
log "Creating knowledge base..."
KB_RESPONSE=$(curl -s -X POST "$API_BASE/api/knowledge-bases" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "{
    \"name\": \"Test: $SITE_NAME $(date +%s)\",
    \"projectId\": \"$PROJECT_ID\",
    \"description\": \"RFC-001 Test: $SITE_NAME\"
  }")

KB_ID=$(echo $KB_RESPONSE | jq -r '.knowledgeBase._id')
INDEX_ID=$(echo $KB_RESPONSE | jq -r '.knowledgeBase.searchIndexId')

if [ "$KB_ID" = "null" ] || [ -z "$KB_ID" ]; then
  log_error "Failed to create KB"
  echo $KB_RESPONSE | jq
  exit 1
fi

log_success "Created KB: $KB_ID"
log_success "Index ID: $INDEX_ID"
update_result ".ids.kbId" "\"$KB_ID\""
update_result ".ids.indexId" "\"$INDEX_ID\""

# Create Source
log "Creating crawl source..."
SOURCE_RESPONSE=$(curl -s -X POST "$API_BASE/api/indexes/$INDEX_ID/sources" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "{
    \"sourceType\": \"web\",
    \"name\": \"Test: $SITE_NAME\",
    \"config\": {
      \"startUrl\": \"$START_URL\"
    }
  }")

SOURCE_ID=$(echo $SOURCE_RESPONSE | jq -r '.source._id')

if [ "$SOURCE_ID" = "null" ] || [ -z "$SOURCE_ID" ]; then
  log_error "Failed to create source"
  echo $SOURCE_RESPONSE | jq
  exit 1
fi

log_success "Created Source: $SOURCE_ID"
update_result ".ids.sourceId" "\"$SOURCE_ID\""
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "STEP 2/6: Crawl - Submit Job and Monitor"
echo "════════════════════════════════════════════════════════════════"
echo ""

CRAWL_START=$(date +%s)

# Start crawl
log "Starting crawl..."
CRAWL_RESPONSE=$(curl -s -X POST "$API_BASE/api/crawl/batch" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "{
    \"urls\": [\"$START_URL\"],
    \"tenantId\": \"$TENANT_ID\",
    \"indexId\": \"$INDEX_ID\",
    \"sourceId\": \"$SOURCE_ID\",
    \"options\": {
      \"maxDepth\": $MAX_DEPTH,
      \"followLinks\": true,
      \"extractMetadata\": true,
      \"maxPages\": $MAX_PAGES
    }
  }")

NEEDS_INPUT=$(echo $CRAWL_RESPONSE | jq -r '.needsUserInput // false')

if [ "$NEEDS_INPUT" = "true" ]; then
  log_warning "Crawl requires user input"
  echo $CRAWL_RESPONSE | jq '.questions'
  update_result ".crawl.needsUserInput" "true"
  update_result ".crawl.questions" "$(echo $CRAWL_RESPONSE | jq '.questions')"
  update_result ".status" "\"needs_user_input\""
  echo ""
  echo "To continue, respond via:"
  echo "  POST $API_BASE/api/crawl/batch/respond"
  exit 0
fi

JOB_ID=$(echo $CRAWL_RESPONSE | jq -r '.jobId')
BATCH_ID=$(echo $CRAWL_RESPONSE | jq -r '.batchId')

if [ "$JOB_ID" = "null" ] || [ -z "$JOB_ID" ]; then
  log_error "Failed to start crawl"
  echo $CRAWL_RESPONSE | jq
  exit 1
fi

log_success "Crawl started"
echo "  Job ID:    $JOB_ID"
echo "  Batch ID:  $BATCH_ID"
echo "  Strategy:  $(echo $CRAWL_RESPONSE | jq -r '.decision.strategy')"

update_result ".ids.jobId" "\"$JOB_ID\""
update_result ".ids.batchId" "\"$BATCH_ID\""
update_result ".crawl.decision" "$(echo $CRAWL_RESPONSE | jq '.decision')"

# Monitor crawl progress
echo ""
log "Monitoring crawl progress..."

MAX_WAIT=300  # 5 minutes
WAIT_INTERVAL=5
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $WAIT_INTERVAL
  ELAPSED=$((ELAPSED + WAIT_INTERVAL))

  # Job status
  JOB_STATUS=$(curl -s "$API_BASE/api/crawl/status?jobId=$JOB_ID")
  JOB_STATE=$(echo $JOB_STATUS | jq -r '.state')
  JOB_PROGRESS=$(echo $JOB_STATUS | jq -r '.progress // {}')

  # Source status
  SOURCE_STATUS=$(curl -s "$API_BASE/api/indexes/$INDEX_ID/sources/$SOURCE_ID/status" \
    -H "x-tenant-id: $TENANT_ID")
  DOC_COUNT=$(echo $SOURCE_STATUS | jq -r '.documentCount // 0')

  echo -n "  [${ELAPSED}s] Job: $JOB_STATE | Docs: $DOC_COUNT"

  if [ "$JOB_STATE" = "completed" ]; then
    echo " ✓"
    log_success "Crawl completed"
    break
  elif [ "$JOB_STATE" = "failed" ]; then
    echo " ✗"
    log_error "Crawl failed"
    FAIL_REASON=$(echo $JOB_STATUS | jq -r '.failedReason // "Unknown"')
    echo "  Reason: $FAIL_REASON"
    update_result ".crawl.status" "\"failed\""
    update_result ".crawl.error" "\"$FAIL_REASON\""
    exit 1
  else
    echo " ⏳"
  fi
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  log_error "Crawl timeout after ${MAX_WAIT}s"
  update_result ".crawl.status" "\"timeout\""
  exit 1
fi

CRAWL_END=$(date +%s)
CRAWL_DURATION=$((CRAWL_END - CRAWL_START))

# Get final crawl stats
FINAL_JOB=$(curl -s "$API_BASE/api/crawl/status?jobId=$JOB_ID")
RETURN_VALUE=$(echo $FINAL_JOB | jq '.returnvalue // {}')

log_success "Crawl duration: ${CRAWL_DURATION}s"
update_result ".crawl.status" "\"completed\""
update_result ".crawl.duration" "$CRAWL_DURATION"
update_result ".crawl.result" "$RETURN_VALUE"

echo ""

echo "════════════════════════════════════════════════════════════════"
echo "STEP 3/6: Ingestion - Monitor Document Creation"
echo "════════════════════════════════════════════════════════════════"
echo ""

INGESTION_START=$(date +%s)

log "Waiting for ingestion to complete..."

MAX_WAIT=300
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $WAIT_INTERVAL
  ELAPSED=$((ELAPSED + WAIT_INTERVAL))

  # Check document statuses
  DOCS_RESPONSE=$(curl -s "$API_BASE/api/indexes/$INDEX_ID/documents" \
    -H "x-tenant-id: $TENANT_ID")

  TOTAL_DOCS=$(echo $DOCS_RESPONSE | jq '.total')
  PENDING=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.status == "pending")] | length')
  PROCESSING=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.status == "processing")] | length')
  INDEXED=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.status == "indexed")] | length')
  FAILED=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.status == "failed")] | length')

  echo "  [${ELAPSED}s] Total: $TOTAL_DOCS | Pending: $PENDING | Processing: $PROCESSING | Indexed: $INDEXED | Failed: $FAILED"

  # Check if all done
  if [ "$PENDING" = "0" ] && [ "$PROCESSING" = "0" ]; then
    log_success "Ingestion completed"
    break
  fi
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  log_warning "Ingestion timeout, some documents still processing"
fi

INGESTION_END=$(date +%s)
INGESTION_DURATION=$((INGESTION_END - INGESTION_START))

log_success "Ingestion duration: ${INGESTION_DURATION}s"
update_result ".ingestion.duration" "$INGESTION_DURATION"
update_result ".ingestion.documentsCreated" "$TOTAL_DOCS"
update_result ".ingestion.documentsFailed" "$FAILED"

echo ""

echo "════════════════════════════════════════════════════════════════"
echo "STEP 4/6: Quality Analysis - Aggregate Metrics"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Get all documents with quality metrics
DOCS_RESPONSE=$(curl -s "$API_BASE/api/indexes/$INDEX_ID/documents" \
  -H "x-tenant-id: $TENANT_ID")

# Calculate aggregates
AVG_QUALITY=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.overallScore // 0] | add / length')
AVG_NOISE=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.noiseReduction // 0] | add / length')
AVG_CONTENT=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.contentPreservation // 0] | add / length')
AVG_STRUCTURE=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.structurePreservation // 0] | add / length')
AVG_METADATA=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.metadataExtraction // 0] | add / length')

AVG_RAW_SIZE=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.size.rawBytes // 0] | add / length')
AVG_CLEANED_SIZE=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.size.cleanedBytes // 0] | add / length')
AVG_REDUCTION=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.size.reductionPercent // 0] | add / length')

TOTAL_CHUNKS=$(echo $DOCS_RESPONSE | jq '[.documents[].chunkCount // 0] | add')
AVG_CHUNKS=$(echo $DOCS_RESPONSE | jq '[.documents[].chunkCount // 0] | add / length')

# Distribution
EXCELLENT=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.sourceMetadata.qualityMetrics.overallScore >= 90)] | length')
GOOD=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.sourceMetadata.qualityMetrics.overallScore >= 70 and .sourceMetadata.qualityMetrics.overallScore < 90)] | length')
FAIR=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.sourceMetadata.qualityMetrics.overallScore >= 50 and .sourceMetadata.qualityMetrics.overallScore < 70)] | length')
POOR=$(echo $DOCS_RESPONSE | jq '[.documents[] | select(.sourceMetadata.qualityMetrics.overallScore < 50)] | length')

echo "Quality Scores:"
echo "  Overall:              $(printf "%.1f" $AVG_QUALITY) / 100"
echo "  Noise Reduction:      $(printf "%.1f" $AVG_NOISE) / 100"
echo "  Content Preservation: $(printf "%.1f" $AVG_CONTENT) / 100"
echo "  Structure:            $(printf "%.1f" $AVG_STRUCTURE) / 100"
echo "  Metadata:             $(printf "%.1f" $AVG_METADATA) / 100"
echo ""

echo "Size Metrics:"
echo "  Avg Raw Size:         $(printf "%.0f" $AVG_RAW_SIZE) bytes"
echo "  Avg Cleaned Size:     $(printf "%.0f" $AVG_CLEANED_SIZE) bytes"
echo "  Avg Reduction:        $(printf "%.1f" $AVG_REDUCTION)%"
echo ""

echo "Chunking:"
echo "  Total Chunks:         $TOTAL_CHUNKS"
echo "  Avg Chunks/Doc:       $(printf "%.1f" $AVG_CHUNKS)"
echo ""

echo "Distribution:"
echo "  Excellent (90+):      $EXCELLENT docs"
echo "  Good (70-89):         $GOOD docs"
echo "  Fair (50-69):         $FAIR docs"
echo "  Poor (<50):           $POOR docs"
echo ""

# Update results
update_result ".quality.avgOverallScore" "$AVG_QUALITY"
update_result ".quality.avgNoiseReduction" "$AVG_NOISE"
update_result ".quality.avgContentPreservation" "$AVG_CONTENT"
update_result ".quality.avgStructurePreservation" "$AVG_STRUCTURE"
update_result ".quality.avgMetadataExtraction" "$AVG_METADATA"
update_result ".quality.distribution" "{\"excellent\": $EXCELLENT, \"good\": $GOOD, \"fair\": $FAIR, \"poor\": $POOR}"

update_result ".size.avgRawBytes" "$AVG_RAW_SIZE"
update_result ".size.avgCleanedBytes" "$AVG_CLEANED_SIZE"
update_result ".size.avgReduction" "$AVG_REDUCTION"

update_result ".extraction.totalChunks" "$TOTAL_CHUNKS"
update_result ".extraction.avgChunksPerDoc" "$AVG_CHUNKS"

echo "════════════════════════════════════════════════════════════════"
echo "STEP 5/6: Validation - Check Against Targets"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Target thresholds
TARGET_QUALITY=80
TARGET_NOISE=30
TARGET_CONTENT=90
TARGET_SUCCESS=85

# Calculate success rate
SUCCESS_RATE=$(echo "scale=1; ($INDEXED / $TOTAL_DOCS) * 100" | bc)

echo "Target Validation:"

# Quality score
if (( $(echo "$AVG_QUALITY >= $TARGET_QUALITY" | bc -l) )); then
  log_success "Quality Score: $(printf "%.1f" $AVG_QUALITY) >= $TARGET_QUALITY ✓"
else
  log_warning "Quality Score: $(printf "%.1f" $AVG_QUALITY) < $TARGET_QUALITY ✗"
fi

# Noise reduction
if (( $(echo "$AVG_NOISE >= $TARGET_NOISE" | bc -l) )); then
  log_success "Noise Reduction: $(printf "%.1f" $AVG_NOISE)% >= $TARGET_NOISE% ✓"
else
  log_warning "Noise Reduction: $(printf "%.1f" $AVG_NOISE)% < $TARGET_NOISE% ✗"
fi

# Content preservation
if (( $(echo "$AVG_CONTENT >= $TARGET_CONTENT" | bc -l) )); then
  log_success "Content Preservation: $(printf "%.1f" $AVG_CONTENT)% >= $TARGET_CONTENT% ✓"
else
  log_warning "Content Preservation: $(printf "%.1f" $AVG_CONTENT)% < $TARGET_CONTENT% ✗"
fi

# Success rate
if (( $(echo "$SUCCESS_RATE >= $TARGET_SUCCESS" | bc -l) )); then
  log_success "Success Rate: $(printf "%.1f" $SUCCESS_RATE)% >= $TARGET_SUCCESS% ✓"
else
  log_warning "Success Rate: $(printf "%.1f" $SUCCESS_RATE)% < $TARGET_SUCCESS% ✗"
fi

echo ""

echo "════════════════════════════════════════════════════════════════"
echo "STEP 6/6: Results - Generate Report"
echo "════════════════════════════════════════════════════════════════"
echo ""

TEST_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TOTAL_DURATION=$(($(date +%s) - $(date -d "$TEST_START" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$TEST_START" +%s)))

update_result ".testEndedAt" "\"$TEST_END\""
update_result ".totalDuration" "$TOTAL_DURATION"
update_result ".status" "\"completed\""

# Store full documents data
echo $DOCS_RESPONSE > "$RESULTS_DIR/${SITE_NAME}-${TEST_ID}-documents.json"

log_success "Test completed in ${TOTAL_DURATION}s"
log_success "Results saved to: $RESULT_FILE"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                        TEST SUMMARY                            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Site:              $SITE_NAME"
echo "Total Duration:    ${TOTAL_DURATION}s"
echo "Documents:         $TOTAL_DOCS"
echo "Success Rate:      $(printf "%.1f" $SUCCESS_RATE)%"
echo "Avg Quality:       $(printf "%.1f" $AVG_QUALITY) / 100"
echo "Avg Noise Removed: $(printf "%.1f" $AVG_REDUCTION)%"
echo ""
echo "Files:"
echo "  - Results:   $RESULT_FILE"
echo "  - Documents: $RESULTS_DIR/${SITE_NAME}-${TEST_ID}-documents.json"
echo ""
echo "Next Steps:"
echo "  1. Review results: cat $RESULT_FILE | jq"
echo "  2. Manual content review: open cleaned HTML files"
echo "  3. Fill out RFC-001 test template with findings"
echo ""
