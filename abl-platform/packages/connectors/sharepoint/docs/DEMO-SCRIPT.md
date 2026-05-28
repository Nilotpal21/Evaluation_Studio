# SharePoint Connector - Demo Script

**Duration**: 10-15 minutes
**Audience**: Technical stakeholders, product team, potential customers
**Goal**: Demonstrate end-to-end SharePoint connector value proposition

---

## Pre-Demo Setup (5 minutes before)

### Environment Checklist

- [ ] Platform services running (MongoDB, Redis, Search AI API)
- [ ] CLI tool installed and tested (`kore-platform-cli --version`)
- [ ] SharePoint tenant accessible with test content
- [ ] Azure AD app registration ready (or demo the creation)
- [ ] Terminal window ready with large font (for visibility)
- [ ] Browser open to Azure Portal (if showing app registration)

### Test Data Preparation

- SharePoint site: `https://contoso.sharepoint.com/sites/engineering`
- Document library: "Documents" (with 10-20 sample files)
- Content types: Mix of Word docs, PDFs, Excel files
- Test search terms: "project plan", "meeting notes", "architecture"

---

## Demo Flow

### Part 1: Introduction (1 minute)

**Script:**

> "Today I'll demonstrate our new SharePoint connector for the Search AI platform. This connector allows enterprises to index their SharePoint content—documents, pages, metadata—and make it searchable through our unified search API.
>
> The key value proposition:
>
> - **Secure**: OAuth 2.0 authentication, tenant isolation, encrypted storage
> - **Flexible**: Filter by sites, libraries, content types
> - **Fast**: 10-20 documents per second sync rate
> - **CLI-first**: Developer-friendly commands for setup and management
>
> Let's walk through the complete workflow—from creation to searchable content—in under 10 minutes."

---

### Part 2: Azure AD App Registration (2 minutes)

**Option A: Show the process (if time permits)**

**Script:**

> "First, we need to create an Azure AD app registration. This is a one-time setup that allows our connector to authenticate with SharePoint."

**Steps:**

1. Navigate to Azure Portal → Azure AD → App registrations
2. Click "New registration"
3. Fill in:
   - **Name**: SearchAI SharePoint Connector Demo
   - **Account types**: Multitenant
   - **Redirect URI**: Public client - `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Click "Register"
5. Note the **Application (client) ID**: Copy to clipboard
6. Go to "API permissions"
   - Add permission → Microsoft Graph → Delegated
   - Select: `Sites.Read.All`, `Files.Read.All`
   - Click "Grant admin consent"
7. Go to "Authentication"
   - Enable "Allow public client flows" → Yes
   - Save

**Script:**

> "Now we have our client ID: `abc123...`. This is what the connector will use for authentication."

**Option B: Skip details (if short on time)**

**Script:**

> "I've already created an Azure AD app registration with the necessary permissions: `Sites.Read.All` and `Files.Read.All`. Here's the client ID we'll use: `abc123...`"

---

### Part 3: Create Search Index (1 minute)

**Command:**

```bash
kore-platform-cli index create "SharePoint Demo Index"
```

**Expected Output:**

```
✅ Index created successfully
📋 Index ID: idx_2f8a4c9e
📊 Status: active
🔍 Search endpoint: /api/indexes/idx_2f8a4c9e/search
```

**Script:**

> "First, we create a search index. This is the container for our searchable content. Note the index ID—we'll use this when creating the connector."

---

### Part 4: Create Connector (1 minute)

**Command:**

```bash
kore-platform-cli connector create sharepoint "Engineering SharePoint" \
  --index-id idx_2f8a4c9e
```

**Expected Output:**

```
✅ Connector created successfully
📋 Connector ID: conn_7b3d9a1f
🔗 Source ID: src_4e2c8b6a
📝 Type: sharepoint
🔐 Authentication required

Next step: Authenticate the connector
  kore-platform-cli connector auth conn_7b3d9a1f
```

**Script:**

> "The connector is created, but it's not authenticated yet. Let's do that next using OAuth Device Code Flow—a secure, CLI-friendly authentication method."

---

### Part 5: OAuth Authentication (2 minutes)

**Command:**

```bash
kore-platform-cli connector auth conn_7b3d9a1f
```

**Expected Output:**

```
┌──────────────────────────────────────────────────┐
│  SharePoint Authentication                       │
├──────────────────────────────────────────────────┤
│  1. Visit this URL in your browser:              │
│     https://microsoft.com/devicelogin            │
│                                                  │
│  2. Enter this code:                             │
│     ┌────────────┐                               │
│     │  WXYZ-5678 │                               │
│     └────────────┘                               │
│                                                  │
│  3. Sign in with your SharePoint account         │
└──────────────────────────────────────────────────┘

⏳ Waiting for authentication...
```

**Script:**

> "The CLI gives us a device code and a URL. Let me open that in a browser..."

**Browser Actions:**

1. Navigate to `https://microsoft.com/devicelogin`
2. Enter the device code: `WXYZ-5678`
3. Sign in with SharePoint account
4. Review permissions:
   - Read sites and document libraries
   - Read files and metadata
5. Click "Accept"

**Terminal Updates:**

```
✅ Successfully authenticated!
🔑 Token stored and encrypted
👤 Authenticated as: admin@contoso.com
⏰ Token valid until: 2026-05-24 14:30:00
📊 Scopes granted: Sites.Read.All, Files.Read.All

Connector is ready to sync!
```

**Script:**

> "Authentication complete! The access token is stored encrypted in our database. The connector is now ready to sync content."

---

### Part 6: Configure Filters (2 minutes)

**Script:**

> "Before syncing, let's configure filters. We'll only sync documents from the Engineering site."

**Command:**

```bash
kore-platform-cli connector filter set conn_7b3d9a1f \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --content-types "Document,Page"
```

**Expected Output:**

```
✅ Filters updated successfully
📋 Filter Configuration:
   Mode: include (whitelist)
   Sites: https://contoso.sharepoint.com/sites/engineering
   Content Types: Document, Page
   Libraries: (all)

💡 Tip: Use --libraries to filter by specific document libraries
```

**Script:**

> "Now the connector will only sync documents and pages from the Engineering site. This keeps the index focused and reduces sync time."

**Show Filters:**

```bash
kore-platform-cli connector show conn_7b3d9a1f
```

**Expected Output:**

```
┌─────────────────────────────────────────────────┐
│  Connector: Engineering SharePoint              │
├─────────────────────────────────────────────────┤
│  ID: conn_7b3d9a1f                              │
│  Type: sharepoint                               │
│  Index: SharePoint Demo Index (idx_2f8a4c9e)   │
│  Status: authenticated ✅                       │
│  Last Sync: Never                               │
│                                                 │
│  Filters:                                       │
│    • Sites: engineering                         │
│    • Content Types: Document, Page              │
│                                                 │
│  Documents: 0 (not synced yet)                  │
└─────────────────────────────────────────────────┘
```

---

### Part 7: Start Full Sync (3 minutes)

**Command:**

```bash
kore-platform-cli connector sync start conn_7b3d9a1f
```

**Expected Output:**

```
🚀 Starting full sync for connector: Engineering SharePoint
✅ Sync job initiated
📊 Job ID: sync_9c4e2a7d

Monitor progress:
  kore-platform-cli connector sync status conn_7b3d9a1f
```

**Monitor Progress (Check every 20-30 seconds):**

**Check 1 (20s):**

```bash
kore-platform-cli connector sync status conn_7b3d9a1f
```

```
┌─────────────────────────────────────────────────┐
│  Sync Status: Engineering SharePoint            │
├─────────────────────────────────────────────────┤
│  Status: syncing 🔄                             │
│  Started: 2026-02-23 14:15:32                   │
│  Elapsed: 20 seconds                            │
│                                                 │
│  Progress:                                      │
│    Documents processed: 45 / 150 (30%)         │
│    ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░                     │
│                                                 │
│  Performance:                                   │
│    Rate: 12.5 docs/sec                         │
│    ETA: ~8 minutes remaining                    │
│    Errors: 0                                    │
│                                                 │
│  Current: Syncing library "Documents"           │
└─────────────────────────────────────────────────┘
```

**Script:**

> "The sync is running. We're processing about 12-13 documents per second. The connector is enumerating sites, then libraries within each site, and finally fetching document metadata."

**Check 2 (40s):**

```
│  Progress:                                      │
│    Documents processed: 89 / 150 (59%)         │
│    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░                    │
```

**Check 3 (60s - Complete):**

```
┌─────────────────────────────────────────────────┐
│  Sync Complete ✅                               │
├─────────────────────────────────────────────────┤
│  Status: completed                              │
│  Duration: 1 minute 2 seconds                   │
│                                                 │
│  Results:                                       │
│    Total documents: 147                         │
│    Successfully synced: 147                     │
│    Failed: 0                                    │
│    Filtered out: 3 (non-matching content types) │
│                                                 │
│  Average rate: 14.2 docs/sec                    │
│                                                 │
│  Next Steps:                                    │
│    • Documents are being indexed in background  │
│    • Full-text search will be available shortly │
│    • Monitor ingestion: kore-platform-cli queue │
└─────────────────────────────────────────────────┘
```

**Script:**

> "Sync complete! We've synced 147 documents in just over a minute. These documents are now in the ingestion pipeline—being extracted, processed, and embedded for semantic search."

---

### Part 8: Verify Indexed Content (2 minutes)

**Script:**

> "Let's verify the documents are indexed and searchable."

**Check Document Count:**

```bash
kore-platform-cli connector show conn_7b3d9a1f
```

```
┌─────────────────────────────────────────────────┐
│  Connector: Engineering SharePoint              │
├─────────────────────────────────────────────────┤
│  ...                                            │
│  Last Sync: 2026-02-23 14:16:34 (1 minute ago) │
│  Documents: 147 ✅                              │
│  Status: active                                 │
└─────────────────────────────────────────────────┘
```

**Search for Content:**

```bash
kore-platform-cli index search idx_2f8a4c9e "project architecture"
```

**Expected Output:**

```
🔍 Search results for "project architecture"
Found 8 documents (0.23s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📄 System Architecture Overview.docx
   📍 https://contoso.sharepoint.com/sites/engineering/Documents/...
   📊 Score: 0.89

   "...The system architecture follows a microservices pattern
   with event-driven communication. Each service is deployed
   independently and scales based on load..."

   🏷  Site: Engineering
   📅 Modified: 2026-02-15 by John Doe

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📄 Project Kickoff - Architecture Review.pdf
   📍 https://contoso.sharepoint.com/sites/engineering/Documents/...
   📊 Score: 0.85

   "Meeting notes from the architecture review session.
   Key decisions: API-first design, GraphQL for client APIs..."

   🏷  Site: Engineering
   📅 Modified: 2026-02-10 by Jane Smith

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Script:**

> "Perfect! Our search is working. Notice the results include:
>
> - Original SharePoint URLs—users can click through to the source
> - Semantic relevance scores
> - Metadata: site name, modified date, author
> - Highlighted excerpts from the content
>
> These documents are now part of our unified search index, searchable alongside other data sources."

---

### Part 9: Demonstrate Filters (1 minute)

**Script:**

> "Let me show the power of filters. What if we only want to search recent documents?"

**Update Filter:**

```bash
kore-platform-cli connector filter set conn_7b3d9a1f \
  --sites "https://contoso.sharepoint.com/sites/engineering" \
  --content-types "Document,Page" \
  --modified-since "2026-02-01"
```

**Script:**

> "On the next sync, only documents modified after February 1st will be synced. This is useful for:
>
> - Focusing on recent content
> - Reducing sync time
> - Compliance (e.g., only index last 90 days)
>
> You can also filter by:
>
> - Specific document libraries
> - File size ranges
> - Exclude certain sites (blacklist mode)"

---

### Part 10: Management Operations (1 minute)

**List All Connectors:**

```bash
kore-platform-cli connector list --index-id idx_2f8a4c9e
```

**Expected Output:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Connectors for Index: SharePoint Demo Index                        │
├──────────────────┬─────────────┬──────┬─────────┬──────────────────┤
│  ID              │ Type        │ Auth │ Docs    │ Last Sync         │
├──────────────────┼─────────────┼──────┼─────────┼──────────────────┤
│  conn_7b3d9a1f   │ sharepoint  │ ✅   │ 147     │ 2 minutes ago     │
└──────────────────┴─────────────┴──────┴─────────┴──────────────────┘
```

**Pause Sync (if needed):**

```bash
kore-platform-cli connector sync pause conn_7b3d9a1f
```

**Script:**

> "The CLI provides full lifecycle management:
>
> - Create, update, delete connectors
> - Configure filters and permissions
> - Start, pause, resume syncs
> - Monitor progress and errors
>
> Everything is also available via REST API for programmatic control."

---

### Part 11: Wrap-Up & Next Steps (1 minute)

**Script:**

> "To recap what we've demonstrated:
>
> **✅ What Works Today (Phase 1 MVP):**
>
> - Secure OAuth authentication with SharePoint
> - Flexible filtering by sites, libraries, content types
> - Full sync with progress monitoring
> - Real-time searchable content with metadata
> - CLI-first management experience
> - 10-20 docs/sec sync performance
>
> **🚀 Coming in Phase 2:**
>
> - **Delta sync**: 10x faster incremental updates using change tokens
> - **Webhooks**: Real-time sync when documents change
> - **Permission crawling**: User-scoped search (only see what you have access to)
> - **Pause/resume**: Long-running syncs with checkpoint recovery
> - **Advanced filters**: Regex patterns, complex date ranges, size limits
>
> **🔮 Future Connectors:**
>
> - Jira (issues, comments, attachments)
> - Confluence (pages, spaces, attachments)
> - HubSpot (contacts, deals, notes)
> - ServiceNow (tickets, knowledge base)
> - Salesforce (accounts, opportunities, cases)
>
> The base connector infrastructure we built is reusable—new connectors share the same OAuth flows, rate limiting, and sync patterns.
>
> **Questions?**"

---

## Demo Variations

### Quick Demo (5 minutes)

If time is very limited:

1. **Show pre-created connector** (skip creation)
2. **Run authentication** (2 min)
3. **Start sync + monitor** (2 min)
4. **Show search results** (1 min)

### Deep Dive Demo (20-25 minutes)

If audience wants technical depth:

1. Include all steps above
2. **Show database records**: MongoDB queries for ConnectorConfig, SearchDocument
3. **Show API calls**: Use curl to demonstrate REST endpoints
4. **Show error handling**: Trigger an auth failure, show recovery
5. **Show filter evaluation**: Explain how filters are applied during sync
6. **Show ingestion pipeline**: Trace a document through extraction → embedding
7. **Q&A session**: 5-10 minutes for technical questions

---

## Common Questions & Answers

**Q: How long does initial sync take?**

> A: Depends on document count. Typical rates:
>
> - 1,000 docs: 1-2 minutes
> - 10,000 docs: 10-20 minutes
> - 100,000 docs: 2-3 hours
>   You can use aggressive filters to reduce scope.

**Q: What happens if SharePoint is unavailable during sync?**

> A: The sync will retry with exponential backoff. After 3 consecutive failures, the sync is paused and an alert is sent. You can resume manually once SharePoint is back.

**Q: How often should we sync?**

> A: Phase 1: Schedule full syncs (daily/weekly). Phase 2: Use delta sync (hourly) + webhooks (real-time).

**Q: Can we sync multiple SharePoint tenants?**

> A: Yes! Create one connector per tenant. Each has its own OAuth token and filters.

**Q: What about permissions? Can users only see documents they have access to?**

> A: Phase 2 feature. We'll crawl SharePoint permissions and apply them at query time. Three modes: Full (100% accurate), Simplified (95% accurate, 5x faster), Disabled (public access).

**Q: How secure is the OAuth token storage?**

> A: Tokens are encrypted at rest using AES-256 with tenant-scoped keys. Never logged or exposed in API responses. Automatically refreshed before expiry.

**Q: Can we exclude sensitive sites?**

> A: Yes! Use exclude mode: `--mode exclude --sites "https://contoso.sharepoint.com/sites/hr-confidential"`

**Q: What's the API rate limit?**

> A: Microsoft Graph: 10,000 requests per 10 minutes per tenant. Our rate limiter enforces this automatically with token bucket algorithm.

**Q: Can we sync on-premises SharePoint?**

> A: Not in Phase 1 (requires different auth). Phase 2 could add NTLM/Kerberos support.

**Q: How do we handle document updates?**

> A: Phase 1: Full re-sync detects changes via content hash. Phase 2: Delta sync fetches only changed docs.

**Q: What file types are supported?**

> A: All file types are synced. Extraction supports: PDF, DOCX, XLSX, PPTX, TXT, HTML, MD. Binary files (images, videos) store metadata only.

---

## Troubleshooting

### Issue: Device code not working

**Symptoms**: "authorization_pending" timeout after 10 minutes

**Solutions:**

1. Check Azure AD app has "Allow public client flows" enabled
2. Verify redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`
3. Ensure user is signing in with correct tenant account
4. Check browser isn't blocking the verification URL

### Issue: Sync stuck at 0%

**Symptoms**: Status shows "syncing" but no progress

**Solutions:**

1. Verify authentication: `kore-platform-cli connector show conn_xxx`
2. Check filters aren't excluding everything
3. Verify SharePoint site URL is accessible
4. Check MongoDB/Redis are running
5. Look at API logs: `docker logs search-ai-api | grep conn_xxx`

### Issue: Search returns no results

**Symptoms**: Sync complete but search finds nothing

**Solutions:**

1. Wait 1-2 minutes for ingestion pipeline to complete
2. Check document status: `db.search_documents.find({ sourceId: 'src_xxx' })`
3. Verify OpenSearch is running: `curl http://localhost:9200/_cluster/health`
4. Check ingestion queue: `kore-platform-cli queue status ingestion`

---

## Post-Demo Actions

**If demo went well:**

1. Share documentation: User guide, architecture doc, API reference
2. Provide test tenant credentials (if applicable)
3. Schedule follow-up for hands-on workshop
4. Discuss Phase 2 priorities and timeline

**If issues occurred:**

1. Document issues with screenshots/logs
2. Triage severity (blocker vs. polish)
3. Create tickets for fixes
4. Schedule follow-up demo after fixes

---

## Demo Checklist

**Before Demo:**

- [ ] Services running and tested
- [ ] CLI commands tested end-to-end
- [ ] SharePoint tenant accessible
- [ ] Azure AD app registered (or ready to create)
- [ ] Terminal font large and readable
- [ ] Browser tabs ready
- [ ] Backup plan if live demo fails (screenshots/video)

**During Demo:**

- [ ] Introduction and goals stated clearly
- [ ] Each command explained before running
- [ ] Outputs highlighted and interpreted
- [ ] Filters and configuration explained
- [ ] Search results showcased with metadata
- [ ] Questions encouraged throughout
- [ ] Phase 2 roadmap presented
- [ ] Next steps discussed

**After Demo:**

- [ ] Feedback collected (what worked, what didn't)
- [ ] Follow-up actions scheduled
- [ ] Documentation links shared
- [ ] Demo recording uploaded (if recorded)
- [ ] Thank you / stay in touch

---

## Appendix: Sample SharePoint Test Data

### Recommended Test Site Structure

**Site**: `https://contoso.sharepoint.com/sites/engineering`

**Document Libraries:**

- **Documents** (default)
  - Project Plans (5 files): DOCX, PDF
  - Architecture Diagrams (3 files): PDF, PPTX
  - Meeting Notes (8 files): DOCX, MD
  - Specifications (6 files): PDF, DOCX
- **Shared Documents**
  - Team Guidelines (2 files): DOCX
  - Onboarding (3 files): PDF, DOCX

**Content Types:**

- Document (Word, PDF)
- Presentation (PowerPoint)
- Spreadsheet (Excel) - optional for demo
- Page (SharePoint site pages)

**Metadata:**

- Modified dates: Mix of recent (last 7 days) and older (30+ days)
- Authors: 3-4 different users
- File sizes: Range from 10KB to 5MB

This structure provides realistic variety for demonstrating filters, search relevance, and metadata display.
