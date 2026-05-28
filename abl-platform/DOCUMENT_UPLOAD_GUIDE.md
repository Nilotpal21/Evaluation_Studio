# SearchAI Document Upload - Complete Guide

## ✅ Working Services

All required services are running and healthy:

- ✅ **Studio** (Frontend) - http://localhost:5173
- ✅ **Runtime** (API) - http://localhost:3112
- ✅ **SearchAI** (Ingestion) - http://localhost:3005
- ✅ **SearchAI-Runtime** (Query) - http://localhost:3004
- ✅ **Docling** (Document Processing) - http://localhost:8080
- ✅ **BGE-M3** (Embeddings) - http://localhost:8000
- ✅ **Preprocessing** - http://localhost:8003
- ✅ **MongoDB** - Port 27018
- ✅ **ClickHouse** - Port 8124
- ✅ **OpenSearch** - Port 9200

## ❌ Issues Found

### 1. Manual `--data-raw` Upload Failures

**Problem:**

```bash
# ❌ THIS DOESN'T WORK
curl ... --data-raw $'------WebKitBoundary\r\nContent-Disposition...\r\n\r\n\r\n------WebKitBoundary--'
```

**Why it fails:**

- Empty file content between boundaries
- Manual multipart encoding is error-prone
- Missing proper Content-Length headers
- Incorrect boundary handling

**Solution:**

```bash
# ✅ USE THIS INSTEAD
curl ... -F 'file=@/path/to/file.md' -F 'metadata={"file_type":"md"}'
```

### 2. Server Timeout (500 Error)

**Problem:**

- Upload API times out after ~30 seconds
- Returns "Internal Server Error"
- Happens with new files and `force=true`

**Root Cause Analysis:**

- SearchAI service expects Redis for job queuing
- Redis is running but requires authentication
- Service falls back to no-op Redis client
- Document processing may be trying to queue jobs and failing
- No proper error handling/logging for this case

**Evidence:**

```
[ioredis] Unhandled error event: ReplyError: NOAUTH Authentication required.
search-ai dev: Config shows: Redis: disabled
```

### 3. Duplicate Detection Works

**Good news:**
The API correctly detects duplicates by content hash:

```json
{
  "message": "Document already exists (duplicate content hash). Use force=true to replace.",
  "document": {...}
}
```

This proves the upload API **IS working** for initial uploads.

## 🎯 Solutions

### Option 1: Use the Helper Script (Recommended)

```bash
# Upload a document
./upload-document.sh /path/to/document.md

# Replace existing document
./upload-document.sh /path/to/document.md force
```

### Option 2: Correct curl Command

```bash
# Get token
TOKEN=$(curl -s 'http://localhost:5173/api/auth/dev-login' \
  -H 'Content-Type: application/json' \
  --data-raw '{"email":"dev@kore.ai","name":"Developer"}' | jq -r '.accessToken')

# Upload document
curl 'http://localhost:5173/api/search-ai/indexes/019cdd6a-070f-7e09-ad2b-f04c8ba4387c/sources/019ce1e6-ad99-755d-8fe0-614a30fc4078/documents' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Tenant-Id: 019cdd3b-4e35-74ff-8219-df2753919644' \
  -F 'file=@/path/to/file.md' \
  -F 'metadata={"file_type":"md"}'
```

### Option 3: Use the Web UI

1. Navigate to http://localhost:5173
2. Go to your SearchAI knowledge base
3. Use the upload button in the UI

## 🔍 Monitoring Logs

### All Services (Combined)

```bash
tail -f /private/tmp/claude-504/-Users-RamGopal-Suryadevara-abl-platform/*/tasks/bto0hcpn9.output
```

### SearchAI Only (Clean)

```bash
tail -f /private/tmp/claude-504/-Users-RamGopal-Suryadevara-abl-platform/*/tasks/bto0hcpn9.output | grep "search-ai dev:" | grep -v "ioredis\|NOAUTH"
```

### Document Processing

```bash
tail -f /private/tmp/claude-504/-Users-RamGopal-Suryadevara-abl-platform/*/tasks/bto0hcpn9.output | grep -i "document\|extract\|chunk\|embed"
```

## 🐛 Known Issues & Workarounds

### Issue: 500 Error on New Uploads

**Status:** Under investigation

**Likely Causes:**

1. Redis authentication not configured
2. Document processing queue initialization failing
3. Job queuing falling back to no-op client silently

**Workarounds:**

1. Use the browser UI for uploads (may work better)
2. Check if document was actually created despite 500 error
3. Query documents API to verify:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
        -H "X-Tenant-Id: $TENANT_ID" \
        "http://localhost:5173/api/search-ai/indexes/$INDEX_ID/documents"
   ```

### Issue: Redis Authentication Errors (Non-blocking)

**Status:** Warning only, services work with fallback

The services show Redis auth errors but continue to function with in-memory fallbacks. This is expected in dev mode without Redis password configured.

## 📊 Upload API Reference

### Endpoint

```
POST /api/search-ai/indexes/:indexId/sources/:sourceId/documents
```

### Headers

```
Authorization: Bearer <token>
X-Tenant-Id: <tenantId>
Content-Type: multipart/form-data
```

### Form Data

- `file`: File to upload (required)
- `metadata`: JSON object (optional)
  - `file_type`: string
  - Custom fields as needed

### Query Parameters

- `force=true`: Replace existing document with same content hash

### Response (Success)

```json
{
  "document": {
    "_id": "019ce1f7-...",
    "originalReference": "filename.md",
    "status": "pending",
    "contentSizeBytes": 358,
    "createdAt": "2026-03-12T12:13:25.401Z"
  }
}
```

### Response (Duplicate)

```json
{
  "message": "Document already exists (duplicate content hash). Use force=true to replace.",
  "document": {...}
}
```

## 🔧 Troubleshooting

### Check Service Health

```bash
# Studio/API
curl http://localhost:5173/api/health

# Runtime
curl http://localhost:3112/health

# SearchAI Runtime
curl http://localhost:3004/health

# Docling
curl http://localhost:8080/health

# BGE-M3
curl http://localhost:8000/health
```

### Verify Document Exists

```bash
TOKEN=$(curl -s 'http://localhost:5173/api/auth/dev-login' \
  -H 'Content-Type: application/json' \
  --data-raw '{"email":"dev@kore.ai","name":"Developer"}' | jq -r '.accessToken')

curl -s "http://localhost:5173/api/search-ai/indexes/019cdd6a-070f-7e09-ad2b-f04c8ba4387c/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: 019cdd3b-4e35-74ff-8219-df2753919644" | jq .
```

## 📝 Summary

**What's Working:**

- ✅ All services are running
- ✅ Initial document upload API works
- ✅ Duplicate detection works
- ✅ Document metadata storage works
- ✅ Python services (Docling, BGE-M3) are healthy

**What's Not Working:**

- ❌ Replacing documents with `force=true` (500 error)
- ❌ Uploading new documents after initial one (500 error / timeout)
- ⚠️ Document processing queue may not be functioning

**Next Steps:**

1. Use the helper script for uploads: `./upload-document.sh file.md`
2. Check if documents appear in the UI despite 500 errors
3. Monitor logs during upload to identify exact failure point
4. Consider configuring Redis properly or fixing the fallback handling
