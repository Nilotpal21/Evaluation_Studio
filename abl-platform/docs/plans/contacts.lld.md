# Contacts Management -- Low-Level Design

## Task T-1: Contact Model

### Files

- `packages/database/src/models/contact.model.ts` -- Mongoose model with encrypted identities

### Key Types

- `IContact`: Full document interface with `identities[]`, `channelHistory[]`, `contactContext`, legacy flat fields
- `IContactIdentity`: `{ type, encryptedValue, blindIndex, verified, verifiedAt, verifiedVia, channel }`
- `IChannelHistoryEntry`: `{ channelType, channelId, firstSessionAt, lastSessionAt, sessionCount }`
- Contact types: `'employee' | 'customer' | 'anonymous'`
- Identity types: `'email' | 'phone' | 'external'`

### Design Notes

- `_id` uses UUIDv7
- `tenantIsolationPlugin` enforces tenant scoping at query level
- Indexes: `{tenantId, identityType, identity}`, `{tenantId, type}`, `{tenantId, lastSeenAt}`, `{tenantId, deletedAt}`, `{tenantId, identities.blindIndex}`, `{tenantId, mergedInto}`
- `contactContext` validated at 64KB max via custom Mongoose validator

---

## Task T-2: Contact CRUD Routes

### Files

- `apps/runtime/src/routes/contacts.ts` -- CRUD + history at `/api/contacts`
- `apps/runtime/src/validation/contact-validation.ts` -- Manual validation (email regex, phone regex, field lengths)

### Key Endpoints

- `POST /` -- Create. Zod parse for defaults, manual validation, audit
- `GET /` -- Query with type, channel, limit (max 1000), offset validation
- `GET /lookup` -- Find by identityType + identity query params
- `GET /:id` -- Get by ID with tenantId
- `PUT /:id` -- Update with validation, audit diff
- `DELETE /:id` -- Soft-delete, unlink from sessions, audit
- `POST /:id/link-session` -- Link to session, touch lastSeen, audit
- `GET /:id/history` -- Cross-session messages, cursor pagination, anonymous 404

### Design Notes

- Auth: `authMiddleware` + `tenantRateLimit` (no project scope -- tenant-wide)
- Permission: `agent:execute` (reusing existing permission)
- History: cursor-based on ISO timestamp, uses `{ tenantId, contactId, timestamp }` compound index
- History page size: default 50, max 200

---

## Task T-3: Contact Merge Routes

### Files

- `apps/runtime/src/routes/contact-merge.ts` -- Factory `createContactMergeRouter(deps)`

### Key Endpoints

- `POST /merge` -- Admin merge (primaryContactId absorbs secondaryContactId)
- `POST /:id/self-merge` -- SDK self-merge (identityType + identityValue)
- `DELETE /:id/gdpr` -- GDPR cascade hard-delete

### Design Notes

- Factory pattern with injected use cases: `executeMerge`, `selfMerge`, `cascadeDelete`
- Auth: tenantContext presence check (no RBAC granularity -- GAP)
- Uses `console.error` instead of `createLogger` (GAP)

---

## Task T-4: Contact Context Service

### Files

- `apps/runtime/src/services/contact-context-service.ts`

### Key Signatures

- `getContext(tenantId, contactId) -> Promise<ContactContext | null>` -- Redis first, DB fallback
- `updateContext(tenantId, contactId, context) -> Promise<void>` -- Write-through to both

### Design Notes

- Redis key: `contact-ctx:{tenantId}:{contactId}`
- TTL: 5 minutes (`EX 300`)
- Fail-open: Redis errors result in cache miss, never blocked request
- `ContactContextRepo` port interface for dependency injection (avoids direct Mongoose dependency)

---

## Known Gaps

- Contact merge routes have no test coverage
- Cross-session history endpoint has no test coverage
- `console.error` usage in merge routes
- No encrypted identity round-trip test
- Legacy flat identity fields will eventually need migration
