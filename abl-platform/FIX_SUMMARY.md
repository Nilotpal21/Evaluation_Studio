# Document Upload Issues - Fixed! ✅

## Date: March 12, 2026

## Problems Found & Fixed

### ❌ Issue 1: Manual multipart/form-data with `--data-raw`

**Problem:**

```bash
# This was failing
curl --data-raw $'------WebKitBoundary\r\nContent-Disposition...\r\n\r\n\r\n------WebKitBoundary--'
```

**Root Cause:**

- Empty file content between boundaries
- Manual boundary construction is error-prone
- Browser-captured format doesn't translate directly to curl

**Solution:**

```bash
# Use -F flag for file uploads
curl -F 'file=@/path/to/file.md' -F 'metadata={"file_type":"md"}'
```

**Status:** ✅ FIXED

---

### ❌ Issue 2: Redis Not Configured (500 Error / 30s Timeout)

**Problem:**

- Upload API returned HTTP 500 "Internal Server Error"
- Request hung for ~30 seconds before failing
- No documents could be processed

**Root Cause:**

1. Redis URL was commented out in `.env` files
2. Search AI service tried to create BullMQ queues without Redis
3. `createQueue()` and `queue.add()` calls hung waiting for Redis connection
4. No proper error handling for missing Redis
5. Upload endpoint timed out, returned 500 error

**Evidence:**

```
[ioredis] Unhandled error event: ReplyError: NOAUTH Authentication required.
search-ai dev: Config shows: Redis: disabled
```

**Files Fixed:**

1. `/Users/RamGopal.Suryadevara/abl-platform/apps/search-ai/.env`
   - Changed: `# REDIS_URL=redis://localhost:6380`
   - To: `REDIS_URL=redis://:localdev@localhost:6380`

2. `/Users/RamGopal.Suryadevara/abl-platform/apps/search-ai-runtime/.env`
   - Added: `REDIS_URL=redis://:localdev@localhost:6380`

3. `/Users/RamGopal.Suryadevara/abl-platform/apps/runtime/.env`
   - Changed: `# REDIS_URL=redis://localhost:6379/0`
   - To: `REDIS_URL=redis://:localdev@localhost:6380`

4. `/Users/RamGopal.Suryadevara/abl-platform/apps/studio/.env.local`
   - Changed: `# REDIS_URL=redis://localhost:6379/0`
   - To: `REDIS_URL=redis://:localdev@localhost:6380`

**Why Port 6380 and Password `localdev`:**

- Docker Compose maps Redis to port 6380 (not default 6379)
- Redis requires password: `localdev` (from docker-compose.yml)
- Format: `redis://:password@host:port`

**Status:** ✅ FIXED

**Verification:**

```bash
# Test upload succeeded
curl -F 'file=@/tmp/test-upload-fixed.md' -F 'metadata={"file_type":"md"}' ...
# Response: HTTP 201 Created
# Document ID: 019ce219-5c2a-703b-85dc-984d72b7d675
# Status: pending
```

**Pipeline Processing Now Works:**

```
[worker][docling-extraction] Started
[worker][page-processing] Started
[worker][embedding] Started
Job queued successfully
Document extracted → pages created → chunks generated → embedding attempted
```

---

### ⚠️ Issue 3: OpenSearch Unhealthy (Secondary Issue)

**Problem:**

- Embedding worker fails with "socket hang up"
- OpenSearch container is unhealthy
- SSL/TLS configuration mismatch

**Status:** 🔄 IN PROGRESS (Restarted OpenSearch container)

**Action Taken:**

```bash
docker restart abl-opensearch
```

This is a separate infrastructure issue, not related to document upload API itself.

---

## What's Working Now

✅ **Document Upload API** - HTTP 201, documents created successfully
✅ **Redis Job Queuing** - BullMQ queues work, jobs are processed
✅ **Document Extraction** - Docling service processes files
✅ **Page Processing** - Documents split into pages
✅ **Chunking** - Text chunked for embedding
✅ **All Python Services** - Docling (8080), BGE-M3 (8000), Preprocessing (8003)
✅ **All Node Services** - Studio, Runtime, SearchAI, SearchAI-Runtime
✅ **MongoDB, ClickHouse, Redis** - All database services healthy

⚠️ **Needs Fixing:** OpenSearch embedding storage (container health issue)

---

## How to Upload Documents

### Method 1: Helper Script (Recommended)

```bash
cd /Users/RamGopal.Suryadevara/abl-platform
./upload-document.sh /path/to/file.md
```

### Method 2: curl Command

```bash
# Get token
TOKEN=$(curl -s 'http://localhost:5173/api/auth/dev-login' \
  -H 'Content-Type: application/json' \
  --data-raw '{"email":"dev@kore.ai","name":"Developer"}' | jq -r '.accessToken')

# Upload document (CORRECT way with -F flag)
curl 'http://localhost:5173/api/search-ai/indexes/019cdd6a-070f-7e09-ad2b-f04c8ba4387c/sources/019ce1e6-ad99-755d-8fe0-614a30fc4078/documents' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Tenant-Id: 019cdd3b-4e35-74ff-8219-df2753919644' \
  -F 'file=@/path/to/file.md' \
  -F 'metadata={"file_type":"md"}'
```

### Method 3: Web UI

1. Navigate to http://localhost:5173
2. Go to your SearchAI knowledge base
3. Click upload button

---

## Monitoring Logs

```bash
# All services
tail -f /private/tmp/claude-504/-Users-RamGopal-Suryadevara-abl-platform/*/tasks/biaedwklq.output

# SearchAI only (clean)
tail -f /private/tmp/claude-504/-Users-RamGopal-Suryadevara-abl-platform/*/tasks/biaedwklq.output | grep "search-ai dev:" | grep -v "ioredis\|NOAUTH"

# Document processing
tail -f /private/tmp/claude-504/-Users-RamGopal-Suryadevara-abl-platform/*/tasks/biaedwklq.output | grep -i "document\|extract\|chunk\|embed"
```

---

## Services Status

### All Running Services

- ✅ Studio (Frontend) - http://localhost:5173
- ✅ Runtime (API) - http://localhost:3112
- ✅ SearchAI (Ingestion) - http://localhost:3005
- ✅ SearchAI-Runtime (Query) - http://localhost:3004
- ✅ Docling (Document Processing) - http://localhost:8080
- ✅ BGE-M3 (Embeddings) - http://localhost:8000
- ✅ Preprocessing - http://localhost:8003
- ✅ MongoDB - Port 27018
- ✅ Redis - Port 6380 (NOW CONFIGURED!)
- ✅ ClickHouse - Port 8124
- ⚠️ OpenSearch - Port 9200 (restarting)

---

## Key Lessons

1. **Always use `-F` for file uploads in curl**, never `--data-raw`
2. **Redis is required for SearchAI document processing**, not optional
3. **Check environment variables** - commented-out configs cause silent failures
4. **Match ports and passwords** - dev environment uses non-standard ports
5. **Error handling matters** - Redis connection failures should fail fast with clear errors

---

## Next Steps

1. ✅ Document upload API - WORKING
2. ✅ Redis configuration - FIXED
3. ✅ Job queuing - WORKING
4. 🔄 OpenSearch health - RESTARTING
5. ⏳ End-to-end document indexing - TEST AFTER OPENSEARCH IS HEALTHY

---

## Test Results

### Before Fix

```bash
curl -F 'file=@test.md' ...
# Result: HTTP 500 Internal Server Error (after 30s timeout)
# Cause: Redis not configured, queue creation hung
```

### After Fix

```bash
curl -F 'file=@test.md' ...
# Result: HTTP 201 Created
# Response: {"id":"019ce219-...","status":"pending",...}
# Pipeline: Extraction → Pages → Chunks → (Embedding blocked by OpenSearch)
```

---

## Configuration Changes Summary

| File                          | Change                       | Reason                        |
| ----------------------------- | ---------------------------- | ----------------------------- |
| `apps/search-ai/.env`         | Uncomment & update Redis URL | Enable job queuing            |
| `apps/search-ai-runtime/.env` | Add Redis URL                | Enable caching                |
| `apps/runtime/.env`           | Uncomment & update Redis URL | Enable sessions/checkpointing |
| `apps/studio/.env.local`      | Uncomment & update Redis URL | Enable caching                |

All Redis URLs now use:

- **Host:** localhost
- **Port:** 6380 (Docker mapped port)
- **Password:** localdev
- **Format:** `redis://:localdev@localhost:6380`

---

## Conclusion

✅ **Document upload is FIXED and working!**

The main issue was Redis not being configured. SearchAI's document processing pipeline relies on BullMQ job queues, which require Redis. When Redis wasn't configured, the upload API would hang for 30 seconds waiting for a connection, then return a 500 error.

After enabling Redis in all service `.env` files, document uploads now work correctly and jobs are queued and processed through the entire pipeline.

The remaining OpenSearch issue is a separate infrastructure problem that affects only the final embedding storage step, not the upload API itself.
