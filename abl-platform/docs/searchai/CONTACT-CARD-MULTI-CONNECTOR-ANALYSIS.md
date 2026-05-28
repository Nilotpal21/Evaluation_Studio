# Contact Card & Multi-Connector User Identity Analysis

**Purpose:** Analyze the existing contact card/avatar component and design a unified user identity model that works across multiple connectors (SharePoint, Jira, Confluence, Google Drive) where user names and identities may vary.

**Status:** Design exploration
**Created:** 2026-03-05

---

## Table of Contents

1. [Current Implementation](#current-implementation)
2. [User Identity Architecture](#user-identity-architecture)
3. [Multi-Connector Challenges](#multi-connector-challenges)
4. [Proposed Solutions](#proposed-solutions)
5. [Implementation Recommendations](#implementation-recommendations)

---

## Current Implementation

### Avatar Component

**Location:** `apps/studio/src/components/ui/Avatar.tsx`

**Current Features:**

- Displays user profile image or fallback to initials
- Supports 3 sizes: `sm`, `md`, `lg`
- Generates 2-letter initials from display name
- Used in UserMenu, ProfilePanel, and message displays

```typescript
interface AvatarProps {
  src?: string | null; // Profile image URL
  name: string; // Display name for initials
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

// Initials generation
const initials = name
  .split(' ')
  .map((w) => w[0])
  .join('')
  .toUpperCase()
  .slice(0, 2);
```

**Current Usage:**

1. **UserMenu** (`apps/studio/src/components/auth/UserMenu.tsx`)
   - Shows logged-in user's avatar with name and email
   - Uses `user.name || user.email` for display
   - Gets `user.avatarUrl` from auth store

2. **ProfilePanel** (`apps/studio/src/components/auth/ProfilePanel.tsx`)
   - Full profile view with avatar, name, email, user ID, workspace
   - Display fields: `user.name`, `user.email`, `user.id`, `tenantId`

3. **MessageList** (chat interface)
   - Shows avatar for each message author
   - Uses for both user messages and AI responses

**Current Limitations:**

- ✅ Works for platform users (authenticated ABL platform users)
- ❌ Does NOT handle connector-specific user identities
- ❌ No distinction between platform users and document authors
- ❌ No handling of identity variations across connectors

---

## User Identity Architecture

### 1. Platform Users (IUser Model)

**Database:** MongoDB `users` collection
**Location:** `packages/database/src/models/user.model.ts`

```typescript
interface IUser {
  _id: string; // Platform user ID
  email: string; // Primary identity
  name: string | null; // Display name
  avatarUrl: string | null; // Profile picture
  googleId: string | null; // OAuth provider ID
  authProvider: string; // 'google' | 'email' | 'microsoft'
  // ... MFA, login tracking
}
```

**Purpose:** Users who log into the ABL Platform (Studio, Admin)
**Scope:** Platform authentication only
**Does NOT represent:** Document authors from connectors

---

### 2. IdP Users (Neo4j User Nodes)

**Database:** Neo4j Permission Graph
**Location:** `packages/search-ai-internal/src/permissions/types.ts`

```typescript
interface UserNode {
  tenantId: string;
  email: string; // MUST be lowercase, universal key
  idpUserId?: string; // Azure AD object ID, Okta ID, Google ID
  idpProvider?: 'azuread' | 'okta' | 'google';
  displayName?: string; // "Alice Johnson"
  domain: string; // Extracted from email
  status: 'active' | 'suspended' | 'deleted';
  lastSyncAt?: Date;
  createdAt: Date;
}
```

**Purpose:** End-user identities from Identity Providers
**Source:** IdP sync workers (Azure AD, Okta, Google)
**Use Case:** Permission filtering in search queries
**Example:** `alice@contoso.com` synced from Azure AD with displayName "Alice Johnson"

**Key Properties:**

- Email is the **universal identity key** across all systems
- IdP provides authoritative `displayName` and profile information
- Synced daily via BullMQ workers
- Stored in Neo4j for group membership resolution

---

### 3. Connector User Metadata (Document sourceMetadata)

**Database:** MongoDB `SearchDocument.sourceMetadata`
**Location:** Varies by connector

#### SharePoint Example

**Source:** Microsoft Graph API `/drives/{driveId}/items/{itemId}`
**Location:** `packages/connectors/sharepoint/src/client/graph-types.ts`

```typescript
interface DriveItem {
  id: string;
  name: string;
  createdBy?: {
    user?: {
      displayName: string; // "Alice Johnson"
      email: string; // "alice@contoso.com"
    };
  };
  lastModifiedBy?: {
    user?: {
      displayName: string;
      email: string;
    };
  };
}

interface Permission {
  roles: string[];
  grantedToV2?: {
    user?: {
      displayName: string;
      email: string;
      id: string; // Azure AD object ID
    };
  };
}
```

**Stored in SearchDocument:**

```typescript
{
  _id: "doc-123",
  sourceMetadata: {
    sharepoint: {
      createdBy: "Alice Johnson",           // Extracted from API
      lastModifiedBy: "Bob Smith",
      itemId: "...",
      siteId: "...",
      // Raw connector data
    }
  }
}
```

#### Jira Example (Future)

```typescript
interface JiraIssue {
  key: 'PROJ-123';
  fields: {
    creator: {
      accountId: string; // Atlassian account ID
      displayName: string; // "Alice Johnson"
      emailAddress: string; // "alice@contoso.com"
      avatarUrls: {
        '48x48': string; // Profile picture URL
      };
    };
    reporter: {
      /* same structure */
    };
    assignee: {
      /* same structure */
    };
  };
}
```

#### Confluence Example (Future)

```typescript
interface ConfluencePage {
  id: string;
  title: string;
  version: {
    by: {
      publicName: string; // "Alice Johnson"
      email: string; // "alice@contoso.com"
      profilePicture: {
        path: string; // Avatar URL
      };
    };
  };
}
```

---

## Multi-Connector Challenges

### Challenge 1: Identity Variation

**Problem:** Same user may have different identities across connectors

| Connector  | User ID Format       | Display Name Source     | Email Availability |
| ---------- | -------------------- | ----------------------- | ------------------ |
| SharePoint | Azure AD Object ID   | Azure AD displayName    | ✅ Always          |
| Jira       | Atlassian Account ID | Jira profile name       | ✅ Always          |
| Confluence | Atlassian Account ID | Confluence display name | ✅ Always          |
| Google     | Google Account ID    | Google Workspace name   | ✅ Always          |
| Slack      | Slack User ID        | Slack display name      | ⚠️ Optional        |
| GitHub     | GitHub Username      | GitHub profile name     | ❌ Hidden          |

**Example Scenario:**

- Alice Johnson (`alice@contoso.com`) in Azure AD
- Alice J. (`alice.johnson@contoso.com`) in Jira (different email!)
- Alice (`alice@contoso.com`) in Confluence
- No profile picture in SharePoint, has avatar in Jira

**Current State:** ❌ No identity resolution across connectors

---

### Challenge 2: Display Name Inconsistency

**Problem:** Same person may use different display names

- SharePoint: "Alice Johnson" (formal, from HR system)
- Jira: "Alice J." (casual, self-set)
- Confluence: "alice.johnson" (username-based)
- Slack: "Alice 🚀" (with emoji)

**Current State:** ❌ No canonicalization of display names

---

### Challenge 3: Avatar/Profile Picture

**Problem:** Profile pictures vary by system

- SharePoint: Uses Azure AD profile picture (centrally managed)
- Jira: Uses Atlassian Gravatar or custom upload
- Confluence: Same as Jira (shared Atlassian account)
- Google: Uses Google Workspace profile picture
- Slack: Custom uploaded avatar

**Current State:** ❌ No avatar aggregation or preference order

---

### Challenge 4: Email as Identity Key

**Problem:** Email normalization and matching

- Email case sensitivity: `Alice@Contoso.com` vs `alice@contoso.com`
- Email aliases: `alice@contoso.com` vs `alice.johnson@contoso.com`
- Shared mailboxes: `support@contoso.com` (not a person)
- Service accounts: `no-reply@contoso.com`

**Current State:** ✅ Partially solved (Neo4j UserNode normalizes email to lowercase)

---

### Challenge 5: User Context in UI

**Problem:** Where to display user identity information?

**Use Cases:**

1. **Search Results** — Show document author
   - "Created by Alice Johnson (SharePoint)"
   - "Last modified by Bob Smith (2024-02-15)"

2. **Document Detail View** — Show full authorship history
   - Created by: Alice Johnson (alice@contoso.com)
   - Last modified by: Bob Smith (bob@contoso.com)
   - Contributors: Charlie, David, Eve

3. **Permission View** — Show who has access
   - Direct users: Alice Johnson, Bob Smith
   - Group members: Engineering Team (15 members)

4. **Chat Context** — Show RAG citation authors
   - "According to the Q1 Report by Alice Johnson..."

**Current State:** ❌ No standardized user display component for search results

---

## Proposed Solutions

### Solution 1: Unified User Identity Service

**Concept:** Resolve connector-specific identities to canonical user profiles

**Architecture:**

```typescript
/**
 * Unified User Profile
 *
 * Aggregates identity information from multiple sources:
 * - IdP (Azure AD, Okta, Google) — authoritative for display name, email
 * - Connectors (SharePoint, Jira, Confluence) — document authorship
 * - Platform (ABL User model) — login credentials
 */
interface UnifiedUserProfile {
  // Canonical identity
  email: string; // Primary key (lowercase)
  displayName: string; // Preferred display name
  preferredSource: 'idp' | 'connector' | 'platform';

  // Identity sources
  idp?: {
    provider: 'azuread' | 'okta' | 'google';
    idpUserId: string;
    displayName: string;
    email: string;
    lastSyncAt: Date;
  };

  connectorIdentities?: Array<{
    source: 'sharepoint' | 'jira' | 'confluence' | 'google';
    userId: string; // Connector-specific ID
    displayName: string; // As it appears in that connector
    email?: string; // May differ from canonical email
    avatarUrl?: string;
    lastSeenAt: Date;
  }>;

  platformUser?: {
    userId: string; // IUser._id
    authProvider: string;
    avatarUrl?: string;
  };

  // Aggregated metadata
  avatarUrl: string | null; // Best available avatar (order: idp > platform > connector)
  domain: string; // Extracted from email
  status: 'active' | 'suspended' | 'deleted';

  // Tracking
  createdAt: Date;
  updatedAt: Date;
}
```

**Resolution Order:**

1. **IdP** (highest priority) — Authoritative source for enterprise users
2. **Platform** — For ABL platform users without IdP
3. **Connector** (lowest priority) — Fallback for external collaborators

---

### Solution 2: Enhanced Avatar Component

**Concept:** Extend Avatar to show user context (connector source, role)

```typescript
interface ContactCardProps {
  // Identity (required)
  email: string; // Canonical identity key
  displayName: string;

  // Avatar
  avatarUrl?: string | null;
  fallbackInitials?: string; // Override initials (e.g., "AJ")

  // Context (optional)
  source?: 'idp' | 'sharepoint' | 'jira' | 'confluence' | 'google';
  role?: 'owner' | 'editor' | 'viewer' | 'author';

  // Metadata (optional)
  lastModified?: Date;
  connectorSpecificId?: string; // For debugging

  // Display options
  size?: 'sm' | 'md' | 'lg';
  showEmail?: boolean;
  showSource?: boolean; // Show badge like "SharePoint"
  showTooltip?: boolean;
  onClick?: () => void; // Open full profile
}

export function ContactCard(props: ContactCardProps) {
  // Render avatar with optional source badge
  // On hover: Show tooltip with full email, source, role
  // On click: Open UnifiedUserProfile panel
}
```

**Usage Examples:**

```tsx
// Search result author
<ContactCard
  email="alice@contoso.com"
  displayName="Alice Johnson"
  avatarUrl="https://graph.microsoft.com/..."
  source="sharepoint"
  role="owner"
  showSource={true}
/>

// Document contributors
<ContactCard
  email="bob@contoso.com"
  displayName="Bob Smith"
  source="jira"
  role="editor"
  lastModified={new Date('2024-02-15')}
/>

// Permission list
<ContactCard
  email="charlie@contoso.com"
  displayName="Charlie Davis"
  source="idp"
  role="viewer"
  showEmail={true}
/>
```

---

### Solution 3: Identity Resolution Cache

**Concept:** Cache resolved identities to avoid repeated lookups

**Storage:** Redis

```typescript
// Cache key: `user-profile:${tenantId}:${email}`
// TTL: 5 minutes (matches IdP group cache)

interface CachedUserProfile {
  email: string;
  displayName: string;
  avatarUrl: string | null;
  source: 'idp' | 'platform' | 'sharepoint' | 'jira';
  cachedAt: number; // Unix timestamp
}

// Usage
const profile = await getUserProfile(tenantId, 'alice@contoso.com');
// First call: Fetches from Neo4j + MongoDB (50-100ms)
// Subsequent calls: Returns from Redis (<5ms)
```

**Cache Invalidation:**

- On IdP sync completion
- On connector sync completion
- Manual invalidation via API

---

### Solution 4: Fallback Chain for Avatars

**Problem:** Not all connectors provide avatars

**Solution:** Implement avatar preference order

```typescript
async function resolveAvatarUrl(tenantId: string, email: string): Promise<string | null> {
  // Priority 1: IdP avatar (Azure AD, Okta, Google)
  const idpUser = await getIdpUser(tenantId, email);
  if (idpUser?.avatarUrl) return idpUser.avatarUrl;

  // Priority 2: Platform user avatar
  const platformUser = await getPlatformUserByEmail(email);
  if (platformUser?.avatarUrl) return platformUser.avatarUrl;

  // Priority 3: Connector avatars (in order of recency)
  const connectorAvatars = await getConnectorAvatars(tenantId, email);
  if (connectorAvatars.length > 0) {
    return connectorAvatars[0].avatarUrl; // Most recent
  }

  // Priority 4: Gravatar (if email is available)
  const gravatarUrl = getGravatarUrl(email);
  if (await checkImageExists(gravatarUrl)) {
    return gravatarUrl;
  }

  // Fallback: null (show initials)
  return null;
}

function getGravatarUrl(email: string): string {
  const hash = md5(email.toLowerCase().trim());
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=200`;
}
```

---

### Solution 5: Document Metadata Enrichment

**Concept:** Enrich `SearchDocument.sourceMetadata` with resolved user profiles

**Current State:**

```typescript
{
  _id: "doc-123",
  sourceMetadata: {
    sharepoint: {
      createdBy: "Alice Johnson",     // String only
      lastModifiedBy: "Bob Smith",
    }
  }
}
```

**Enhanced:**

```typescript
{
  _id: "doc-123",
  sourceMetadata: {
    sharepoint: {
      // Raw connector data (preserved)
      createdBy: "Alice Johnson",
      lastModifiedBy: "Bob Smith",
    }
  },

  // NEW: Enriched user references
  authors: {
    creator: {
      email: "alice@contoso.com",     // Resolved from connector
      displayName: "Alice Johnson",
      avatarUrl: "https://...",
      source: "sharepoint",
      connectorUserId: "00000000-...", // Azure AD object ID
    },
    lastModifiedBy: {
      email: "bob@contoso.com",
      displayName: "Bob Smith",
      avatarUrl: null,
      source: "sharepoint",
      connectorUserId: "11111111-...",
    },
  },
}
```

**Benefits:**

- Standardized user references across all connectors
- Enables contact card rendering without additional lookups
- Supports identity resolution and avatar aggregation

---

## Implementation Recommendations

### Phase 1: Foundation (Immediate)

**1.1 Create UnifiedUserProfile Service**

- Location: `packages/search-ai-internal/src/identity/unified-user-service.ts`
- Responsibilities:
  - Fetch user from Neo4j (IdP users)
  - Fetch user from MongoDB (platform users)
  - Aggregate connector identities
  - Cache results in Redis

**1.2 Enhance ContactCard Component**

- Location: `apps/studio/src/components/ui/ContactCard.tsx`
- New props: `source`, `role`, `showSource`, `showTooltip`
- Tooltip with full email, source, last seen date
- Optional badge for connector source

**1.3 Add Avatar Resolution Service**

- Location: `packages/search-ai-internal/src/identity/avatar-resolver.ts`
- Implement fallback chain: IdP → Platform → Connector → Gravatar
- Cache avatar URLs in Redis (1-hour TTL)

---

### Phase 2: Document Enrichment (Next Sprint)

**2.1 Add User Reference Enrichment to Workers**

- Modify `full-sync-coordinator.ts` in each connector
- Extract user email from connector API responses
- Store enriched user references in `SearchDocument.authors`

**2.2 Update SearchDocument Schema**

```typescript
interface ISearchDocument {
  // ... existing fields
  authors?: {
    creator?: IUserReference;
    lastModifiedBy?: IUserReference;
    contributors?: IUserReference[];
  };
}

interface IUserReference {
  email: string;
  displayName: string;
  avatarUrl?: string;
  source: 'sharepoint' | 'jira' | 'confluence' | 'idp';
  connectorUserId?: string;
  role?: 'owner' | 'editor' | 'viewer';
}
```

**2.3 Backfill Existing Documents**

- BullMQ job to enrich existing `SearchDocument` records
- Extract user emails from `sourceMetadata`
- Resolve and cache user profiles

---

### Phase 3: Identity Resolution (Future)

**3.1 Cross-Connector Identity Matching**

- Machine learning model to match users across connectors
- Features: email similarity, display name similarity, temporal patterns
- Manual confirmation UI for ambiguous matches

**3.2 Identity Aliases Table**

```typescript
interface IIdentityAlias {
  tenantId: string;
  canonicalEmail: string; // Primary identity
  aliases: Array<{
    email: string;
    source: 'sharepoint' | 'jira' | 'confluence';
    confidence: number; // ML confidence score
    verifiedBy?: string; // Admin user ID if manually verified
    verifiedAt?: Date;
  }>;
}
```

**3.3 Admin UI for Identity Management**

- View all identities for a user
- Merge duplicate profiles
- Set preferred display name and avatar

---

### Phase 4: Advanced Features (Long-term)

**4.1 User Activity Timeline**

- Show all documents created/modified by user across connectors
- Permission changes history
- Search queries (if audit logging enabled)

**4.2 Organization Chart Integration**

- Integrate with IdP org chart (Azure AD, Okta)
- Show reporting structure in contact card tooltip
- "Find documents by my manager's team"

**4.3 User Presence Integration**

- Integrate with Microsoft Teams, Slack presence API
- Show online/offline status in contact card
- "Available", "Busy", "Away" indicators

---

## Migration Strategy

### Backward Compatibility

**Existing Avatar Component:** Keep for platform users only
**New ContactCard Component:** Use for document authorship

**Gradual Migration:**

1. Phase 1: Add ContactCard alongside existing Avatar
2. Phase 2: Migrate search results to ContactCard
3. Phase 3: Migrate permission views to ContactCard
4. Phase 4: Deprecate Avatar, rename ContactCard → Avatar (breaking change)

---

## Open Questions

### Q1: Should we store unified profiles in MongoDB or Neo4j?

**Option A: MongoDB (recommended)**

- Pros: Easier to query, fits existing patterns
- Cons: Duplicate data with Neo4j UserNode

**Option B: Neo4j only**

- Pros: Single source of truth
- Cons: Slower queries for UI rendering

**Recommendation:** MongoDB for unified profiles, Neo4j for permission graph

---

### Q2: How to handle users without email addresses?

**Example:** Confluence anonymous users, Slack bots, service accounts

**Proposed Solution:**

- Generate synthetic IDs: `anonymous:confluence:123`, `bot:slack:456`
- Display name: "Anonymous User", "Slackbot"
- No avatar, no email

---

### Q3: Should we sync user avatars to our storage?

**Pros:**

- Faster loading (no external API calls)
- Works if IdP/connector is down
- Consistent image sizing

**Cons:**

- Storage cost (100KB × 10,000 users = 1GB)
- Staleness (user changes avatar, we show old one)
- Privacy concerns (storing user photos)

**Recommendation:**

- DO NOT store IdP avatars (use direct URLs)
- DO store connector avatars if they require authentication
- Cache avatar URLs in Redis with 1-hour TTL

---

## Summary

### Current State

- ✅ Avatar component works for platform users
- ✅ Neo4j stores IdP user identities
- ❌ No unified user model across connectors
- ❌ No standard way to display document authors
- ❌ No avatar aggregation

### Recommended Next Steps

1. **Immediate (This Sprint):**
   - Create ContactCard component with source badges
   - Implement UnifiedUserProfile service
   - Add Redis caching for user profiles

2. **Next Sprint:**
   - Enrich SearchDocument with user references
   - Update search results UI to use ContactCard
   - Add avatar resolution with fallback chain

3. **Future:**
   - Identity resolution across connectors
   - Admin UI for identity management
   - Advanced features (presence, org chart)

### Key Design Decisions

1. **Email as canonical identity** — Universal key across all systems
2. **IdP as authoritative source** — Preferred for display name and avatar
3. **Redis caching** — 5-minute TTL for user profiles
4. **Backward compatible** — Keep existing Avatar for platform users

---

## Related Documentation

- **Neo4j Permission Schema:** `packages/search-ai-internal/src/permissions/neo4j-permission-schema.md`
- **IdP Authentication API:** `docs/searchai/IDP-AUTHENTICATION-API.md`
- **SharePoint Connector Deep Dive:** `docs/SHAREPOINT-CONNECTOR-DEEP-DIVE.md`
- **User Model:** `packages/database/src/models/user.model.ts`

---

**Document Version:** 1.0
**Last Updated:** 2026-03-05
**Author:** ABL Platform Team
