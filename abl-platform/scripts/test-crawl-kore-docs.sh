#!/bin/bash
# Test script for crawling https://docs.kore.ai/
# Usage: ./scripts/test-crawl-kore-docs.sh

set -e

API_BASE="${API_BASE:-http://localhost:3001}"
TENANT_ID="${TENANT_ID:-tenant-1}"
PROJECT_ID="${PROJECT_ID:-project-1}"

echo "=== Crawler Test Script for docs.kore.ai ==="
echo "API: $API_BASE"
echo "Tenant: $TENANT_ID"
echo ""

# Step 1: Create Knowledge Base
echo "[1/6] Creating Knowledge Base..."
KB_RESPONSE=$(curl -s -X POST "$API_BASE/api/kb" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "{
    \"name\": \"Kore.ai Docs Test $(date +%s)\",
    \"projectId\": \"$PROJECT_ID\",
    \"description\": \"Test crawl of Kore.ai documentation\"
  }")

KB_ID=$(echo $KB_RESPONSE | jq -r '.id')
INDEX_ID=$(echo $KB_RESPONSE | jq -r '.indexId')

if [ "$KB_ID" = "null" ] || [ -z "$KB_ID" ]; then
  echo "❌ Failed to create KB"
  echo $KB_RESPONSE | jq
  exit 1
fi

echo "✓ Created KB: $KB_ID"
echo "✓ Index ID: $INDEX_ID"
echo ""

# Step 2: Create Source
echo "[2/6] Creating Web Crawl Source..."
SOURCE_RESPONSE=$(curl -s -X POST "$API_BASE/api/indexes/$INDEX_ID/sources" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{
    "type": "web",
    "name": "Kore.ai Docs Crawl",
    "config": {
      "startUrl": "https://docs.kore.ai/"
    }
  }')

SOURCE_ID=$(echo $SOURCE_RESPONSE | jq -r '._id')

if [ "$SOURCE_ID" = "null" ] || [ -z "$SOURCE_ID" ]; then
  echo "❌ Failed to create source"
  echo $SOURCE_RESPONSE | jq
  exit 1
fi

echo "✓ Created Source: $SOURCE_ID"
echo ""

# Step 3: Start Crawl
echo "[3/6] Starting crawl..."
CRAWL_RESPONSE=$(curl -s -X POST "$API_BASE/api/crawl/batch" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -d "{
    \"urls\": [\"https://docs.kore.ai/gettingstarted/\"],
    \"tenantId\": \"$TENANT_ID\",
    \"indexId\": \"$INDEX_ID\",
    \"sourceId\": \"$SOURCE_ID\",
    \"options\": {
      \"maxDepth\": 2,
      \"followLinks\": true,
      \"extractMetadata\": true,
      \"maxPages\": 10
    }
  }")

NEEDS_INPUT=$(echo $CRAWL_RESPONSE | jq -r '.needsUserInput // false')

if [ "$NEEDS_INPUT" = "true" ]; then
  echo "⚠️  Crawl requires user input (questions)"
  echo $CRAWL_RESPONSE | jq '.questions'
  echo ""
  echo "Handle user prompts via POST $API_BASE/api/crawl/batch/respond"
  exit 0
fi

JOB_ID=$(echo $CRAWL_RESPONSE | jq -r '.jobId')
BATCH_ID=$(echo $CRAWL_RESPONSE | jq -r '.batchId')

if [ "$JOB_ID" = "null" ] || [ -z "$JOB_ID" ]; then
  echo "❌ Failed to start crawl"
  echo $CRAWL_RESPONSE | jq
  exit 1
fi

echo "✓ Crawl started"
echo "  Job ID: $JOB_ID"
echo "  Batch ID: $BATCH_ID"
echo "  Decision: $(echo $CRAWL_RESPONSE | jq -r '.decision.strategy')"
echo ""

# Step 4: Monitor Progress
echo "[4/6] Monitoring progress (30 seconds)..."
for i in {1..6}; do
  sleep 5

  # Job status
  JOB_STATE=$(curl -s "$API_BASE/api/crawl/status?jobId=$JOB_ID" | jq -r '.state')

  # Source status
  DOC_COUNT=$(curl -s "$API_BASE/api/indexes/$INDEX_ID/sources/$SOURCE_ID/status" \
    -H "x-tenant-id: $TENANT_ID" | jq -r '.documentCount // 0')

  echo "  [$i/6] Job: $JOB_STATE | Documents: $DOC_COUNT"

  if [ "$JOB_STATE" = "completed" ]; then
    echo "✓ Crawl completed"
    break
  fi
done
echo ""

# Step 5: Check Results
echo "[5/6] Checking ingestion results..."
DOCS_RESPONSE=$(curl -s "$API_BASE/api/indexes/$INDEX_ID/documents" \
  -H "x-tenant-id: $TENANT_ID")

TOTAL_DOCS=$(echo $DOCS_RESPONSE | jq -r '.total')
echo "✓ Total documents: $TOTAL_DOCS"

# Status breakdown
echo ""
echo "Document status breakdown:"
echo $DOCS_RESPONSE | jq '[.documents[].status] | group_by(.) | map({status: .[0], count: length})[]'

# Quality metrics
echo ""
echo "Average quality score:"
AVG_QUALITY=$(echo $DOCS_RESPONSE | jq '[.documents[].sourceMetadata.qualityMetrics.overallScore // 0] | add / length')
echo "  $AVG_QUALITY / 100"

echo ""

# Step 6: Show Sample Documents
echo "[6/6] Sample documents:"
echo $DOCS_RESPONSE | jq '.documents[0:3] | .[] | {
  url: .title,
  status,
  chunks: .chunkCount,
  size: .contentSizeBytes,
  quality: .sourceMetadata.qualityMetrics.overallScore
}'

echo ""
echo "=== Test Complete ==="
echo ""
echo "IDs for further testing:"
echo "  KB_ID=$KB_ID"
echo "  INDEX_ID=$INDEX_ID"
echo "  SOURCE_ID=$SOURCE_ID"
echo "  JOB_ID=$JOB_ID"
echo ""
echo "Monitor logs:"
echo "  docker logs -f search-ai-service 2>&1 | grep -E 'crawler-ingestion|docling-extraction'"
echo ""
echo "Check full status:"
echo "  curl -s '$API_BASE/api/crawl/status?jobId=$JOB_ID' | jq"
echo "  curl -s '$API_BASE/api/indexes/$INDEX_ID/documents' -H 'x-tenant-id: $TENANT_ID' | jq"
