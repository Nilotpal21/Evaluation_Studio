# Contact Card Architecture — Visual Diagrams

**Companion to:** `CONTACT-CARD-MULTI-CONNECTOR-ANALYSIS.md`
**Purpose:** Visual representation of user identity flows and component architecture

---

## Current State Architecture

### User Identity Sources (Disconnected)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ABL Platform                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────────────┐      ┌────────────────┐      ┌──────────────────┐ │
│  │  Platform      │      │  IdP Users     │      │  Connector       │ │
│  │  Users         │      │  (Neo4j)       │      │  Metadata        │ │
│  │  (MongoDB)     │      │                │      │  (MongoDB)       │ │
│  ├────────────────┤      ├────────────────┤      ├──────────────────┤ │
│  │                │      │                │      │                  │ │
│  │ • _id          │      │ • email        │      │ sourceMetadata:  │ │
│  │ • email        │      │ • displayName  │      │                  │ │
│  │ • name         │      │ • idpUserId    │      │ sharepoint: {    │ │
│  │ • avatarUrl    │      │ • idpProvider  │      │   createdBy:     │ │
│  │ • authProvider │      │ • domain       │      │   "Alice J..."   │ │
│  │                │      │ • status       │      │ }                │ │
│  │                │      │                │      │                  │ │
│  └────────────────┘      └────────────────┘      └──────────────────┘ │
│         │                        │                        │            │
│         │                        │                        │            │
│         ▼                        ▼                        ▼            │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │             ❌ NO UNIFIED IDENTITY SERVICE                        │ │
│  │             ❌ NO CROSS-REFERENCE                                 │ │
│  │             ❌ NO IDENTITY RESOLUTION                             │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

Current Avatar Component:
┌────────────────────────────┐
│  Avatar                    │
├────────────────────────────┤
│  Props:                    │
│  • name: string            │
│  • src?: string            │
│  • size: 'sm'|'md'|'lg'    │
│                            │
│  Uses:                     │
│  • Platform users ONLY     │
│  • No connector context    │
│  • No source indication    │
└────────────────────────────┘
```

---

## Proposed Architecture

### Unified User Identity Service

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Unified User Identity Service                           │
│                     (packages/search-ai-internal/identity)                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
                    ▼                 ▼                 ▼
        ┌──────────────────┐  ┌────────────┐  ┌──────────────────┐
        │  IdP Users       │  │  Platform  │  │  Connector       │
        │  (Neo4j)         │  │  Users     │  │  Metadata        │
        │                  │  │  (MongoDB) │  │  (MongoDB)       │
        │  Priority: 1     │  │  Priority: 2│  │  Priority: 3     │
        │  (Authoritative) │  │  (Fallback)│  │  (Last resort)   │
        └──────────────────┘  └────────────┘  └──────────────────┘
                    │                 │                 │
                    └─────────────────┼─────────────────┘
                                      ▼
                        ┌─────────────────────────────┐
                        │  Redis Cache                │
                        │  (5-minute TTL)             │
                        │                             │
                        │  Key:                       │
                        │  user-profile:              │
                        │    {tenantId}:              │
                        │    {email}                  │
                        │                             │
                        │  Value:                     │
                        │  UnifiedUserProfile         │
                        └─────────────────────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────────┐
                        │  ContactCard Component      │
                        │  (Enhanced Avatar)          │
                        └─────────────────────────────┘
```

---

## User Identity Resolution Flow

### Scenario: Display document author in search results

```
User opens Search-AI → Views results for "Q1 Report"

Step 1: SearchDocument retrieved from MongoDB
┌──────────────────────────────────────────────────────────┐
│ {                                                        │
│   _id: "doc-123",                                        │
│   sourceId: "connector-sharepoint-789",                 │
│   sourceMetadata: {                                      │
│     sharepoint: {                                        │
│       createdBy: "Alice Johnson",    ← Display name only│
│       itemId: "...",                                     │
│       siteId: "..."                                      │
│     }                                                    │
│   }                                                      │
│ }                                                        │
└──────────────────────────────────────────────────────────┘
                    │
                    ▼
Step 2: Resolve "Alice Johnson" → UnifiedUserProfile
┌──────────────────────────────────────────────────────────┐
│  UnifiedUserIdentityService.resolve()                    │
│                                                          │
│  1. Extract email from connector metadata               │
│     (SharePoint API provides email with user object)    │
│                                                          │
│  2. Check Redis cache:                                  │
│     GET user-profile:tenant-123:alice@contoso.com       │
│                                                          │
│  3. If MISS → Fetch from sources (priority order):      │
│     a) Neo4j: MATCH (u:User {email: "alice@..."})       │
│        → displayName: "Alice Johnson"                   │
│        → avatarUrl: null                                │
│        → idpProvider: "azuread"                         │
│                                                          │
│     b) Platform: User.findOne({email: "alice@..."})     │
│        → name: null                                     │
│        → avatarUrl: null                                │
│                                                          │
│     c) Connector metadata:                              │
│        → displayName: "Alice Johnson"                   │
│        → avatarUrl: null (SharePoint doesn't provide)   │
│                                                          │
│  4. Fallback chain for avatar:                          │
│     a) IdP avatar (Azure AD) → ❌ Not available         │
│     b) Platform avatar → ❌ Not available               │
│     c) Gravatar → ✅ Found!                             │
│                                                          │
│  5. Cache result in Redis (TTL: 5 min)                  │
└──────────────────────────────────────────────────────────┘
                    │
                    ▼
Step 3: Render ContactCard with resolved profile
┌──────────────────────────────────────────────────────────┐
│  <ContactCard                                            │
│    email="alice@contoso.com"                             │
│    displayName="Alice Johnson"                           │
│    avatarUrl="https://gravatar.com/..."                 │
│    source="sharepoint"                                   │
│    role="owner"                                          │
│    showSource={true}                                     │
│  />                                                      │
│                                                          │
│  Renders as:                                             │
│  ┌────────────────────────────────┐                     │
│  │  [Avatar]  Alice Johnson       │                     │
│  │           alice@contoso.com     │                     │
│  │           [SharePoint Badge]    │                     │
│  └────────────────────────────────┘                     │
│                                                          │
│  On hover → Tooltip shows:                               │
│  • Full email                                            │
│  • Source: SharePoint                                    │
│  • Role: Owner                                           │
│  • Last seen: 2024-02-15                                 │
└──────────────────────────────────────────────────────────┘
```

---

## Multi-Connector Identity Mapping

### Scenario: Same user across 3 connectors

```
Alice Johnson exists in:
  ├─ Azure AD (IdP)          → alice@contoso.com        [Authoritative]
  ├─ SharePoint (Connector)  → alice@contoso.com        [Same email]
  ├─ Jira (Connector)        → alice.johnson@contoso.com [Alias!]
  └─ Confluence (Connector)  → alice@contoso.com        [Same email]

Current State: ❌ Treated as 2 separate users
                  (alice@contoso.com != alice.johnson@contoso.com)

Proposed Solution: Identity Alias Resolution
┌─────────────────────────────────────────────────────────────────┐
│  IIdentityAlias (MongoDB)                                       │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ {                                                         │ │
│  │   tenantId: "tenant-123",                                 │ │
│  │   canonicalEmail: "alice@contoso.com",                    │ │
│  │   aliases: [                                              │ │
│  │     {                                                     │ │
│  │       email: "alice.johnson@contoso.com",                 │ │
│  │       source: "jira",                                     │ │
│  │       confidence: 0.95,    ← ML model confidence         │ │
│  │       verifiedBy: "admin-user-123",  ← Manual confirm    │ │
│  │       verifiedAt: "2024-02-15T10:00:00Z"                  │ │
│  │     }                                                     │ │
│  │   ],                                                      │ │
│  │   displayNames: {                                         │ │
│  │     "azuread": "Alice Johnson",                           │ │
│  │     "sharepoint": "Alice Johnson",                        │ │
│  │     "jira": "Alice J.",                                   │ │
│  │     "confluence": "alice.johnson"                         │ │
│  │   },                                                      │ │
│  │   preferredDisplayName: "Alice Johnson"  ← From IdP      │ │
│  │ }                                                         │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

Resolution Logic:
  1. Query by any email alias → Returns canonical profile
  2. Display name: Use preferred (IdP) or most recent
  3. Avatar: Follow fallback chain (IdP → Platform → Connector → Gravatar)
```

---

## ContactCard Component Architecture

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  ContactCard (New)                                              │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Props:                                                   │ │
│  │  • email: string                    [Required]           │ │
│  │  • displayName: string              [Required]           │ │
│  │  • avatarUrl?: string               [Optional]           │ │
│  │  • source?: ConnectorType           [Optional]           │ │
│  │  • role?: 'owner'|'editor'|'viewer' [Optional]           │ │
│  │  • showSource?: boolean             [Optional]           │ │
│  │  • showTooltip?: boolean            [Optional]           │ │
│  │  • onClick?: () => void             [Optional]           │ │
│  │                                                           │ │
│  │  Uses:                                                    │ │
│  │  ├─ Avatar (existing component)                          │ │
│  │  ├─ SourceBadge (new)                                    │ │
│  │  ├─ Tooltip (new)                                        │ │
│  │  └─ UserProfilePanel (new, on click)                     │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

Usage Patterns:

1. Search Results
   <ContactCard
     email="alice@contoso.com"
     displayName="Alice Johnson"
     avatarUrl="https://..."
     source="sharepoint"
     role="owner"
     showSource={true}
   />

2. Document Detail View
   <div>
     <label>Created by:</label>
     <ContactCard
       email="alice@contoso.com"
       displayName="Alice Johnson"
       avatarUrl="https://..."
       source="sharepoint"
       showEmail={true}
     />
   </div>

3. Permission List
   <ul>
     {users.map(user => (
       <li>
         <ContactCard
           email={user.email}
           displayName={user.displayName}
           source="idp"
           role={user.role}
           onClick={() => openUserProfile(user)}
         />
       </li>
     ))}
   </ul>

4. Chat Context (RAG Citations)
   <blockquote>
     According to the Q1 Report by
     <ContactCard
       email="alice@contoso.com"
       displayName="Alice Johnson"
       size="sm"
       showSource={false}
     />
   </blockquote>
```

---

## Data Flow: Document Ingestion with User Enrichment

### Enhanced Ingestion Pipeline

```
┌────────────────────────────────────────────────────────────────────┐
│  Connector Worker (e.g., SharePoint Full Sync)                     │
└────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │  Microsoft Graph API Response        │
        ├──────────────────────────────────────┤
        │  {                                   │
        │    id: "item-123",                   │
        │    name: "Q1 Report.docx",           │
        │    createdBy: {                      │
        │      user: {                         │
        │        displayName: "Alice Johnson", │
        │        email: "alice@contoso.com",   │
        │        id: "00000000-..."  ← Azure AD Object ID
        │      }                                │
        │    },                                │
        │    lastModifiedBy: { ... }           │
        │  }                                   │
        └──────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │  Extract User Information            │
        ├──────────────────────────────────────┤
        │  const creator = {                   │
        │    email: item.createdBy.user.email, │
        │    displayName: item.createdBy...    │
        │    connectorUserId: item.createdBy...│
        │  };                                  │
        └──────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │  Resolve Avatar URL                  │
        ├──────────────────────────────────────┤
        │  const avatarUrl =                   │
        │    await resolveAvatar(              │
        │      tenantId,                       │
        │      creator.email                   │
        │    );                                │
        │                                      │
        │  // Returns:                         │
        │  // IdP → Platform → Gravatar → null│
        └──────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │  Create Enriched SearchDocument      │
        ├──────────────────────────────────────┤
        │  {                                   │
        │    _id: "doc-456",                   │
        │    tenantId: "tenant-123",           │
        │    sourceId: "connector-789",        │
        │                                      │
        │    // Raw connector metadata         │
        │    sourceMetadata: {                 │
        │      sharepoint: {                   │
        │        createdBy: "Alice Johnson",   │
        │        itemId: "item-123",           │
        │        siteId: "site-456"            │
        │      }                               │
        │    },                                │
        │                                      │
        │    // NEW: Enriched user references  │
        │    authors: {                        │
        │      creator: {                      │
        │        email: "alice@contoso.com",   │
        │        displayName: "Alice Johnson", │
        │        avatarUrl: "https://...",     │
        │        source: "sharepoint",         │
        │        connectorUserId: "00000..."   │
        │      },                              │
        │      lastModifiedBy: { ... }         │
        │    }                                 │
        │  }                                   │
        └──────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │  Save to MongoDB                     │
        │  (SearchDocument collection)         │
        └──────────────────────────────────────┘
```

---

## Avatar Resolution Priority

### Waterfall Resolution Logic

```
┌─────────────────────────────────────────────────────────────────┐
│  resolveAvatar(tenantId: string, email: string)                 │
│                                                                 │
│  Step 1: Check IdP (Neo4j)                                      │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ MATCH (u:User {tenantId: $tenantId, email: $email})      │ │
│  │ WHERE u.idpProvider IS NOT NULL                           │ │
│  │ RETURN u                                                  │ │
│  └───────────────────────────────────────────────────────────┘ │
│           │                                                     │
│           ├─ Azure AD   → Microsoft Graph /me/photo/$value     │
│           ├─ Okta       → Okta API /users/{id}/avatar          │
│           └─ Google     → Google People API /people/me/photos   │
│           │                                                     │
│           ▼                                                     │
│     [Avatar URL] ✅ → Return (highest priority)                │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Step 2: Check Platform User (MongoDB)                         │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ User.findOne({ email: email })                            │ │
│  │ .select('avatarUrl')                                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│           │                                                     │
│           ▼                                                     │
│     [Avatar URL] ✅ → Return (second priority)                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Step 3: Check Connector Metadata (MongoDB)                    │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ SearchDocument.find({                                     │ │
│  │   'authors.creator.email': email                          │ │
│  │ }).select('authors.creator.avatarUrl')                    │ │
│  │  .sort({ createdAt: -1 })                                 │ │
│  │  .limit(1)                                                │ │
│  └───────────────────────────────────────────────────────────┘ │
│           │                                                     │
│           ▼                                                     │
│     [Avatar URL] ✅ → Return (third priority)                  │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Step 4: Try Gravatar (External)                               │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ const hash = md5(email.toLowerCase().trim());             │ │
│  │ const url = `https://gravatar.com/avatar/${hash}?d=404`;  │ │
│  │ if (await checkImageExists(url)) return url;              │ │
│  └───────────────────────────────────────────────────────────┘ │
│           │                                                     │
│           ▼                                                     │
│     [Avatar URL] ✅ → Return (fourth priority)                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Step 5: Fallback to null                                      │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ return null;  // ContactCard will show initials            │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

Performance Optimization:
• Cache each step result in Redis (1-hour TTL)
• Cache key: `avatar:${tenantId}:${email}:${source}`
• First call: 50-200ms (API roundtrips)
• Cached calls: <5ms (Redis)
```

---

## Summary Diagram: End-to-End Flow

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  User views  │   1     │  Search-AI   │   2     │  Fetch       │
│  search      │ ───────▶│  Runtime     │────────▶│  documents   │
│  results     │         │              │         │  from MongoDB│
└──────────────┘         └──────────────┘         └──────────────┘
                                                           │
                                                           │ 3. Extract
                                                           │    author info
                                                           ▼
                                                   ┌──────────────┐
                                                   │  Unified     │
                                                   │  User        │
                                                   │  Identity    │
                                                   │  Service     │
                                                   └──────────────┘
                                                           │
                        ┌──────────────────────────────────┼──────────┐
                        │                                  │          │
                        ▼                                  ▼          ▼
                ┌──────────────┐                   ┌──────────┐ ┌──────────┐
                │  Check Redis │                   │  Neo4j   │ │ MongoDB  │
                │  Cache       │                   │  (IdP)   │ │ (Users)  │
                └──────────────┘                   └──────────┘ └──────────┘
                        │                                  │          │
                        │ 4. MISS                          │          │
                        └──────────────────┬───────────────┘          │
                                           │                          │
                                           ▼                          │
                                   ┌──────────────┐                  │
                                   │  Resolve     │                  │
                                   │  Avatar      │◀─────────────────┘
                                   │  (Waterfall) │
                                   └──────────────┘
                                           │
                                           │ 5. Cache result
                                           ▼
                                   ┌──────────────┐
                                   │  Redis       │
                                   │  (5-min TTL) │
                                   └──────────────┘
                                           │
                                           │ 6. Return profile
                                           ▼
┌──────────────┐         ┌──────────────────────────────────┐
│  Render      │   7     │  UnifiedUserProfile:             │
│  ContactCard │◀────────│  • email                         │
│  with avatar │         │  • displayName                   │
│              │         │  • avatarUrl                     │
│              │         │  • source (sharepoint)           │
│              │         │  • role (owner)                  │
└──────────────┘         └──────────────────────────────────┘
```

---

## Related Documentation

- **Analysis:** `CONTACT-CARD-MULTI-CONNECTOR-ANALYSIS.md`
- **Neo4j Schema:** `packages/search-ai-internal/src/permissions/neo4j-permission-schema.md`
- **IdP Auth API:** `IDP-AUTHENTICATION-API.md`

---

**Document Version:** 1.0
**Last Updated:** 2026-03-05
