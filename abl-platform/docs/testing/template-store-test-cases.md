# Template Store - Comprehensive Test Cases

**Feature**: [Template Store](../features/template-store.md)
**Test Spec**: [template-store.md](./template-store.md)
**Status**: BETA
**Last Updated**: 2026-05-14

---

## Test Case Legend

| Field                  | Description                                        |
| ---------------------- | -------------------------------------------------- |
| TC-ID                  | Unique identifier (TC-TS-NNN)                      |
| Category               | positive / negative / boundary / integration / e2e |
| Functional Requirement | Which FR (FR-1 through FR-34) the test covers      |
| Description            | What the test verifies                             |
| Preconditions          | Setup needed before execution                      |
| Steps                  | Numbered execution steps                           |
| Expected Result        | Observable outcome                                 |
| Automation             | API / UI / Manual                                  |
| Phase                  | 1 (existing) or 2 (new)                            |

---

## 1. Positive (Happy Path) Test Cases

### TC-TS-001: Browse templates returns paginated listing

| Field                  | Value                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-001                                                                                                                                                                                                                                                                          |
| Category               | positive                                                                                                                                                                                                                                                                           |
| Functional Requirement | FR-1                                                                                                                                                                                                                                                                               |
| Description            | Verify the public browse API returns paginated template listings without authentication                                                                                                                                                                                            |
| Preconditions          | Template store service running. 25 published, public templates seeded in MongoDB.                                                                                                                                                                                                  |
| Steps                  | 1. Send `GET /api/v1/marketplace/templates?page=1&limit=10` without any auth headers. 2. Inspect response status and body. 3. Send `GET /api/v1/marketplace/templates?page=3&limit=10`.                                                                                            |
| Expected Result        | Step 2: HTTP 200 with `{ success: true, data: [...10 items], pagination: { total: 25, page: 1, limit: 10, hasMore: true } }`. Each item contains `slug`, `name`, `type`, `category`, `complexity`, `shortDescription`, `typeMetadata`. Step 3: 5 items returned, `hasMore: false`. |
| Automation             | API                                                                                                                                                                                                                                                                                |

### TC-TS-002: Filter templates by type

| Field                  | Value                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-002                                                                                                                                                                                                       |
| Category               | positive                                                                                                                                                                                                        |
| Functional Requirement | FR-2                                                                                                                                                                                                            |
| Description            | Verify filtering by template type returns only matching templates                                                                                                                                               |
| Preconditions          | 5 agent templates and 3 project templates seeded, all published and public.                                                                                                                                     |
| Steps                  | 1. `GET /api/v1/marketplace/templates?type=agent`. 2. Verify all returned items have `type: "agent"`. 3. `GET /api/v1/marketplace/templates?type=project`. 4. Verify all returned items have `type: "project"`. |
| Expected Result        | Step 2: 5 templates returned, all with `type: "agent"`. Step 4: 3 templates returned, all with `type: "project"`.                                                                                               |
| Automation             | API                                                                                                                                                                                                             |

### TC-TS-003: Filter templates by category

| Field                  | Value                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-003                                                                                                           |
| Category               | positive                                                                                                            |
| Functional Requirement | FR-2                                                                                                                |
| Description            | Verify filtering by category returns only templates in that category                                                |
| Preconditions          | Templates seeded across categories: customer-service (5), sales (3), hr (2).                                        |
| Steps                  | 1. `GET /api/v1/marketplace/templates?category=customer-service`. 2. Verify count and all items match the category. |
| Expected Result        | 5 templates returned, all with `category: "customer-service"`.                                                      |
| Automation             | API                                                                                                                 |

### TC-TS-004: Filter templates by complexity

| Field                  | Value                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-004                                                                     |
| Category               | positive                                                                      |
| Functional Requirement | FR-2                                                                          |
| Description            | Verify filtering by complexity level returns only matching templates          |
| Preconditions          | Templates seeded: 4 starter, 3 standard, 3 advanced.                          |
| Steps                  | 1. `GET /api/v1/marketplace/templates?complexity=starter`. 2. Verify results. |
| Expected Result        | 4 templates returned, all with `complexity: "starter"`.                       |
| Automation             | API                                                                           |

### TC-TS-005: Free-text search across name, description, and tags

| Field                  | Value                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-005                                                                                                                                                                        |
| Category               | positive                                                                                                                                                                         |
| Functional Requirement | FR-2                                                                                                                                                                             |
| Description            | Verify free-text search matches templates by name, description, and tags                                                                                                         |
| Preconditions          | Templates seeded: "Customer Service Bot" (tags: ["support", "helpdesk"]), "Sales Pipeline Agent" (tags: ["crm"]), "HR Onboarding Project" (shortDescription contains "support"). |
| Steps                  | 1. `GET /api/v1/marketplace/templates?q=support`. 2. Inspect results.                                                                                                            |
| Expected Result        | Returns "Customer Service Bot" (tag match) and "HR Onboarding Project" (description match). "Sales Pipeline Agent" is not returned.                                              |
| Automation             | API                                                                                                                                                                              |

### TC-TS-006: Combined filters return intersection

| Field                  | Value                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-006                                                                                                           |
| Category               | positive                                                                                                            |
| Functional Requirement | FR-2                                                                                                                |
| Description            | Verify multiple filters applied together return the intersection of all criteria                                    |
| Preconditions          | Templates: 3 agent/customer-service/starter, 2 agent/hr/advanced, 1 project/customer-service/starter.               |
| Steps                  | 1. `GET /api/v1/marketplace/templates?type=agent&category=customer-service&complexity=starter`. 2. Verify results.  |
| Expected Result        | 3 templates returned (only agent + customer-service + starter). The project template and hr templates are excluded. |
| Automation             | API                                                                                                                 |

### TC-TS-007: Template detail by slug returns full data

| Field                  | Value                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-007                                                                                                                                                                                                                                                                                                            |
| Category               | positive                                                                                                                                                                                                                                                                                                             |
| Functional Requirement | FR-3                                                                                                                                                                                                                                                                                                                 |
| Description            | Verify template detail endpoint returns complete template data including all required fields                                                                                                                                                                                                                         |
| Preconditions          | One published template seeded with slug `test-bot`, full data including media (images and videos), demoConversation, detailSections, typeMetadata, and publisherName.                                                                                                                                                |
| Steps                  | 1. `GET /api/v1/marketplace/templates/test-bot`. 2. Inspect response body for all required fields.                                                                                                                                                                                                                   |
| Expected Result        | HTTP 200 with `{ success: true, data: { slug, name, longDescription, media, demoConversation, typeMetadata, detailSections, publisherName, publisherVerified, category, complexity, type, viewCount, installCount, ratingAverage, ratingCount } }`. All fields are populated. `detailSections` is a non-empty array. |
| Automation             | API                                                                                                                                                                                                                                                                                                                  |

### TC-TS-008: Categories endpoint returns names with counts

| Field                  | Value                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-008                                                                                                                                     |
| Category               | positive                                                                                                                                      |
| Functional Requirement | FR-4                                                                                                                                          |
| Description            | Verify the categories endpoint returns all categories with correct template counts                                                            |
| Preconditions          | Templates seeded across 4 categories: customer-service (5), sales (3), hr (2), productivity (1).                                              |
| Steps                  | 1. `GET /api/v1/marketplace/categories`. 2. Inspect response body.                                                                            |
| Expected Result        | HTTP 200. Response contains 4 categories with names and counts: `{ name: "customer-service", count: 5 }`, `{ name: "sales", count: 3 }`, etc. |
| Automation             | API                                                                                                                                           |

### TC-TS-009: Featured endpoint returns templates ordered by featuredOrder

| Field                  | Value                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-009                                                                                                            |
| Category               | positive                                                                                                             |
| Functional Requirement | FR-5                                                                                                                 |
| Description            | Verify the featured endpoint returns templates sorted by featuredOrder ascending                                     |
| Preconditions          | 3 templates with `featuredOrder`: A (order=3), B (order=1), C (order=2). 5 templates with `featuredOrder: null`.     |
| Steps                  | 1. `GET /api/v1/marketplace/featured`. 2. Inspect order and count.                                                   |
| Expected Result        | HTTP 200. Returns exactly 3 templates in order: B (1), C (2), A (3). Templates without `featuredOrder` are excluded. |
| Automation             | API                                                                                                                  |

### TC-TS-010: View count increments on detail view

| Field                  | Value                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-010                                                                                                                                                           |
| Category               | positive                                                                                                                                                            |
| Functional Requirement | FR-6                                                                                                                                                                |
| Description            | Verify that viewing a template detail page increments the viewCount atomically                                                                                      |
| Preconditions          | Template seeded with slug `counter-test`, initial `viewCount: 0`.                                                                                                   |
| Steps                  | 1. `GET /api/v1/marketplace/templates/counter-test`. 2. Note viewCount in response. 3. `GET /api/v1/marketplace/templates/counter-test` again. 4. Note viewCount.   |
| Expected Result        | Step 2: `viewCount` is 1 (or 0 if returned before increment -- verify via second call). Step 4: `viewCount` is 2. Each detail view atomically increments the count. |
| Automation             | API                                                                                                                                                                 |

### TC-TS-011: Analytics events recorded for detail view

| Field                  | Value                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-011                                                                                                                                                                               |
| Category               | positive                                                                                                                                                                                |
| Functional Requirement | FR-7                                                                                                                                                                                    |
| Description            | Verify that a `detail_view` analytics event is created when a template detail is viewed                                                                                                 |
| Preconditions          | Template seeded with slug `analytics-test`. Analytics events collection empty or baseline count known.                                                                                  |
| Steps                  | 1. `GET /api/v1/marketplace/templates/analytics-test`. 2. Query `template_analytics_events` collection for events with `templateSlug: "analytics-test"` and `eventType: "detail_view"`. |
| Expected Result        | One `detail_view` event exists with `templateSlug: "analytics-test"`, `createdAt` within last few seconds, and `templateId` matching the template's `_id`.                              |
| Automation             | API                                                                                                                                                                                     |

### TC-TS-012: Analytics events recorded for search

| Field                  | Value                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-012                                                                                                                                       |
| Category               | positive                                                                                                                                        |
| Functional Requirement | FR-7                                                                                                                                            |
| Description            | Verify that a `search` analytics event is recorded when a user performs a search query                                                          |
| Preconditions          | Template store running with seed data.                                                                                                          |
| Steps                  | 1. `GET /api/v1/marketplace/templates?q=customer`. 2. Query `template_analytics_events` for events with `eventType: "search"`.                  |
| Expected Result        | One `search` event recorded with `metadata` containing the query term `"customer"`. `userId` and `tenantId` are null (unauthenticated request). |
| Automation             | API                                                                                                                                             |

### TC-TS-013: Request ID header present on all responses

| Field                  | Value                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-013                                                                                                                                                                                                   |
| Category               | positive                                                                                                                                                                                                    |
| Functional Requirement | FR-9                                                                                                                                                                                                        |
| Description            | Verify that every API response includes an `x-request-id` header                                                                                                                                            |
| Preconditions          | Template store running.                                                                                                                                                                                     |
| Steps                  | 1. `GET /api/v1/marketplace/templates`. 2. Check response headers for `x-request-id`. 3. `GET /api/v1/marketplace/categories`. 4. Check response headers. 5. `GET /nonexistent`. 6. Check response headers. |
| Expected Result        | All three responses include `x-request-id` header with a non-empty UUID-like value. Each response has a different request ID.                                                                               |
| Automation             | API                                                                                                                                                                                                         |

### TC-TS-014: Standard error format on all error responses

| Field                  | Value                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-014                                                                                                                                                 |
| Category               | positive                                                                                                                                                  |
| Functional Requirement | FR-10                                                                                                                                                     |
| Description            | Verify that error responses follow the standard format `{ success: false, error: { code, message } }`                                                     |
| Preconditions          | Template store running.                                                                                                                                   |
| Steps                  | 1. `GET /api/v1/marketplace/templates/nonexistent-slug` (404). 2. `GET /api/v1/marketplace/templates?page=-1` (400). 3. Inspect both responses.           |
| Expected Result        | Both responses have format `{ success: false, error: { code: "<ERROR_CODE>", message: "<human readable>" } }`. Status codes are 404 and 400 respectively. |
| Automation             | API                                                                                                                                                       |

### TC-TS-015: Health and readiness endpoints

| Field                  | Value                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-015                                                                            |
| Category               | positive                                                                             |
| Functional Requirement | FR-1 (service availability)                                                          |
| Description            | Verify health and readiness probes return correct status when the service is healthy |
| Preconditions          | Template store running, connected to MongoDB.                                        |
| Steps                  | 1. `GET /health`. 2. `GET /ready`.                                                   |
| Expected Result        | Both return HTTP 200 with a body indicating healthy/ready status.                    |
| Automation             | API                                                                                  |

---

## 2. Negative (Error Cases) Test Cases

### TC-TS-016: Template detail for nonexistent slug returns 404

| Field                  | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-016                                                                               |
| Category               | negative                                                                                |
| Functional Requirement | FR-3, FR-10                                                                             |
| Description            | Verify requesting a template by a nonexistent slug returns 404 in standard error format |
| Preconditions          | Template store running. No template with slug `does-not-exist`.                         |
| Steps                  | 1. `GET /api/v1/marketplace/templates/does-not-exist`.                                  |
| Expected Result        | HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "..." } }`.       |
| Automation             | API                                                                                     |

### TC-TS-017: Rate limiting returns 429 on excess requests

| Field                  | Value                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-017                                                                                                                                                                           |
| Category               | negative                                                                                                                                                                            |
| Functional Requirement | FR-8, FR-10                                                                                                                                                                         |
| Description            | Verify that exceeding the rate limit returns HTTP 429 in standard error format                                                                                                      |
| Preconditions          | Template store running with test rate limit config: 5 requests per 1-second window.                                                                                                 |
| Steps                  | 1. Send 5 rapid `GET /api/v1/marketplace/templates` requests from same IP. 2. Send a 6th request immediately. 3. Wait for the rate limit window to expire. 4. Send another request. |
| Expected Result        | Steps 1: All return HTTP 200. Step 2: HTTP 429 with `{ success: false, error: { code: "RATE_LIMIT_EXCEEDED", message: "..." } }`. Step 4: HTTP 200 (window reset).                  |
| Automation             | API                                                                                                                                                                                 |

### TC-TS-018: Invalid pagination parameter returns 400

| Field                  | Value                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-018                                                                                                                                                                                        |
| Category               | negative                                                                                                                                                                                         |
| Functional Requirement | FR-1, FR-10                                                                                                                                                                                      |
| Description            | Verify that invalid pagination parameters return 400 with standard error format                                                                                                                  |
| Preconditions          | Template store running.                                                                                                                                                                          |
| Steps                  | 1. `GET /api/v1/marketplace/templates?page=-1`. 2. `GET /api/v1/marketplace/templates?page=0`. 3. `GET /api/v1/marketplace/templates?limit=-5`. 4. `GET /api/v1/marketplace/templates?page=abc`. |
| Expected Result        | All return HTTP 400 with `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }`.                                                                                              |
| Automation             | API                                                                                                                                                                                              |

### TC-TS-019: Invalid filter values return 400

| Field                  | Value                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-019                                                                                                                          |
| Category               | negative                                                                                                                           |
| Functional Requirement | FR-2, FR-10                                                                                                                        |
| Description            | Verify that invalid filter values (e.g., unknown type, unknown complexity) are rejected                                            |
| Preconditions          | Template store running.                                                                                                            |
| Steps                  | 1. `GET /api/v1/marketplace/templates?type=unknown`. 2. `GET /api/v1/marketplace/templates?complexity=expert`.                     |
| Expected Result        | Both return HTTP 400 with `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }` indicating invalid enum value. |
| Automation             | API                                                                                                                                |

### TC-TS-020: Unknown route returns 404 in standard error format

| Field                  | Value                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-020                                                                                         |
| Category               | negative                                                                                          |
| Functional Requirement | FR-10                                                                                             |
| Description            | Verify that requests to undefined routes return 404 in standard format (not Express default HTML) |
| Preconditions          | Template store running.                                                                           |
| Steps                  | 1. `GET /api/v1/marketplace/nonexistent-endpoint`. 2. `GET /completely/wrong/path`.               |
| Expected Result        | Both return HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "..." } }`.     |
| Automation             | API                                                                                               |

### TC-TS-021: Draft templates not visible in browse results

| Field                  | Value                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-021                                                                                                                                                          |
| Category               | negative                                                                                                                                                           |
| Functional Requirement | FR-1                                                                                                                                                               |
| Description            | Verify that templates with `status: "draft"` are excluded from browse and search results                                                                           |
| Preconditions          | Seed 3 published templates and 2 draft templates.                                                                                                                  |
| Steps                  | 1. `GET /api/v1/marketplace/templates`. 2. Verify no draft templates appear. 3. `GET /api/v1/marketplace/templates?q=<draft template name>`. 4. Verify no results. |
| Expected Result        | Only 3 published templates returned. Draft templates are invisible even when searched by name.                                                                     |
| Automation             | API                                                                                                                                                                |

### TC-TS-022: Archived templates not visible in browse results

| Field                  | Value                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-022                                                                                                               |
| Category               | negative                                                                                                                |
| Functional Requirement | FR-1                                                                                                                    |
| Description            | Verify that templates with `status: "archived"` are excluded from browse, search, categories, and featured results      |
| Preconditions          | Seed 3 published templates and 1 archived template (with `featuredOrder` set).                                          |
| Steps                  | 1. `GET /api/v1/marketplace/templates`. 2. `GET /api/v1/marketplace/featured`. 3. `GET /api/v1/marketplace/categories`. |
| Expected Result        | Archived template absent from all results. Category counts do not include the archived template.                        |
| Automation             | API                                                                                                                     |

### TC-TS-023: Non-public visibility templates not visible in browse

| Field                  | Value                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-023                                                                                             |
| Category               | negative                                                                                              |
| Functional Requirement | FR-1                                                                                                  |
| Description            | Verify that templates with visibility other than `"public"` are not returned by the public browse API |
| Preconditions          | Seed templates: 2 public/published, 1 unlisted/published, 1 team-scoped/published.                    |
| Steps                  | 1. `GET /api/v1/marketplace/templates`.                                                               |
| Expected Result        | Only 2 public templates returned. Unlisted and team-scoped templates excluded.                        |
| Automation             | API                                                                                                   |

---

## 3. Boundary (Limits, Edge Cases) Test Cases

### TC-TS-024: Pagination limit at maximum (100 items)

| Field                  | Value                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-024                                                                                                                                    |
| Category               | boundary                                                                                                                                     |
| Functional Requirement | FR-1                                                                                                                                         |
| Description            | Verify that requesting the maximum allowed page size (100) works and exceeding it is clamped or rejected                                     |
| Preconditions          | 150 published templates seeded.                                                                                                              |
| Steps                  | 1. `GET /api/v1/marketplace/templates?limit=100`. 2. `GET /api/v1/marketplace/templates?limit=200`.                                          |
| Expected Result        | Step 1: Returns 100 items with `hasMore: true`. Step 2: Either clamped to 100 items (200 rejected silently) or returns 400 validation error. |
| Automation             | API                                                                                                                                          |

### TC-TS-025: Pagination with zero results

| Field                  | Value                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-025                                                                                       |
| Category               | boundary                                                                                        |
| Functional Requirement | FR-1, FR-2                                                                                      |
| Description            | Verify that queries returning no results produce a valid empty response (not an error)          |
| Preconditions          | Template store running with seed data. No templates in category `nonexistent-category`.         |
| Steps                  | 1. `GET /api/v1/marketplace/templates?category=nonexistent-category`.                           |
| Expected Result        | HTTP 200 with `{ success: true, data: [], pagination: { total: 0, page: 1, hasMore: false } }`. |
| Automation             | API                                                                                             |

### TC-TS-026: Search with empty query string

| Field                  | Value                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-026                                                                                       |
| Category               | boundary                                                                                        |
| Functional Requirement | FR-2                                                                                            |
| Description            | Verify that an empty search query parameter returns all templates (no filter applied)           |
| Preconditions          | 10 published templates seeded.                                                                  |
| Steps                  | 1. `GET /api/v1/marketplace/templates?q=`. 2. `GET /api/v1/marketplace/templates` (no q param). |
| Expected Result        | Both return the same result set of 10 templates. Empty `q` is treated as no search filter.      |
| Automation             | API                                                                                             |

### TC-TS-027: Search with special characters

| Field                  | Value                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-027                                                                                                                                                                 |
| Category               | boundary                                                                                                                                                                  |
| Functional Requirement | FR-2                                                                                                                                                                      |
| Description            | Verify that search handles special characters and potential injection safely                                                                                              |
| Preconditions          | Template store running with seed data.                                                                                                                                    |
| Steps                  | 1. `GET /api/v1/marketplace/templates?q=$regex`. 2. `GET /api/v1/marketplace/templates?q=<script>alert(1)</script>`. 3. `GET /api/v1/marketplace/templates?q={"$gt":""}`. |
| Expected Result        | All return HTTP 200 with either empty results or matching templates. No server errors (500). No MongoDB injection executed.                                               |
| Automation             | API                                                                                                                                                                       |

### TC-TS-028: Slug with maximum length and special characters

| Field                  | Value                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-028                                                                                                                                                                                                                            |
| Category               | boundary                                                                                                                                                                                                                             |
| Functional Requirement | FR-3                                                                                                                                                                                                                                 |
| Description            | Verify that slug validation handles boundary lengths and invalid characters                                                                                                                                                          |
| Preconditions          | Template store running.                                                                                                                                                                                                              |
| Steps                  | 1. `GET /api/v1/marketplace/templates/a` (1-char slug). 2. `GET /api/v1/marketplace/templates/<256 char string>`. 3. `GET /api/v1/marketplace/templates/slug with spaces`. 4. `GET /api/v1/marketplace/templates/slug/with/slashes`. |
| Expected Result        | Steps 1-2: Either return 404 (slug not found) or the template if it exists. Step 3: Returns 400 (invalid slug format) or 404. Step 4: Returns 404 (route not matched). No 500 errors.                                                |
| Automation             | API                                                                                                                                                                                                                                  |

### TC-TS-029: Concurrent view count increments are atomic

| Field                  | Value                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-029                                                                                                                                    |
| Category               | boundary                                                                                                                                     |
| Functional Requirement | FR-6                                                                                                                                         |
| Description            | Verify that concurrent detail view requests all increment viewCount correctly (no lost updates)                                              |
| Preconditions          | Template seeded with slug `concurrency-test`, initial `viewCount: 0`.                                                                        |
| Steps                  | 1. Send 20 concurrent `GET /api/v1/marketplace/templates/concurrency-test` requests. 2. Query the template document's `viewCount` in the DB. |
| Expected Result        | `viewCount` is exactly 20. No increments lost due to race conditions (MongoDB `$inc` is atomic).                                             |
| Automation             | API                                                                                                                                          |

### TC-TS-030: Categories endpoint with no published templates

| Field                  | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-030                                                                               |
| Category               | boundary                                                                                |
| Functional Requirement | FR-4                                                                                    |
| Description            | Verify the categories endpoint returns an empty array when no published templates exist |
| Preconditions          | No published/public templates in database (only drafts or empty collection).            |
| Steps                  | 1. `GET /api/v1/marketplace/categories`.                                                |
| Expected Result        | HTTP 200 with `{ success: true, data: [] }` or an empty categories array.               |
| Automation             | API                                                                                     |

### TC-TS-031: Featured endpoint with no featured templates

| Field                  | Value                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-031                                                                                    |
| Category               | boundary                                                                                     |
| Functional Requirement | FR-5                                                                                         |
| Description            | Verify the featured endpoint returns an empty array when no templates have featuredOrder set |
| Preconditions          | Published templates exist but none have `featuredOrder` set (all null).                      |
| Steps                  | 1. `GET /api/v1/marketplace/featured`.                                                       |
| Expected Result        | HTTP 200 with empty data array. No error thrown.                                             |
| Automation             | API                                                                                          |

### TC-TS-032: Pagination beyond available pages

| Field                  | Value                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-032                                                                                            |
| Category               | boundary                                                                                             |
| Functional Requirement | FR-1                                                                                                 |
| Description            | Verify that requesting a page number beyond available data returns an empty result set, not an error |
| Preconditions          | 5 published templates seeded.                                                                        |
| Steps                  | 1. `GET /api/v1/marketplace/templates?page=100&limit=20`.                                            |
| Expected Result        | HTTP 200 with `{ data: [], pagination: { total: 5, page: 100, hasMore: false } }`.                   |
| Automation             | API                                                                                                  |

---

## 4. Integration (Cross-Service) Test Cases

### TC-TS-033: Studio proxy forwards requests to template store

| Field                  | Value                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-033                                                                                                                                                          |
| Category               | integration                                                                                                                                                        |
| Functional Requirement | FR-11                                                                                                                                                              |
| Description            | Verify that Studio proxies `/api/template-store/*` requests to the template store service on port 3115                                                             |
| Preconditions          | Both Studio and template store service running. Template store has seed data.                                                                                      |
| Steps                  | 1. `GET http://localhost:5173/api/template-store/marketplace/templates`. 2. Compare response with direct `GET http://localhost:3115/api/v1/marketplace/templates`. |
| Expected Result        | Both return identical template data. The proxy transparently forwards the request and returns the response.                                                        |
| Automation             | API                                                                                                                                                                |

### TC-TS-034: Studio proxy handles template store unavailability

| Field                  | Value                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-034                                                                                                                    |
| Category               | integration                                                                                                                  |
| Functional Requirement | FR-11                                                                                                                        |
| Description            | Verify that Studio returns a meaningful error when the template store service is down                                        |
| Preconditions          | Studio running. Template store service stopped.                                                                              |
| Steps                  | 1. `GET http://localhost:5173/api/template-store/marketplace/templates`.                                                     |
| Expected Result        | Studio returns HTTP 502 or 503 with an error message indicating the upstream service is unavailable. Studio itself stays up. |
| Automation             | API                                                                                                                          |

### TC-TS-035: Template store connects to shared MongoDB

| Field                  | Value                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-035                                                                                                                                                                                                                                        |
| Category               | integration                                                                                                                                                                                                                                      |
| Functional Requirement | FR-1, FR-7                                                                                                                                                                                                                                       |
| Description            | Verify that the template store reads from and writes to the shared `abl_platform` MongoDB database                                                                                                                                               |
| Preconditions          | Template store running with MONGODB_URL pointing at the shared Atlas/local database.                                                                                                                                                             |
| Steps                  | 1. Insert a template document directly into `abl_platform.templates` collection. 2. `GET /api/v1/marketplace/templates` and verify it appears. 3. View the template detail and verify an analytics event appears in `template_analytics_events`. |
| Expected Result        | Template inserted directly is visible via API. Analytics event written by the service is present in the shared DB.                                                                                                                               |
| Automation             | API                                                                                                                                                                                                                                              |

### TC-TS-036: Analytics TTL index enforces 90-day expiry

| Field                  | Value                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-036                                                                                                                                                                                        |
| Category               | integration                                                                                                                                                                                      |
| Functional Requirement | FR-7                                                                                                                                                                                             |
| Description            | Verify that the TTL index on `template_analytics_events.createdAt` is configured for 90 days (7,776,000 seconds)                                                                                 |
| Preconditions          | Template store has started at least once (indexes created).                                                                                                                                      |
| Steps                  | 1. Query MongoDB for indexes on `template_analytics_events` collection: `db.template_analytics_events.getIndexes()`. 2. Find the TTL index on `createdAt`. 3. Verify `expireAfterSeconds` value. |
| Expected Result        | A TTL index exists on `{ createdAt: 1 }` with `expireAfterSeconds: 7776000`.                                                                                                                     |
| Automation             | API                                                                                                                                                                                              |

### TC-TS-037: Request ID propagated through Studio proxy

| Field                  | Value                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-037                                                                                                                |
| Category               | integration                                                                                                              |
| Functional Requirement | FR-9, FR-11                                                                                                              |
| Description            | Verify that the `x-request-id` header from the template store is visible in responses through the Studio proxy           |
| Preconditions          | Both Studio and template store running.                                                                                  |
| Steps                  | 1. `GET http://localhost:5173/api/template-store/marketplace/templates`. 2. Inspect response headers for `x-request-id`. |
| Expected Result        | Response includes `x-request-id` header (either generated by template store or propagated by Studio).                    |
| Automation             | API                                                                                                                      |

### TC-TS-038: CORS headers present for configured origins

| Field                  | Value                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-038                                                                                                                                                 |
| Category               | integration                                                                                                                                               |
| Functional Requirement | FR-1 (security)                                                                                                                                           |
| Description            | Verify that CORS headers are correctly set for configured marketing site origins                                                                          |
| Preconditions          | Template store running with `CORS_ORIGINS=https://marketing.example.com` or `MARKETING_SITE_URL=https://marketing.example.com`.                           |
| Steps                  | 1. Send `OPTIONS /api/v1/marketplace/templates` with `Origin: https://marketing.example.com`. 2. Send same with `Origin: https://evil.example.com`.       |
| Expected Result        | Step 1: Response includes `Access-Control-Allow-Origin: https://marketing.example.com`. Step 2: Response does not include the origin header or denies it. |
| Automation             | API                                                                                                                                                       |

### TC-TS-039: Mongoose models exported from database package

| Field                  | Value                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-039                                                                                                                                                         |
| Category               | integration                                                                                                                                                       |
| Functional Requirement | FR-1 (infrastructure)                                                                                                                                             |
| Description            | Verify that Template, TemplateVersion, and TemplateAnalyticsEvent models are properly exported from `@agent-platform/database`                                    |
| Preconditions          | `packages/database` built successfully.                                                                                                                           |
| Steps                  | 1. Import `Template` from `@agent-platform/database/models`. 2. Import `TemplateVersion`. 3. Import `TemplateAnalyticsEvent`. 4. Verify each is a Mongoose model. |
| Expected Result        | All three models import without errors and have expected static methods (find, findOne, create, etc.).                                                            |
| Automation             | API                                                                                                                                                               |

---

## 5. E2E (Full User Journey) Test Cases

### TC-TS-040: New user discovers and previews a template from the marketplace landing

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-040                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-1, FR-3, FR-5, FR-12, FR-13, FR-14, FR-15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Description            | Full user journey: navigate to marketplace, browse featured templates, click a template, view detail page with all composable sections                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Preconditions          | Studio and template store running. Seed data includes featured templates with media (images and videos), demo conversations, and config preview data.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Steps                  | 1. Open Studio in browser. 2. Click "Template Store" in sidebar navigation. 3. Verify landing page renders: hero section, featured templates grid, category grid with counts, recent additions. 4. Verify featured template cards show type badge (Agent or Project), category badge, complexity indicator, and metrics. 5. Click a featured template card. 6. Verify detail page renders with composable sections: agent-summary, demo-conversation, config-preview. 7. Verify "Coming soon" install placeholder is shown. 8. Click browser back button. 9. Verify return to landing page. |
| Expected Result        | Complete navigation flow works end-to-end. All UI elements render correctly. Detail page sections match the template's `detailSections` array.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### TC-TS-041: User searches and filters to find a specific template

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-041                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Functional Requirement | FR-2, FR-12, FR-13, FR-14                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Description            | Full user journey: use search bar and filter dropdowns to narrow down templates                                                                                                                                                                                                                                                                                                                                                                                                |
| Preconditions          | Studio and template store running. Seed data has templates across multiple categories, types, and complexities.                                                                                                                                                                                                                                                                                                                                                                |
| Steps                  | 1. Navigate to marketplace landing page. 2. Type "customer" in search bar and wait for 300ms debounce. 3. Verify search results page shows matching templates. 4. Apply type filter: "Agent". 5. Verify results narrow to only agent templates matching "customer". 6. Apply complexity filter: "Starter". 7. Verify results narrow further. 8. Change sort order to "Newest". 9. Verify order changes. 10. Click "Clear all filters". 11. Verify full catalog is shown again. |
| Expected Result        | Each filter application reduces the result set. Clearing filters restores the full catalog. Search debounce waits 300ms before sending request.                                                                                                                                                                                                                                                                                                                                |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### TC-TS-042: User browses templates by category

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-042                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-4, FR-12, FR-13, FR-14                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Description            | Full user journey: browse the category grid, click a category, view filtered templates, paginate                                                                                                                                                                                                                                                                                                                                                                            |
| Preconditions          | Studio and template store running. Seed data includes 25+ templates in one category to test pagination.                                                                                                                                                                                                                                                                                                                                                                     |
| Steps                  | 1. Navigate to marketplace landing page. 2. Verify category grid displays with category names and template counts. 3. Click the "Customer Service" category card. 4. Verify navigation to `/marketplace/category/customer-service`. 5. Verify breadcrumb shows "Template Store > Customer Service". 6. Verify filtered templates all belong to customer-service category. 7. If more than 20 templates, click "Next page". 8. Verify page 2 loads with remaining templates. |
| Expected Result        | Category navigation, breadcrumbs, filtering, and pagination all work correctly together.                                                                                                                                                                                                                                                                                                                                                                                    |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### TC-TS-043: Template detail page renders composable sections correctly

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-043                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Functional Requirement | FR-3, FR-6, FR-14, FR-15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Description            | Full detail page verification: composable sections render based on template data, view count increments, type badges display correctly                                                                                                                                                                                                                                                                                                                                                                                |
| Preconditions          | Template with slug `e2e-detail-test` seeded with `detailSections: ["agent-summary", "demo-conversation", "config-preview"]`, media (images and videos), demoConversation messages, typeMetadata, and type "project".                                                                                                                                                                                                                                                                                                  |
| Steps                  | 1. Navigate to `/marketplace/templates/e2e-detail-test`. 2. Verify hero section: template name, publisher info, view count, type badge (purple "Project"). 3. Verify agent-summary section renders (showing agent count, supervisor info from typeMetadata). 4. Verify demo-conversation section renders with alternating user/agent message bubbles. 5. Verify config-preview section renders in read-only mode. 6. Verify "Coming soon" install placeholder. 7. Refresh the page. 8. Verify view count incremented. |
| Expected Result        | All composable sections render correctly based on `detailSections`. Project type badge is purple. Demo conversation shows alternating roles. View count increases on each page load.                                                                                                                                                                                                                                                                                                                                  |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### TC-TS-044: Responsive marketplace layout at mobile, tablet, and desktop

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-044                                                                                                                                                                                                                                                                                                                                                                                   |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-13, FR-14, FR-15                                                                                                                                                                                                                                                                                                                                                                         |
| Description            | Verify marketplace UI adapts correctly across mobile (375px), tablet (768px), and desktop (1280px) viewports                                                                                                                                                                                                                                                                                |
| Preconditions          | Studio and template store running with seed data.                                                                                                                                                                                                                                                                                                                                           |
| Steps                  | 1. Set viewport to 375px width. Navigate to marketplace landing. 2. Verify template grid is single-column. 3. Verify search bar collapses or adapts for mobile. 4. Navigate to a template detail page. 5. Verify tabs stack vertically on mobile. 6. Set viewport to 768px. 7. Verify landing page grid is 2 columns. 8. Set viewport to 1280px. 9. Verify landing page grid is 3+ columns. |
| Expected Result        | Layout adapts at each breakpoint. No horizontal overflow. All content remains accessible and readable.                                                                                                                                                                                                                                                                                      |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                          |

### TC-TS-045: Empty search produces empty state with guidance

| Field                  | Value                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-045                                                                                                                                                                                                                                   |
| Category               | e2e                                                                                                                                                                                                                                         |
| Functional Requirement | FR-2, FR-13                                                                                                                                                                                                                                 |
| Description            | Verify that searching for a term with no matches shows a proper empty state with guidance                                                                                                                                                   |
| Preconditions          | Studio and template store running with seed data.                                                                                                                                                                                           |
| Steps                  | 1. Navigate to marketplace landing. 2. Type "xyznonexistent123" in search bar. 3. Wait for debounce. 4. Verify empty state UI appears (no results message, suggestion to browse categories or adjust filters). 5. Click a suggested action. |
| Expected Result        | Empty state renders with a helpful message. No broken layout or error. User can navigate back to browsing.                                                                                                                                  |
| Automation             | UI                                                                                                                                                                                                                                          |

### TC-TS-046: Marketing website visitor browses without authentication

| Field                  | Value                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-046                                                                                                                                                                                                            |
| Category               | e2e                                                                                                                                                                                                                  |
| Functional Requirement | FR-1, FR-3, FR-4, FR-5                                                                                                                                                                                               |
| Description            | Verify that all public API endpoints work without any authentication tokens (simulating marketing website access)                                                                                                    |
| Preconditions          | Template store running with seed data. No auth tokens used.                                                                                                                                                          |
| Steps                  | 1. `GET /api/v1/marketplace/templates` (no auth). 2. `GET /api/v1/marketplace/categories` (no auth). 3. `GET /api/v1/marketplace/featured` (no auth). 4. `GET /api/v1/marketplace/templates/<valid-slug>` (no auth). |
| Expected Result        | All four endpoints return HTTP 200 with valid data. No authentication errors. This confirms the "public" API design.                                                                                                 |
| Automation             | API                                                                                                                                                                                                                  |

---

## 6. Additional Coverage Test Cases

### TC-TS-047: Template card displays correct type badge colors

| Field                  | Value                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-047                                                                                                                                                                                                                            |
| Category               | positive                                                                                                                                                                                                                             |
| Functional Requirement | FR-14                                                                                                                                                                                                                                |
| Description            | Verify that agent templates show a cyan "Agent" badge and project templates show a purple "Project" badge                                                                                                                            |
| Preconditions          | Studio running. Seed data includes at least 1 agent template and 1 project template.                                                                                                                                                 |
| Steps                  | 1. Navigate to marketplace landing page. 2. Locate an agent template card. 3. Verify badge reads "Agent" with cyan/info color palette. 4. Locate a project template card. 5. Verify badge reads "Project" with purple color palette. |
| Expected Result        | Agent badge: cyan background, "Agent" text, Bot icon. Project badge: purple background, "Project" text, FolderOpen icon.                                                                                                             |
| Automation             | UI                                                                                                                                                                                                                                   |

### TC-TS-048: Template card displays denormalized metrics

| Field                  | Value                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-048                                                                                                                                                                                                                                  |
| Category               | positive                                                                                                                                                                                                                                   |
| Functional Requirement | FR-14                                                                                                                                                                                                                                      |
| Description            | Verify that template cards show install count, rating, category badge, and complexity indicator                                                                                                                                            |
| Preconditions          | Template seeded with `installCount: 150`, `ratingAverage: 4.5`, `ratingCount: 23`, `category: "customer-service"`, `complexity: "standard"`.                                                                                               |
| Steps                  | 1. Navigate to marketplace and find the seeded template card. 2. Verify install count displayed (e.g., "150 installs"). 3. Verify rating displayed (e.g., "4.5" with star icon). 4. Verify category badge. 5. Verify complexity indicator. |
| Expected Result        | All four metrics render correctly on the card. Numbers match the seeded data.                                                                                                                                                              |
| Automation             | UI                                                                                                                                                                                                                                         |

### TC-TS-049: Sidebar navigation entry exists and routes correctly

| Field                  | Value                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-049                                                                                                                                                                              |
| Category               | positive                                                                                                                                                                               |
| Functional Requirement | FR-12                                                                                                                                                                                  |
| Description            | Verify "Template Store" appears in Studio sidebar navigation and routes to the marketplace landing page                                                                                |
| Preconditions          | Studio running.                                                                                                                                                                        |
| Steps                  | 1. Open Studio. 2. Inspect sidebar for "Template Store" entry (between Projects and Settings). 3. Click it. 4. Verify URL navigates to `/marketplace`. 5. Verify landing page renders. |
| Expected Result        | "Template Store" sidebar entry visible with correct icon (`Store` or `LayoutGrid`). Clicking navigates to `/marketplace`.                                                              |
| Automation             | UI                                                                                                                                                                                     |

### TC-TS-050: Landing page displays featured, categories, and recent sections

| Field                  | Value                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-050                                                                                                                                                                                                                                        |
| Category               | positive                                                                                                                                                                                                                                         |
| Functional Requirement | FR-13                                                                                                                                                                                                                                            |
| Description            | Verify the marketplace landing page displays all three required sections: featured templates, category grid, and recent additions                                                                                                                |
| Preconditions          | Studio and template store running. Seed data includes featured templates, multiple categories, and recently published templates.                                                                                                                 |
| Steps                  | 1. Navigate to `/marketplace`. 2. Verify hero/header section exists. 3. Verify featured templates section with template cards. 4. Verify category grid with category names and counts. 5. Verify recent additions section with newest templates. |
| Expected Result        | All three sections render. Featured templates match the API's `/featured` response. Category counts match `/categories` response. Recent additions are sorted by `publishedAt` descending.                                                       |
| Automation             | UI                                                                                                                                                                                                                                               |

### TC-TS-051: Analytics event for marketplace_view recorded

| Field                  | Value                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-051                                                                                                                                                   |
| Category               | positive                                                                                                                                                    |
| Functional Requirement | FR-7                                                                                                                                                        |
| Description            | Verify that visiting the marketplace landing page records a `marketplace_view` analytics event                                                              |
| Preconditions          | Template store running. Analytics events baseline known.                                                                                                    |
| Steps                  | 1. Navigate to marketplace landing page (or `GET /api/v1/marketplace/templates`). 2. Query `template_analytics_events` for `eventType: "marketplace_view"`. |
| Expected Result        | A `marketplace_view` event exists with `createdAt` within last few seconds. `templateId` is null (landing page view, not template-specific).                |
| Automation             | API                                                                                                                                                         |

### TC-TS-052: Analytics event for category_browse recorded

| Field                  | Value                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-052                                                                                                                       |
| Category               | positive                                                                                                                        |
| Functional Requirement | FR-7                                                                                                                            |
| Description            | Verify that browsing by category records a `category_browse` analytics event                                                    |
| Preconditions          | Template store running with seed data.                                                                                          |
| Steps                  | 1. `GET /api/v1/marketplace/templates?category=customer-service`. 2. Query analytics events for `eventType: "category_browse"`. |
| Expected Result        | A `category_browse` event recorded with `metadata` containing `category: "customer-service"`.                                   |
| Automation             | API                                                                                                                             |

### TC-TS-053: Analytics events have nullable userId/tenantId for unauthenticated requests

| Field                  | Value                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-053                                                                                                                                                     |
| Category               | positive                                                                                                                                                      |
| Functional Requirement | FR-7                                                                                                                                                          |
| Description            | Verify that analytics events from unauthenticated requests have null userId and tenantId                                                                      |
| Preconditions          | Template store running. Request sent without authentication.                                                                                                  |
| Steps                  | 1. `GET /api/v1/marketplace/templates/some-slug` without auth headers. 2. Query the `detail_view` analytics event. 3. Inspect `userId` and `tenantId` fields. |
| Expected Result        | Both `userId` and `tenantId` are null. `ipHash` is populated (non-null, hashed). Event is otherwise complete.                                                 |
| Automation             | API                                                                                                                                                           |

### TC-TS-054: Sort order options work correctly

| Field                  | Value                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-054                                                                                                                                                                                                                                                                                  |
| Category               | positive                                                                                                                                                                                                                                                                                   |
| Functional Requirement | FR-2                                                                                                                                                                                                                                                                                       |
| Description            | Verify that sort options (popular, rating, newest, updated) return correctly ordered results                                                                                                                                                                                               |
| Preconditions          | Templates seeded with varied `installCount`, `ratingAverage`, `createdAt`, and `updatedAt` values.                                                                                                                                                                                         |
| Steps                  | 1. `GET /api/v1/marketplace/templates?sort=popular`. Verify ordered by `installCount` desc. 2. `GET ...?sort=rating`. Verify ordered by `ratingAverage` desc. 3. `GET ...?sort=newest`. Verify ordered by `createdAt` desc. 4. `GET ...?sort=updated`. Verify ordered by `updatedAt` desc. |
| Expected Result        | Each sort option produces correctly ordered results.                                                                                                                                                                                                                                       |
| Automation             | API                                                                                                                                                                                                                                                                                        |

### TC-TS-055: Detail page for agent type shows correct typeMetadata

| Field                  | Value                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-055                                                                                                                                                                                    |
| Category               | positive                                                                                                                                                                                     |
| Functional Requirement | FR-3, FR-15                                                                                                                                                                                  |
| Description            | Verify that an agent-type template detail page correctly renders agent-specific typeMetadata                                                                                                 |
| Preconditions          | Agent template seeded with `typeMetadata: { type: "agent", agentCount: 1, hasSupervisor: false, hasFlow: true }`.                                                                            |
| Steps                  | 1. `GET /api/v1/marketplace/templates/<agent-slug>`. 2. Inspect `typeMetadata` in response. 3. On the UI detail page, verify agent summary section renders agent count and flow information. |
| Expected Result        | API returns correct `typeMetadata`. UI renders agent-specific information (single agent, no supervisor, has flow).                                                                           |
| Automation             | API                                                                                                                                                                                          |

### TC-TS-056: Detail page for project type shows correct typeMetadata

| Field                  | Value                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-056                                                                                                                                                                            |
| Category               | positive                                                                                                                                                                             |
| Functional Requirement | FR-3, FR-15                                                                                                                                                                          |
| Description            | Verify that a project-type template detail page correctly renders project-specific typeMetadata                                                                                      |
| Preconditions          | Project template seeded with `typeMetadata: { type: "project", agentCount: 4, hasSupervisor: true, hasFlow: false }`.                                                                |
| Steps                  | 1. `GET /api/v1/marketplace/templates/<project-slug>`. 2. Inspect `typeMetadata` in response. 3. On the UI detail page, verify agent summary section shows 4 agents with supervisor. |
| Expected Result        | API returns correct `typeMetadata`. UI renders project-specific information (4 agents, has supervisor).                                                                              |
| Automation             | API                                                                                                                                                                                  |

### TC-TS-057: Graceful shutdown handles in-flight requests

| Field                  | Value                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-057                                                                                                                                                                                                                         |
| Category               | integration                                                                                                                                                                                                                       |
| Functional Requirement | FR-1 (reliability)                                                                                                                                                                                                                |
| Description            | Verify that the template store handles SIGTERM gracefully, completing in-flight requests within the 10-second timeout                                                                                                             |
| Preconditions          | Template store running.                                                                                                                                                                                                           |
| Steps                  | 1. Start a long-ish request (or send request simultaneously with SIGTERM). 2. Send SIGTERM to the template store process. 3. Observe whether the in-flight request completes. 4. Observe whether new requests after SIGTERM fail. |
| Expected Result        | In-flight request completes successfully. New connections refused after shutdown initiated. Process exits cleanly.                                                                                                                |
| Automation             | Manual                                                                                                                                                                                                                            |

### TC-TS-058: i18n strings render correctly in marketplace UI

| Field                  | Value                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-058                                                                                                                                                                                           |
| Category               | positive                                                                                                                                                                                            |
| Functional Requirement | FR-13, FR-14, FR-15                                                                                                                                                                                 |
| Description            | Verify that all user-facing text on marketplace pages comes from the i18n marketplace namespace (no hardcoded English strings)                                                                      |
| Preconditions          | Studio running. `packages/i18n/locales/en/marketplace.json` has 74 keys loaded.                                                                                                                     |
| Steps                  | 1. Navigate to marketplace landing. 2. Verify headings, button labels, and filter labels match i18n keys. 3. Navigate to detail page. 4. Verify section headers, empty states, and labels use i18n. |
| Expected Result        | All visible text matches the `marketplace.json` i18n keys. No raw translation key strings visible (e.g., no "marketplace.landing.hero.title" displayed as-is).                                      |
| Automation             | UI                                                                                                                                                                                                  |

---

## 7. Phase 2: Positive (Happy Path) Test Cases

### TC-TS-059: Browse response excludes `files` field (projection)

| Field                  | Value                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-059                                                                                                                                                                                                                                                                          |
| Category               | positive                                                                                                                                                                                                                                                                           |
| Functional Requirement | FR-18                                                                                                                                                                                                                                                                              |
| Description            | Verify that browse endpoints exclude the potentially large `files` field from responses using MongoDB projection                                                                                                                                                                   |
| Preconditions          | Template seeded with a TemplateVersion containing `files: { "project.json": "...", "agents/test.agent.abl": "..." }` (populated bundle).                                                                                                                                           |
| Steps                  | 1. `GET /api/v1/marketplace/templates`. 2. Inspect each item — verify no `files` field. 3. `GET /api/v1/marketplace/templates/:slug`. 4. Inspect detail response — verify no `files` field. 5. `GET /api/v1/marketplace/featured`. 6. Inspect each item — verify no `files` field. |
| Expected Result        | All three endpoints return template data WITHOUT a `files` field on any item. Other Phase 2 fields (`media`, `prerequisites`, `reviewStatus`) are present. This ensures browse performance is unaffected by bundle size.                                                           |
| Automation             | API                                                                                                                                                                                                                                                                                |
| Phase                  | 2                                                                                                                                                                                                                                                                                  |

### TC-TS-060: Bundle endpoint returns files for valid slug and version

| Field                  | Value                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-060                                                                                                                                                                                                                                                                  |
| Category               | positive                                                                                                                                                                                                                                                                   |
| Functional Requirement | FR-19                                                                                                                                                                                                                                                                      |
| Description            | Verify the bundle endpoint returns the `files` field for a given template version, used at install time                                                                                                                                                                    |
| Preconditions          | Template with slug `bundle-test` seeded, version `1.0.0`, with `files: { "project.json": "{...}", "agents/billing.agent.abl": "AGENT billing..." }`.                                                                                                                       |
| Steps                  | 1. `GET /api/v1/marketplace/templates/bundle-test/versions/1.0.0/bundle`. 2. Inspect response body.                                                                                                                                                                        |
| Expected Result        | HTTP 200. Response body contains `{ success: true, data: { files: { "project.json": "...", "agents/billing.agent.abl": "..." } } }`. Only the `files` field is returned — no `name`, `slug`, `media`, or other template fields. `files["project.json"]` is parseable JSON. |
| Automation             | API                                                                                                                                                                                                                                                                        |
| Phase                  | 2                                                                                                                                                                                                                                                                          |

### TC-TS-061: Template detail returns `media` array (replaces `screenshots`)

| Field                  | Value                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-061                                                                                                                                                                                                                                                                                     |
| Category               | positive                                                                                                                                                                                                                                                                                      |
| Functional Requirement | FR-21                                                                                                                                                                                                                                                                                         |
| Description            | Verify that the template detail endpoint returns `media[]` with support for both images and videos, replacing the deprecated `screenshots[]` field                                                                                                                                            |
| Preconditions          | Template seeded with `media: [{ type: 'image', url: '/assets/templates/test/hero.png', caption: 'Dashboard view', order: 1 }, { type: 'video', url: '/assets/templates/test/demo.mp4', thumbnailUrl: '/assets/templates/test/demo-thumb.jpg', caption: 'Full demo walkthrough', order: 2 }]`. |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Inspect `media` field. 3. Verify no `screenshots` field exists.                                                                                                                                                                              |
| Expected Result        | Response includes `media` array with 2 items. Item 1: `type: 'image'`, `url`, `caption`, `order: 1`. Item 2: `type: 'video'`, `url`, `thumbnailUrl` (non-null), `caption`, `order: 2`. The `screenshots` field is NOT present in the response. Media items are ordered by the `order` field.  |
| Automation             | API                                                                                                                                                                                                                                                                                           |
| Phase                  | 2                                                                                                                                                                                                                                                                                             |

### TC-TS-062: Template detail returns `prerequisites` field

| Field                  | Value                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-062                                                                                                                                                                                                                                                                                                                        |
| Category               | positive                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-20, FR-24                                                                                                                                                                                                                                                                                                                     |
| Description            | Verify that the template detail endpoint returns the `prerequisites` field with all five sub-fields derived from the manifest metadata                                                                                                                                                                                           |
| Preconditions          | Template seeded with `prerequisites: { envVars: ['OPENAI_API_KEY', 'SALESFORCE_CLIENT_ID'], connectors: ['Salesforce CRM'], mcpServers: [], authProfiles: ['oauth-salesforce'], models: ['gpt-4o', 'gpt-4o-mini'] }`.                                                                                                            |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Inspect `prerequisites` field.                                                                                                                                                                                                                                                  |
| Expected Result        | Response includes `prerequisites` object with: `envVars: ['OPENAI_API_KEY', 'SALESFORCE_CLIENT_ID']`, `connectors: ['Salesforce CRM']`, `mcpServers: []`, `authProfiles: ['oauth-salesforce']`, `models: ['gpt-4o', 'gpt-4o-mini']`. All five fields are always present (empty arrays when no prerequisites, never `undefined`). |
| Automation             | API                                                                                                                                                                                                                                                                                                                              |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                |

### TC-TS-063: Template detail returns `reviewStatus` field

| Field                  | Value                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-063                                                                                                                               |
| Category               | positive                                                                                                                                |
| Functional Requirement | FR-22                                                                                                                                   |
| Description            | Verify that the template detail endpoint returns the `reviewStatus` field                                                               |
| Preconditions          | Template seeded with `reviewStatus: 'approved'`.                                                                                        |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Inspect `reviewStatus` field.                                                          |
| Expected Result        | Response includes `reviewStatus: 'approved'`. The field is a string with one of the valid values: `approved`, `pending`, or `rejected`. |
| Automation             | API                                                                                                                                     |
| Phase                  | 2                                                                                                                                       |

### TC-TS-064: Type filter on browse endpoint

| Field                  | Value                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-064                                                                                                                                                                                                                              |
| Category               | positive                                                                                                                                                                                                                               |
| Functional Requirement | FR-23                                                                                                                                                                                                                                  |
| Description            | Verify that the `?type=` query parameter on the browse endpoint filters templates by type                                                                                                                                              |
| Preconditions          | 4 project templates and 6 agent templates seeded, all published, public, and approved.                                                                                                                                                 |
| Steps                  | 1. `GET /api/v1/marketplace/templates?type=project`. 2. Verify count and types. 3. `GET /api/v1/marketplace/templates?type=agent`. 4. Verify count and types. 5. `GET /api/v1/marketplace/templates` (no type param). 6. Verify count. |
| Expected Result        | Step 2: 4 results, all `type: "project"`. Step 4: 6 results, all `type: "agent"`. Step 6: 10 results (all). Type filter is additive with existing category, complexity, and text search filters.                                       |
| Automation             | API                                                                                                                                                                                                                                    |
| Phase                  | 2                                                                                                                                                                                                                                      |

### TC-TS-065: Type filter on categories endpoint

| Field                  | Value                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-065                                                                                                                                                                                                                      |
| Category               | positive                                                                                                                                                                                                                       |
| Functional Requirement | FR-23, FR-4                                                                                                                                                                                                                    |
| Description            | Verify that the categories endpoint supports `?type=` parameter to return category counts filtered by template type                                                                                                            |
| Preconditions          | Templates seeded: 3 agent/customer-service, 2 project/customer-service, 4 agent/sales, 1 project/sales. All published, public, approved.                                                                                       |
| Steps                  | 1. `GET /api/v1/marketplace/categories?type=agent`. 2. Inspect category counts. 3. `GET /api/v1/marketplace/categories?type=project`. 4. Inspect counts. 5. `GET /api/v1/marketplace/categories` (no type). 6. Inspect counts. |
| Expected Result        | Step 2: customer-service: 3, sales: 4. Step 4: customer-service: 2, sales: 1. Step 6: customer-service: 5, sales: 5. Category counts change based on type filter.                                                              |
| Automation             | API                                                                                                                                                                                                                            |
| Phase                  | 2                                                                                                                                                                                                                              |

### TC-TS-066: TemplateVersion manifest typed as ProjectManifestV2

| Field                  | Value                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-066                                                                                                                                                                                                                                                                                               |
| Category               | positive                                                                                                                                                                                                                                                                                                |
| Functional Requirement | FR-17                                                                                                                                                                                                                                                                                                   |
| Description            | Verify that TemplateVersion documents store `manifest` typed as `ProjectManifestV2` with expected fields                                                                                                                                                                                                |
| Preconditions          | TemplateVersion seeded with `manifest: { format_version: "2.0", name: "test", slug: "test", entry_agent: "main", agents: { main: {...} }, tools: {}, metadata: { entity_counts: { agents: 1, tools: 0 }, required_env_vars: ["OPENAI_API_KEY"], required_connectors: [], required_mcp_servers: [] } }`. |
| Steps                  | 1. Query the TemplateVersion document. 2. Inspect `manifest` field.                                                                                                                                                                                                                                     |
| Expected Result        | `manifest.format_version` is `"2.0"`. `manifest.agents` is a non-empty object. `manifest.metadata.required_env_vars` is an array. `manifest.metadata.entity_counts` has `agents` and `tools` counts. Manifest is a parsed convenience copy — canonical source is `files["project.json"]`.               |
| Automation             | API                                                                                                                                                                                                                                                                                                     |
| Phase                  | 2                                                                                                                                                                                                                                                                                                       |

### TC-TS-067: TemplateVersion files stores import-ready bundle

| Field                  | Value                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-067                                                                                                                                                                                                                                                                           |
| Category               | positive                                                                                                                                                                                                                                                                            |
| Functional Requirement | FR-16                                                                                                                                                                                                                                                                               |
| Description            | Verify that TemplateVersion documents store a `files` field as `Record<string, string>` containing the complete import-ready bundle                                                                                                                                                 |
| Preconditions          | TemplateVersion seeded with `files: { "project.json": "{ \"format_version\": \"2.0\", ... }", "agents/billing.agent.abl": "AGENT billing-agent\n  MODEL gpt-4o\n  ...", "tools/crm.tool.yaml": "name: crm-lookup\n..." }`.                                                          |
| Steps                  | 1. Query the TemplateVersion document. 2. Inspect `files` field. 3. Verify keys are relative paths. 4. Verify values are string content.                                                                                                                                            |
| Expected Result        | `files` is a `Record<string, string>`. Keys include `"project.json"`, agent files under `agents/`, tool files under `tools/`. Values are non-empty strings. `files["project.json"]` parses as valid JSON. Bundle can be converted to `Map<string, string>` for `importProjectV2()`. |
| Automation             | API                                                                                                                                                                                                                                                                                 |
| Phase                  | 2                                                                                                                                                                                                                                                                                   |

### TC-TS-068: Static media asset serving (images)

| Field                  | Value                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-068                                                                                                                           |
| Category               | positive                                                                                                                            |
| Functional Requirement | FR-27                                                                                                                               |
| Description            | Verify that media image assets are served as static files via the template-store Express app                                        |
| Preconditions          | Test image file placed at the static assets path. Template store running with `express.static` configured for `/assets/templates/`. |
| Steps                  | 1. `GET /assets/templates/test-slug/hero.png`. 2. Inspect response status and content type.                                         |
| Expected Result        | HTTP 200. Content type: `image/png`. Body contains the image file bytes. Response is cacheable.                                     |
| Automation             | API                                                                                                                                 |
| Phase                  | 2                                                                                                                                   |

### TC-TS-069: Seed script produces templates with valid Phase 2 data

| Field                  | Value                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-069                                                                                                                                                                                                                                                                                                                                   |
| Category               | positive                                                                                                                                                                                                                                                                                                                                    |
| Functional Requirement | FR-25                                                                                                                                                                                                                                                                                                                                       |
| Description            | Verify that the rewritten seed script produces templates with all Phase 2 fields: `files` bundles, `ProjectManifestV2` manifests, `media[]`, `prerequisites`, and `reviewStatus`                                                                                                                                                            |
| Preconditions          | Empty test MongoDB instance. Seed script available.                                                                                                                                                                                                                                                                                         |
| Steps                  | 1. Run seed script against test DB. 2. Query all templates. 3. Verify each has `media` (not `screenshots`). 4. Verify each has `prerequisites` with 5 sub-fields. 5. Verify each has `reviewStatus: 'approved'`. 6. Query all template versions. 7. Verify each has `files` bundle. 8. Verify each has `manifest.format_version === '2.0'`. |
| Expected Result        | All seeded templates have `media[]` array (may be empty but exists), `prerequisites` object with all five fields, and `reviewStatus: 'approved'`. All versions have non-empty `files` bundles and valid `ProjectManifestV2` manifests. No template has a `screenshots` field.                                                               |
| Automation             | API                                                                                                                                                                                                                                                                                                                                         |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                           |

### TC-TS-070: Prerequisites derived from manifest metadata

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-070                                                                                                                                                                                                                                                                                                                                                      |
| Category               | positive                                                                                                                                                                                                                                                                                                                                                       |
| Functional Requirement | FR-20                                                                                                                                                                                                                                                                                                                                                          |
| Description            | Verify that `prerequisites` on the Template document are correctly derived from the `ProjectManifestV2.metadata` at seed time                                                                                                                                                                                                                                  |
| Preconditions          | Template seeded from a manifest with `metadata: { required_env_vars: ['OPENAI_API_KEY'], required_connectors: ['Salesforce CRM'], required_mcp_servers: ['filesystem'], required_auth_profiles: [{ name: 'oauth-sf' }] }` and an agent with `MODEL gpt-4o`.                                                                                                    |
| Steps                  | 1. Run seed. 2. Query the template. 3. Compare `prerequisites` with manifest metadata.                                                                                                                                                                                                                                                                         |
| Expected Result        | `prerequisites.envVars` matches `metadata.required_env_vars`. `prerequisites.connectors` matches `metadata.required_connectors`. `prerequisites.mcpServers` matches `metadata.required_mcp_servers`. `prerequisites.authProfiles` extracted from `metadata.required_auth_profiles[].name`. `prerequisites.models` extracted from agent DSL MODEL declarations. |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                            |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                              |

---

## 8. Phase 2: Negative (Error Cases) Test Cases

### TC-TS-071: Bundle endpoint returns 404 for nonexistent slug

| Field                  | Value                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-071                                                                                            |
| Category               | negative                                                                                             |
| Functional Requirement | FR-19, FR-10                                                                                         |
| Description            | Verify that requesting a bundle for a nonexistent template slug returns 404 in standard error format |
| Preconditions          | Template store running. No template with slug `nonexistent-bundle-slug`.                             |
| Steps                  | 1. `GET /api/v1/marketplace/templates/nonexistent-bundle-slug/versions/1.0.0/bundle`.                |
| Expected Result        | HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "..." } }`.                    |
| Automation             | API                                                                                                  |
| Phase                  | 2                                                                                                    |

### TC-TS-072: Bundle endpoint returns 404 for nonexistent version

| Field                  | Value                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-072                                                                                                                       |
| Category               | negative                                                                                                                        |
| Functional Requirement | FR-19, FR-10                                                                                                                    |
| Description            | Verify that requesting a bundle for an existing template but nonexistent version returns 404                                    |
| Preconditions          | Template with slug `bundle-test` seeded with version `1.0.0`. No version `99.0.0`.                                              |
| Steps                  | 1. `GET /api/v1/marketplace/templates/bundle-test/versions/99.0.0/bundle`.                                                      |
| Expected Result        | HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "..." } }`. The template exists but the version does not. |
| Automation             | API                                                                                                                             |
| Phase                  | 2                                                                                                                               |

### TC-TS-073: Bundle endpoint returns 400 for invalid version format

| Field                  | Value                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-073                                                                                                           |
| Category               | negative                                                                                                            |
| Functional Requirement | FR-19, FR-10                                                                                                        |
| Description            | Verify that requesting a bundle with an invalid version format (not semver) returns 400                             |
| Preconditions          | Template store running with seed data.                                                                              |
| Steps                  | 1. `GET /api/v1/marketplace/templates/bundle-test/versions/not-semver/bundle`.                                      |
| Expected Result        | HTTP 400 with `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }` indicating invalid version. |
| Automation             | API                                                                                                                 |
| Phase                  | 2                                                                                                                   |

### TC-TS-074: Pending reviewStatus templates excluded from public browse

| Field                  | Value                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-074                                                                                                                                                                                                  |
| Category               | negative                                                                                                                                                                                                   |
| Functional Requirement | FR-22                                                                                                                                                                                                      |
| Description            | Verify that templates with `reviewStatus: 'pending'` are excluded from all public browse endpoints                                                                                                         |
| Preconditions          | Seed 3 templates: 2 with `reviewStatus: 'approved'`, 1 with `reviewStatus: 'pending'`. All published and public.                                                                                           |
| Steps                  | 1. `GET /api/v1/marketplace/templates`. 2. Verify count. 3. `GET /api/v1/marketplace/templates?q=<pending template name>`. 4. `GET /api/v1/marketplace/featured`. 5. `GET /api/v1/marketplace/categories`. |
| Expected Result        | Only 2 approved templates appear in all browse endpoints. The pending template is invisible even when searched by name directly. Category counts exclude the pending template.                             |
| Automation             | API                                                                                                                                                                                                        |
| Phase                  | 2                                                                                                                                                                                                          |

### TC-TS-075: Rejected reviewStatus templates excluded from public browse

| Field                  | Value                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-075                                                                                                                           |
| Category               | negative                                                                                                                            |
| Functional Requirement | FR-22                                                                                                                               |
| Description            | Verify that templates with `reviewStatus: 'rejected'` are excluded from all public browse endpoints                                 |
| Preconditions          | Seed 2 approved templates and 1 rejected template. All published and public.                                                        |
| Steps                  | 1. `GET /api/v1/marketplace/templates`. 2. Verify only 2 templates returned. 3. `GET /api/v1/marketplace/templates/:rejected-slug`. |
| Expected Result        | Browse returns only 2 approved templates. Detail request for the rejected template's slug returns 404.                              |
| Automation             | API                                                                                                                                 |
| Phase                  | 2                                                                                                                                   |

### TC-TS-076: Static media 404 for nonexistent file

| Field                  | Value                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-076                                                                                                   |
| Category               | negative                                                                                                    |
| Functional Requirement | FR-27                                                                                                       |
| Description            | Verify that requesting a nonexistent static media file returns 404                                          |
| Preconditions          | Template store running with `express.static` configured.                                                    |
| Steps                  | 1. `GET /assets/templates/test-slug/nonexistent.png`. 2. `GET /assets/templates/nonexistent-slug/hero.png`. |
| Expected Result        | Both return HTTP 404. No server error (500). No directory listing exposed.                                  |
| Automation             | API                                                                                                         |
| Phase                  | 2                                                                                                           |

---

## 9. Phase 2: Boundary (Limits, Edge Cases) Test Cases

### TC-TS-077: Bundle size at 4MB limit

| Field                  | Value                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-077                                                                                                                                                                                    |
| Category               | boundary                                                                                                                                                                                     |
| Functional Requirement | FR-26                                                                                                                                                                                        |
| Description            | Verify that bundle size validation accepts bundles just under 4MB and rejects bundles exceeding 4MB                                                                                          |
| Preconditions          | Test environment with validation logic accessible.                                                                                                                                           |
| Steps                  | 1. Create a TemplateVersion with `files` bundle totaling ~3.9MB. 2. Verify it saves successfully. 3. Create a TemplateVersion with `files` bundle totaling ~4.1MB. 4. Verify it is rejected. |
| Expected Result        | Step 2: Save succeeds. Step 4: Validation error thrown indicating bundle exceeds 4MB limit. Error message specifies the limit.                                                               |
| Automation             | API                                                                                                                                                                                          |
| Phase                  | 2                                                                                                                                                                                            |

### TC-TS-078: Template with empty media array

| Field                  | Value                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-078                                                                                                                                 |
| Category               | boundary                                                                                                                                  |
| Functional Requirement | FR-21                                                                                                                                     |
| Description            | Verify that a template with an empty `media[]` array renders correctly without errors                                                     |
| Preconditions          | Template seeded with `media: []`.                                                                                                         |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Verify `media` is an empty array. 3. On the UI, navigate to detail page.                 |
| Expected Result        | API returns `media: []`. UI detail page renders without the media section or shows a "No media available" placeholder. No crash or error. |
| Automation             | API + UI                                                                                                                                  |
| Phase                  | 2                                                                                                                                         |

### TC-TS-079: Template with empty prerequisites (all arrays empty)

| Field                  | Value                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-079                                                                                                                             |
| Category               | boundary                                                                                                                              |
| Functional Requirement | FR-20, FR-24                                                                                                                          |
| Description            | Verify that a template with all-empty prerequisites renders the "No prerequisites" message                                            |
| Preconditions          | Template seeded with `prerequisites: { envVars: [], connectors: [], mcpServers: [], authProfiles: [], models: [] }`.                  |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Inspect `prerequisites`. 3. On the UI, verify prerequisites section content.         |
| Expected Result        | API returns `prerequisites` with all empty arrays. UI shows "No prerequisites — ready to install" message. No empty sections visible. |
| Automation             | API + UI                                                                                                                              |
| Phase                  | 2                                                                                                                                     |

### TC-TS-080: Bundle endpoint with only images in media (no videos)

| Field                  | Value                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-080                                                                                                                     |
| Category               | boundary                                                                                                                      |
| Functional Requirement | FR-21                                                                                                                         |
| Description            | Verify that a template with only image-type media items renders correctly (no video-specific UI errors)                       |
| Preconditions          | Template seeded with `media: [{ type: 'image', url: '...', caption: 'Screenshot 1', order: 1 }, { type: 'image', ... }]`.     |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Verify all media items have `type: 'image'`. 3. On UI, verify gallery.       |
| Expected Result        | API returns media with all `type: 'image'`. UI renders image gallery without video player elements. Gallery navigation works. |
| Automation             | API + UI                                                                                                                      |
| Phase                  | 2                                                                                                                             |

### TC-TS-081: Bundle endpoint with only videos in media (no images)

| Field                  | Value                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-081                                                                                                                                         |
| Category               | boundary                                                                                                                                          |
| Functional Requirement | FR-21                                                                                                                                             |
| Description            | Verify that a template with only video-type media items renders correctly                                                                         |
| Preconditions          | Template seeded with `media: [{ type: 'video', url: '...', thumbnailUrl: '...', caption: 'Demo', order: 1 }]`.                                    |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Verify all media items have `type: 'video'`. 3. On UI, verify video player renders.              |
| Expected Result        | API returns media with all `type: 'video'`. UI renders video player with poster frame from `thumbnailUrl`. No image gallery navigation artifacts. |
| Automation             | API + UI                                                                                                                                          |
| Phase                  | 2                                                                                                                                                 |

### TC-TS-082: Type filter with no matching templates

| Field                  | Value                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-082                                                                                                        |
| Category               | boundary                                                                                                         |
| Functional Requirement | FR-23                                                                                                            |
| Description            | Verify that type filter returning zero results produces a valid empty response                                   |
| Preconditions          | Only agent templates seeded (no project templates).                                                              |
| Steps                  | 1. `GET /api/v1/marketplace/templates?type=project`.                                                             |
| Expected Result        | HTTP 200 with `{ success: true, data: [], pagination: { total: 0, page: 1, hasMore: false } }`. No error thrown. |
| Automation             | API                                                                                                              |
| Phase                  | 2                                                                                                                |

### TC-TS-083: Video media without thumbnailUrl

| Field                  | Value                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-083                                                                                                                       |
| Category               | boundary                                                                                                                        |
| Functional Requirement | FR-21                                                                                                                           |
| Description            | Verify that a video media item without a `thumbnailUrl` renders a fallback (no crash)                                           |
| Preconditions          | Template seeded with `media: [{ type: 'video', url: '/assets/.../demo.mp4', caption: 'Demo', order: 1 }]` (no `thumbnailUrl`).  |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Verify video item has no `thumbnailUrl`. 3. On UI, verify video renders.       |
| Expected Result        | API returns video item with `thumbnailUrl: undefined` or absent. UI renders video with a default poster or no poster. No crash. |
| Automation             | API + UI                                                                                                                        |
| Phase                  | 2                                                                                                                               |

### TC-TS-084: Partial prerequisites (some populated, some empty)

| Field                  | Value                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-084                                                                                                                                                                         |
| Category               | boundary                                                                                                                                                                          |
| Functional Requirement | FR-20, FR-24                                                                                                                                                                      |
| Description            | Verify that prerequisites with some populated and some empty arrays render correctly — only showing populated sections                                                            |
| Preconditions          | Template seeded with `prerequisites: { envVars: ['OPENAI_API_KEY'], connectors: [], mcpServers: [], authProfiles: [], models: ['gpt-4o'] }`.                                      |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:slug`. 2. Verify `prerequisites`. 3. On UI, verify only "Environment Variables" and "Models" sections display.                             |
| Expected Result        | API returns all 5 prerequisite fields. UI displays only sections with non-empty arrays (env vars and models). Sections for connectors, MCP servers, and auth profiles are hidden. |
| Automation             | API + UI                                                                                                                                                                          |
| Phase                  | 2                                                                                                                                                                                 |

---

## 10. Phase 2: Integration (Cross-Service) Test Cases

### TC-TS-085: Bundle endpoint accessible via Studio proxy

| Field                  | Value                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-085                                                                                                                                                |
| Category               | integration                                                                                                                                              |
| Functional Requirement | FR-11, FR-19                                                                                                                                             |
| Description            | Verify that the bundle endpoint is accessible through the Studio proxy                                                                                   |
| Preconditions          | Both Studio and template store running. Template with slug `proxy-test`, version `1.0.0` seeded with `files`.                                            |
| Steps                  | 1. `GET http://localhost:5173/api/template-store/marketplace/templates/proxy-test/versions/1.0.0/bundle`. 2. Compare with direct call to template store. |
| Expected Result        | Both return identical `files` data. The proxy transparently forwards the bundle request. Response includes `files` field.                                |
| Automation             | API                                                                                                                                                      |
| Phase                  | 2                                                                                                                                                        |

### TC-TS-086: Static asset path not colliding with API routes

| Field                  | Value                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-086                                                                                                                                                                                                                 |
| Category               | integration                                                                                                                                                                                                               |
| Functional Requirement | FR-27                                                                                                                                                                                                                     |
| Description            | Verify that static asset serving at `/assets/templates/` does not interfere with API routes at `/api/v1/marketplace/`                                                                                                     |
| Preconditions          | Template store running with both API routes and `express.static` configured.                                                                                                                                              |
| Steps                  | 1. `GET /api/v1/marketplace/templates` — verify API response. 2. `GET /assets/templates/test-slug/hero.png` — verify static file. 3. `GET /api/v1/marketplace/templates/test-slug` — verify API detail (not static file). |
| Expected Result        | API routes return JSON responses. Static routes return file content. No route collision. Express processes static routes and API routes independently.                                                                    |
| Automation             | API                                                                                                                                                                                                                       |
| Phase                  | 2                                                                                                                                                                                                                         |

### TC-TS-087: No directory traversal via static asset path

| Field                  | Value                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-087                                                                                                                                               |
| Category               | integration                                                                                                                                             |
| Functional Requirement | FR-27 (security)                                                                                                                                        |
| Description            | Verify that directory traversal attacks via the static asset path are blocked                                                                           |
| Preconditions          | Template store running.                                                                                                                                 |
| Steps                  | 1. `GET /assets/templates/../../etc/passwd`. 2. `GET /assets/templates/../../../package.json`. 3. `GET /assets/templates/test-slug/../../../server.ts`. |
| Expected Result        | All return HTTP 400 or 404. No file content from outside the assets directory is returned. Express `express.static` handles path normalization safely.  |
| Automation             | API                                                                                                                                                     |
| Phase                  | 2                                                                                                                                                       |

### TC-TS-088: Bundle not served for non-published template

| Field                  | Value                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-088                                                                                                                                             |
| Category               | integration                                                                                                                                           |
| Functional Requirement | FR-19, FR-22 (security)                                                                                                                               |
| Description            | Verify that the bundle endpoint does not return files for templates that are not published or not approved                                            |
| Preconditions          | Template seeded with `status: 'draft'` or `reviewStatus: 'pending'`, with a version that has `files`.                                                 |
| Steps                  | 1. `GET /api/v1/marketplace/templates/:draft-slug/versions/1.0.0/bundle`. 2. `GET /api/v1/marketplace/templates/:pending-slug/versions/1.0.0/bundle`. |
| Expected Result        | Both return HTTP 404. Draft and pending template bundles are not accessible via the public bundle endpoint.                                           |
| Automation             | API                                                                                                                                                   |
| Phase                  | 2                                                                                                                                                     |

---

## 11. Phase 2: E2E (Full User Journey) Test Cases

### TC-TS-089: User filters templates by type using tab controls

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-089                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Functional Requirement | FR-23, FR-2, FR-14                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Description            | Full user journey: use type filter tabs to narrow templates by All/Projects/Agents, verify URL updates and results change                                                                                                                                                                                                                                                                                                                                                           |
| Preconditions          | Studio and template store running. Seed data includes both agent and project templates.                                                                                                                                                                                                                                                                                                                                                                                             |
| Steps                  | 1. Navigate to marketplace. 2. Verify "All" tab is active by default. 3. Verify both agent and project templates visible. 4. Click "Projects" tab. 5. Verify URL updates to include `?type=project`. 6. Verify only project templates shown (all cards have purple "Project" badge). 7. Click "Agents" tab. 8. Verify URL updates to `?type=agent`. 9. Verify only agent templates shown (all cards have cyan "Agent" badge). 10. Click "All" tab. 11. Verify all templates return. |
| Expected Result        | Type filter tabs correctly narrow results. URL reflects current filter state. Switching tabs updates results immediately. Type badges on cards match the active filter. Combining with text search or category filter works.                                                                                                                                                                                                                                                        |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### TC-TS-090: User views media gallery with images and video on detail page

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-090                                                                                                                                                                                                                                                                                                                                                                                                      |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                            |
| Functional Requirement | FR-21, FR-27, FR-15                                                                                                                                                                                                                                                                                                                                                                                            |
| Description            | Full user journey: view a template detail page with mixed image and video media, interact with the media gallery                                                                                                                                                                                                                                                                                               |
| Preconditions          | Studio and template store running. Template seeded with `media[]` containing both images and videos. Static media files available at `/assets/templates/<slug>/`.                                                                                                                                                                                                                                              |
| Steps                  | 1. Navigate to template detail page. 2. Verify media section visible. 3. Verify image thumbnails load (no broken images). 4. Verify video item shows poster frame / thumbnail. 5. Click video — verify playback starts (inline or lightbox). 6. Navigate between media items using gallery controls. 7. Verify media items ordered by `order` field. 8. Open lightbox for an image, verify close button works. |
| Expected Result        | Media gallery renders both images and videos. Images load from static asset URLs. Video playback works. Gallery navigation cycles through all items. No broken media or console errors.                                                                                                                                                                                                                        |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                                                                              |

### TC-TS-091: User views prerequisites section on template detail page

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-091                                                                                                                                                                                                                                                                                                                                                                                                     |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                           |
| Functional Requirement | FR-20, FR-24                                                                                                                                                                                                                                                                                                                                                                                                  |
| Description            | Full user journey: view prerequisites section on a template detail page, verify categorized lists render correctly                                                                                                                                                                                                                                                                                            |
| Preconditions          | Studio and template store running. Template seeded with populated `prerequisites`.                                                                                                                                                                                                                                                                                                                            |
| Steps                  | 1. Navigate to a template detail page with populated prerequisites. 2. Verify prerequisites section is visible. 3. Verify "Required Environment Variables" section shows env var chips. 4. Verify "Required Connectors" section shows connector names. 5. Verify "Required Models" section shows model identifiers. 6. Navigate to a template with empty prerequisites. 7. Verify "No prerequisites" message. |
| Expected Result        | Prerequisites section renders before any install CTA. Each category shows relevant items as chips/badges. Empty categories are hidden. Template with no prerequisites shows "No prerequisites — ready to install."                                                                                                                                                                                            |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                                                                             |

### TC-TS-092: Bundle endpoint returns valid import-ready data via API

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-092                                                                                                                                                                                                                                                                                                                                                                          |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                |
| Functional Requirement | FR-16, FR-17, FR-19                                                                                                                                                                                                                                                                                                                                                                |
| Description            | End-to-end verification that the bundle endpoint returns a valid import-ready file bundle matching the stored manifest                                                                                                                                                                                                                                                             |
| Preconditions          | Template store running with seeded templates. At least one template with a complete `files` bundle.                                                                                                                                                                                                                                                                                |
| Steps                  | 1. `GET /api/v1/marketplace/templates` — pick a template slug. 2. `GET /api/v1/marketplace/templates/:slug` — note the version. 3. `GET /api/v1/marketplace/templates/:slug/versions/:version/bundle`. 4. Verify `files` contains `project.json`. 5. Parse `files["project.json"]` as JSON. 6. Verify it has `format_version: "2.0"`. 7. Verify agent files exist under `agents/`. |
| Expected Result        | Bundle endpoint returns a complete `files` Record. `project.json` is valid `ProjectManifestV2`. Agent ABL files are present. The bundle is ready to be converted to `Map<string, string>` for `importProjectV2()`.                                                                                                                                                                 |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                                |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                                                  |

### TC-TS-093: Type filter tabs combined with search and category

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-093                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-23, FR-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Description            | Full user journey: combine type filter tabs with text search and category filter to narrow results progressively                                                                                                                                                                                                                                                                                                                                                                            |
| Preconditions          | Studio and template store running. Seed data includes agent and project templates across multiple categories.                                                                                                                                                                                                                                                                                                                                                                               |
| Steps                  | 1. Navigate to marketplace. 2. Click "Agents" type tab. 3. Verify only agent templates shown. 4. Type "customer" in search bar. 5. Verify results narrow to agent templates matching "customer". 6. Apply category filter "customer-service". 7. Verify triple-filter intersection: agent + customer search + customer-service category. 8. Clear search text. 9. Verify category + type filter still active. 10. Click "All" tab. 11. Verify category filter remains, type filter cleared. |
| Expected Result        | Filters compose correctly. Each additional filter narrows results. Clearing one filter expands results while keeping others. URL reflects all active filters.                                                                                                                                                                                                                                                                                                                               |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### TC-TS-094: Template detail page screenshots tab renamed to media

| Field                  | Value                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-094                                                                                                                                                                      |
| Category               | e2e                                                                                                                                                                            |
| Functional Requirement | FR-21, FR-15                                                                                                                                                                   |
| Description            | Verify the detail page tab previously labeled "Screenshots" is updated to "Media" (or equivalent) to reflect the broader content type                                          |
| Preconditions          | Studio and template store running. Template with media items seeded.                                                                                                           |
| Steps                  | 1. Navigate to a template detail page. 2. Verify tabs include a media-related tab (not "Screenshots"). 3. Click the media tab. 4. Verify both images and video content render. |
| Expected Result        | Detail page tab labels reflect the `media[]` field change. The tab that previously showed only screenshots now supports and displays both images and videos.                   |
| Automation             | UI                                                                                                                                                                             |
| Phase                  | 2                                                                                                                                                                              |

### TC-TS-095: i18n strings for Phase 2 UI elements

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-095                                                                                                                                                                                                                                                                                                                                                                     |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                           |
| Functional Requirement | FR-23, FR-24, FR-21                                                                                                                                                                                                                                                                                                                                                           |
| Description            | Verify that all new Phase 2 UI elements use i18n strings from the marketplace namespace (no hardcoded English)                                                                                                                                                                                                                                                                |
| Preconditions          | Studio running. `packages/i18n/locales/en/marketplace.json` updated with Phase 2 keys for prerequisites, media, and type filter tabs.                                                                                                                                                                                                                                         |
| Steps                  | 1. Navigate to marketplace. 2. Verify type filter tab labels ("All", "Projects", "Agents") come from i18n keys. 3. Navigate to a template detail page with prerequisites. 4. Verify prerequisite section headers come from i18n keys. 5. Verify media section labels come from i18n keys. 6. Check no raw i18n key strings visible (e.g., "marketplace.prerequisites.title"). |
| Expected Result        | All new Phase 2 UI text renders from i18n keys. No hardcoded English strings. No untranslated key placeholders visible.                                                                                                                                                                                                                                                       |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                            |
| Phase                  | 2                                                                                                                                                                                                                                                                                                                                                                             |

---

## 12. Phase 3: Positive (Happy Path) Test Cases

### TC-TS-096: Project template install creates project and imports bundle

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-096                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Category               | positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Functional Requirement | FR-28                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Description            | Verify that project template install creates a new project and imports the full file bundle via the layered import pipeline with `conflictStrategy: 'replace'`                                                                                                                                                                                                                                                                                                                                                       |
| Preconditions          | Published template with slug `install-test`, version `1.0.0`, containing `files` bundle with `project.json` (valid `ProjectManifestV2`), 2 agent ABL files, and 1 tool YAML. Template has `prerequisites: { envVars: ['OPENAI_API_KEY'], connectors: ['Salesforce CRM'], mcpServers: [], authProfiles: ['oauth-sf'], models: ['gpt-4o'] }`. Authenticated user with `project:create` permission.                                                                                                                     |
| Steps                  | 1. `POST /api/template-install/project` with body `{ templateSlug: "install-test", version: "1.0.0", projectName: "My Installed Project" }` and valid JWT Bearer token. 2. Inspect response. 3. Query projects collection for the new project. 4. Query project agents and tools for the new project.                                                                                                                                                                                                                |
| Expected Result        | HTTP 201. Response: `{ success: true, project: { id: "<uuid>", name: "My Installed Project", slug: "my-installed-project" }, applied: { created: 2, updated: 0, deleted: 0, toolsCreated: 1, toolsUpdated: 0, toolsDeleted: 0, ... }, entryAgentName: "<from manifest>", provisioningRequired: { envVars: ["OPENAI_API_KEY"], connectors: ["Salesforce CRM"], mcpServers: [], authProfiles: ["oauth-sf"] } }`. New project exists in DB with correct `tenantId`. Agents and tools match the template bundle content. |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### TC-TS-097: Project template install with custom slug

| Field                  | Value                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-097                                                                                                                                                                                                  |
| Category               | positive                                                                                                                                                                                                   |
| Functional Requirement | FR-28                                                                                                                                                                                                      |
| Description            | Verify that project template install accepts an optional custom slug and uses it for the new project                                                                                                       |
| Preconditions          | Published template with slug `install-test`, version `1.0.0`. Authenticated user.                                                                                                                          |
| Steps                  | 1. `POST /api/template-install/project` with body `{ templateSlug: "install-test", version: "1.0.0", projectName: "Custom Slug Project", projectSlug: "custom-slug" }` and valid JWT. 2. Inspect response. |
| Expected Result        | HTTP 200. Response `project.slug` is `"custom-slug"`. New project in DB has `slug: "custom-slug"`.                                                                                                         |
| Automation             | API                                                                                                                                                                                                        |
| Phase                  | 3                                                                                                                                                                                                          |

### TC-TS-098: Agent template install preview returns dry-run add/modify counts

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-098                                                                                                                                                                                                                                                                                                                                                              |
| Category               | positive                                                                                                                                                                                                                                                                                                                                                               |
| Functional Requirement | FR-29, FR-30                                                                                                                                                                                                                                                                                                                                                           |
| Description            | Verify that the agent install preview returns a dry-run summary of what agents/tools will be added or modified, without applying any changes                                                                                                                                                                                                                           |
| Preconditions          | Published agent-type template with slug `agent-install-test`, containing 1 agent and 2 tools. Target project `projectId` exists (empty). Authenticated user with `PROJECT_READ` permission on the project.                                                                                                                                                             |
| Steps                  | 1. `POST /api/template-install/agent/[id]/preview` with body `{ templateSlug: "agent-install-test", version: "1.0.0", projectId: "<projectId>" }` and valid JWT. 2. Inspect response. 3. Query the target project's agents and tools to verify nothing was changed.                                                                                                    |
| Expected Result        | HTTP 200. Response: `{ success: true, preview: { agentChanges: { added: [{ name: "..." }], modified: [], removed: [] }, toolChanges: { added: [{ name: "..." }, { name: "..." }], modified: [], removed: [] }, ... }, previewDigest: "<hash>" }`. Target project has NO new agents or tools (dry-run only). Preview shows 1 agent to be added and 2 tools to be added. |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                    |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                      |

### TC-TS-099: Agent template install apply merges agent into existing project

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-099                                                                                                                                                                                                                                                                                                                                                       |
| Category               | positive                                                                                                                                                                                                                                                                                                                                                        |
| Functional Requirement | FR-29                                                                                                                                                                                                                                                                                                                                                           |
| Description            | Verify that the agent install apply merges the template's agent and tools into the target project using `conflictStrategy: 'merge'` and `layers: ['core']`, preserving existing project content                                                                                                                                                                 |
| Preconditions          | Published agent-type template with slug `agent-install-test`, containing 1 agent (`billing-agent`) and 2 tools. Target project has 1 existing agent (`support-agent`). Authenticated user with `PROJECT_IMPORT` permission.                                                                                                                                     |
| Steps                  | 1. `POST /api/template-install/agent/[id]/preview` to get `previewDigest`. 2. `POST /api/template-install/agent/[id]/apply` with body `{ templateSlug: "agent-install-test", version: "1.0.0", projectId: "<projectId>", previewDigest: "<from step 1>" }` and valid JWT. 3. Query the target project's agents.                                                 |
| Expected Result        | HTTP 200. Response: `{ success: true, applied: { created: 1, toolsCreated: 2, ... }, provisioningRequired: { envVars: [...], connectors: [...], mcpServers: [...], authProfiles: [...] } }`. Target project now has 2 agents: `support-agent` (pre-existing, unchanged) and `billing-agent` (from template). Both tools from the template exist in the project. |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                             |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                               |

### TC-TS-100: Post-install report includes provisioning requirements

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-100                                                                                                                                                                                                                                                                                                                                              |
| Category               | positive                                                                                                                                                                                                                                                                                                                                               |
| Functional Requirement | FR-31                                                                                                                                                                                                                                                                                                                                                  |
| Description            | Verify that both project and agent installs return a `provisioningRequired` field derived from the template's `prerequisites`, showing what still needs to be configured                                                                                                                                                                               |
| Preconditions          | Template with `prerequisites: { envVars: ['OPENAI_API_KEY', 'DB_URL'], connectors: ['Salesforce CRM'], mcpServers: ['filesystem'], authProfiles: ['oauth-salesforce'], models: ['gpt-4o'] }`. Authenticated user.                                                                                                                                      |
| Steps                  | 1. Complete a project install. 2. Inspect `provisioningRequired` in the response.                                                                                                                                                                                                                                                                      |
| Expected Result        | Response includes `provisioningRequired: { envVars: ['OPENAI_API_KEY', 'DB_URL'], connectors: ['Salesforce CRM'], mcpServers: ['filesystem'], authProfiles: ['oauth-salesforce'] }`. All four provisioning categories are present. The `models` field from prerequisites is not included in `provisioningRequired` (models are configured separately). |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                    |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                      |

### TC-TS-101: Install count increments after successful project install

| Field                  | Value                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-101                                                                                                                                                                                                            |
| Category               | positive                                                                                                                                                                                                             |
| Functional Requirement | FR-33                                                                                                                                                                                                                |
| Description            | Verify that the template's `installCount` is atomically incremented after a successful project install                                                                                                               |
| Preconditions          | Template with slug `counter-install-test`, initial `installCount: 5`. Authenticated user.                                                                                                                            |
| Steps                  | 1. Note initial `installCount: 5`. 2. Complete a successful project install. 3. Query the template document. 4. Complete a second successful project install (different name). 5. Query the template document again. |
| Expected Result        | After step 3: `installCount` is 6. After step 5: `installCount` is 7. Each successful install atomically increments the count.                                                                                       |
| Automation             | API                                                                                                                                                                                                                  |
| Phase                  | 3                                                                                                                                                                                                                    |

### TC-TS-102: Install count increments after successful agent install

| Field                  | Value                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-102                                                                                                            |
| Category               | positive                                                                                                             |
| Functional Requirement | FR-33                                                                                                                |
| Description            | Verify that the template's `installCount` is atomically incremented after a successful agent install                 |
| Preconditions          | Agent template with slug `agent-counter-test`, initial `installCount: 0`. Target project exists. Authenticated user. |
| Steps                  | 1. Complete a successful agent install (preview + apply). 2. Query the template document.                            |
| Expected Result        | `installCount` is 1.                                                                                                 |
| Automation             | API                                                                                                                  |
| Phase                  | 3                                                                                                                    |

### TC-TS-103: Install analytics event recorded on successful install

| Field                  | Value                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-103                                                                                                                                                                                                                                                                |
| Category               | positive                                                                                                                                                                                                                                                                 |
| Functional Requirement | FR-33                                                                                                                                                                                                                                                                    |
| Description            | Verify that a successful install (project or agent) records an `install` analytics event with user, tenant, and project context                                                                                                                                          |
| Preconditions          | Template with slug `analytics-install-test`. Authenticated user with `userId` and `tenantId` in JWT.                                                                                                                                                                     |
| Steps                  | 1. Complete a successful project install for `analytics-install-test`. 2. Query `template_analytics_events` for events with `eventType: "install"` and `templateSlug: "analytics-install-test"`.                                                                         |
| Expected Result        | One `install` event exists with: `userId` matching JWT user, `tenantId` matching JWT tenant, `templateSlug: "analytics-install-test"`, `metadata.projectId` matching the created project's ID, `createdAt` within last few seconds. Event has TTL index (90-day expiry). |
| Automation             | API                                                                                                                                                                                                                                                                      |
| Phase                  | 3                                                                                                                                                                                                                                                                        |

### TC-TS-104: Agent install preview shows modifications for existing agent

| Field                  | Value                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-104                                                                                                                                                                                               |
| Category               | positive                                                                                                                                                                                                |
| Functional Requirement | FR-30                                                                                                                                                                                                   |
| Description            | Verify that when an agent template contains an agent with the same name as an existing project agent, the preview correctly shows it as a modification rather than an addition                          |
| Preconditions          | Agent template with slug `modify-test` containing agent `billing-agent`. Target project already has an agent named `billing-agent`. Authenticated user.                                                 |
| Steps                  | 1. `POST /api/template-install/agent/[id]/preview` with the template and target project. 2. Inspect `preview.agentChanges`.                                                                             |
| Expected Result        | Preview shows `agentChanges.modified: [{ name: "billing-agent" }]` and `agentChanges.added: []`. The existing agent is flagged as "will be modified" — not "will be added". Tools follow similar logic. |
| Automation             | API                                                                                                                                                                                                     |
| Phase                  | 3                                                                                                                                                                                                       |

### TC-TS-105: Post-install report for template with no prerequisites

| Field                  | Value                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-105                                                                                                                                      |
| Category               | positive                                                                                                                                       |
| Functional Requirement | FR-31                                                                                                                                          |
| Description            | Verify that installing a template with empty prerequisites returns an empty `provisioningRequired` object                                      |
| Preconditions          | Template with `prerequisites: { envVars: [], connectors: [], mcpServers: [], authProfiles: [], models: [] }`. Authenticated user.              |
| Steps                  | 1. Complete a project install. 2. Inspect `provisioningRequired`.                                                                              |
| Expected Result        | `provisioningRequired: { envVars: [], connectors: [], mcpServers: [], authProfiles: [] }`. All arrays are empty. No provisioning steps needed. |
| Automation             | API                                                                                                                                            |
| Phase                  | 3                                                                                                                                              |

---

## 13. Phase 3: Negative (Error Cases) Test Cases

### TC-TS-106: Project install returns 401 without auth token

| Field                  | Value                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-106                                                                                                                                                              |
| Category               | negative                                                                                                                                                               |
| Functional Requirement | FR-28, FR-32                                                                                                                                                           |
| Description            | Verify that project template install requires authentication and returns 401 when no JWT Bearer token is provided                                                      |
| Preconditions          | Published template with slug `install-test`. NO auth header.                                                                                                           |
| Steps                  | 1. `POST /api/template-install/project` with body `{ templateSlug: "install-test", version: "1.0.0", projectName: "Test" }` and NO Authorization header. 2. Verify DB. |
| Expected Result        | HTTP 401 with `{ success: false, error: { code: "UNAUTHORIZED", message: "..." } }`. No project created in database.                                                   |
| Automation             | API                                                                                                                                                                    |
| Phase                  | 3                                                                                                                                                                      |

### TC-TS-107: Agent install preview returns 401 without auth token

| Field                  | Value                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-107                                                                                                                                                      |
| Category               | negative                                                                                                                                                       |
| Functional Requirement | FR-30, FR-32                                                                                                                                                   |
| Description            | Verify that agent install preview requires authentication                                                                                                      |
| Preconditions          | Published agent template. Target project exists. NO auth header.                                                                                               |
| Steps                  | 1. `POST /api/template-install/agent/[id]/preview` with body `{ templateSlug: "agent-test", version: "1.0.0", projectId: "..." }` and NO Authorization header. |
| Expected Result        | HTTP 401 with `{ success: false, error: { code: "UNAUTHORIZED", message: "..." } }`.                                                                           |
| Automation             | API                                                                                                                                                            |
| Phase                  | 3                                                                                                                                                              |

### TC-TS-108: Agent install apply returns 401 without auth token

| Field                  | Value                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-108                                                                                                                                                                          |
| Category               | negative                                                                                                                                                                           |
| Functional Requirement | FR-29, FR-32                                                                                                                                                                       |
| Description            | Verify that agent install apply requires authentication and no changes are made without a valid JWT                                                                                |
| Preconditions          | Published agent template. Target project exists. NO auth header.                                                                                                                   |
| Steps                  | 1. `POST /api/template-install/agent/[id]/apply` with body `{ templateSlug: "agent-test", version: "1.0.0", projectId: "...", previewDigest: "..." }` and NO Authorization header. |
| Expected Result        | HTTP 401 with `{ success: false, error: { code: "UNAUTHORIZED", message: "..." } }`. No changes applied to target project.                                                         |
| Automation             | API                                                                                                                                                                                |
| Phase                  | 3                                                                                                                                                                                  |

### TC-TS-109: Project install returns 404 for nonexistent template slug

| Field                  | Value                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-109                                                                                                                                                                            |
| Category               | negative                                                                                                                                                                             |
| Functional Requirement | FR-28                                                                                                                                                                                |
| Description            | Verify that project install returns 404 when the template slug does not exist or the version is not found                                                                            |
| Preconditions          | No template with slug `nonexistent-template`. Authenticated user.                                                                                                                    |
| Steps                  | 1. `POST /api/template-install/project` with body `{ templateSlug: "nonexistent-template", version: "1.0.0", projectName: "Test" }` and valid JWT. 2. Verify no project was created. |
| Expected Result        | HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "Template not found" } }`. No project created in database.                                                     |
| Automation             | API                                                                                                                                                                                  |
| Phase                  | 3                                                                                                                                                                                    |

### TC-TS-110: Project install returns 409 for duplicate project slug

| Field                  | Value                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-110                                                                                                                                                                                                                     |
| Category               | negative                                                                                                                                                                                                                      |
| Functional Requirement | FR-28                                                                                                                                                                                                                         |
| Description            | Verify that project install returns 409 when the provided or generated slug already exists for the tenant                                                                                                                     |
| Preconditions          | Existing project with slug `existing-project` in the same tenant. Published template. Authenticated user.                                                                                                                     |
| Steps                  | 1. `POST /api/template-install/project` with body `{ templateSlug: "install-test", version: "1.0.0", projectName: "Existing Project", projectSlug: "existing-project" }` and valid JWT. 2. Verify no new project was created. |
| Expected Result        | HTTP 409 with `{ success: false, error: { code: "DUPLICATE_SLUG", message: "A project with this slug already exists" } }`. Existing project is unchanged.                                                                     |
| Automation             | API                                                                                                                                                                                                                           |
| Phase                  | 3                                                                                                                                                                                                                             |

### TC-TS-111: Agent install preview returns 404 for nonexistent project

| Field                  | Value                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-111                                                                                                                                                           |
| Category               | negative                                                                                                                                                            |
| Functional Requirement | FR-29, FR-30                                                                                                                                                        |
| Description            | Verify that agent install preview returns 404 when the target project does not exist or is not accessible to the user                                               |
| Preconditions          | Published agent template. No project with the given `projectId` in the user's tenant. Authenticated user.                                                           |
| Steps                  | 1. `POST /api/template-install/agent/[id]/preview` with body `{ templateSlug: "agent-test", version: "1.0.0", projectId: "nonexistent-project-id" }` and valid JWT. |
| Expected Result        | HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "Project not found" } }`.                                                                     |
| Automation             | API                                                                                                                                                                 |
| Phase                  | 3                                                                                                                                                                   |

### TC-TS-112: Project install returns 400 for missing required fields

| Field                  | Value                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-112                                                                                                                                                                                                                                                                                                        |
| Category               | negative                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-28                                                                                                                                                                                                                                                                                                            |
| Description            | Verify that project install validates required fields and returns 400 for missing or invalid input                                                                                                                                                                                                               |
| Preconditions          | Published template. Authenticated user.                                                                                                                                                                                                                                                                          |
| Steps                  | 1. `POST /api/template-install/project` with `{ templateSlug: "install-test", version: "1.0.0" }` (no projectName). 2. `POST /api/template-install/project` with `{ projectName: "Test" }` (no templateSlug). 3. `POST /api/template-install/project` with `{ templateSlug: "", version: "", projectName: "" }`. |
| Expected Result        | All return HTTP 400 with `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }` indicating the missing/invalid fields.                                                                                                                                                                        |
| Automation             | API                                                                                                                                                                                                                                                                                                              |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                |

### TC-TS-113: Install does not increment count on failure

| Field                  | Value                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-113                                                                                                                                                 |
| Category               | negative                                                                                                                                                  |
| Functional Requirement | FR-33                                                                                                                                                     |
| Description            | Verify that a failed install attempt (auth failure, template not found, validation error) does NOT increment the template's `installCount`                |
| Preconditions          | Template with slug `no-count-test`, initial `installCount: 3`.                                                                                            |
| Steps                  | 1. Attempt project install without auth (expect 401). 2. Attempt project install with nonexistent template slug (expect 404). 3. Query template document. |
| Expected Result        | `installCount` is still 3. Failed installs do not increment the counter. No `install` analytics events recorded for the failed attempts.                  |
| Automation             | API                                                                                                                                                       |
| Phase                  | 3                                                                                                                                                         |

---

## 14. Phase 3: Boundary (Limits, Edge Cases) Test Cases

### TC-TS-114: Project name at maximum length (100 chars)

| Field                  | Value                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-114                                                                                                                                                           |
| Category               | boundary                                                                                                                                                            |
| Functional Requirement | FR-28                                                                                                                                                               |
| Description            | Verify that project install accepts a project name at the maximum length (100 chars) and rejects names exceeding it                                                 |
| Preconditions          | Published template. Authenticated user.                                                                                                                             |
| Steps                  | 1. `POST /api/template-install/project` with `projectName` of exactly 100 characters. 2. `POST /api/template-install/project` with `projectName` of 101 characters. |
| Expected Result        | Step 1: HTTP 200, project created with the 100-char name. Step 2: HTTP 400 with validation error indicating name exceeds maximum length.                            |
| Automation             | API                                                                                                                                                                 |
| Phase                  | 3                                                                                                                                                                   |

### TC-TS-115: Project slug validation at boundary

| Field                  | Value                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-115                                                                                                                                                                                                                                                                                                     |
| Category               | boundary                                                                                                                                                                                                                                                                                                      |
| Functional Requirement | FR-28                                                                                                                                                                                                                                                                                                         |
| Description            | Verify that project slug validation enforces the correct pattern: lowercase alphanumeric + hyphens, max 50 chars                                                                                                                                                                                              |
| Preconditions          | Published template. Authenticated user.                                                                                                                                                                                                                                                                       |
| Steps                  | 1. Install with `projectSlug: "valid-slug-123"` — should succeed. 2. Install with `projectSlug: "UPPERCASE"` — should fail (400). 3. Install with `projectSlug: "slug with spaces"` — should fail. 4. Install with slug of exactly 50 chars — should succeed. 5. Install with slug of 51 chars — should fail. |
| Expected Result        | Steps 1, 4: succeed. Steps 2, 3, 5: return HTTP 400 with validation error.                                                                                                                                                                                                                                    |
| Automation             | API                                                                                                                                                                                                                                                                                                           |
| Phase                  | 3                                                                                                                                                                                                                                                                                                             |

### TC-TS-116: Concurrent project installs from same template

| Field                  | Value                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-116                                                                                                                                                                                                            |
| Category               | boundary                                                                                                                                                                                                             |
| Functional Requirement | FR-28, FR-33                                                                                                                                                                                                         |
| Description            | Verify that concurrent project installs from the same template produce separate projects and correctly increment the install count                                                                                   |
| Preconditions          | Template with slug `concurrent-install-test`, initial `installCount: 0`. Authenticated user.                                                                                                                         |
| Steps                  | 1. Send 5 concurrent `POST /api/template-install/project` requests with different project names (`Project-1` through `Project-5`). 2. Wait for all to complete. 3. Query projects. 4. Query template `installCount`. |
| Expected Result        | All 5 requests succeed (HTTP 201). 5 distinct projects created (different IDs and slugs). Template `installCount` is exactly 5 (atomic increment, no lost updates).                                                  |
| Automation             | API                                                                                                                                                                                                                  |
| Phase                  | 3                                                                                                                                                                                                                    |

### TC-TS-117: Agent install apply with stale preview digest

| Field                  | Value                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-117                                                                                                                                                                                                                                        |
| Category               | boundary                                                                                                                                                                                                                                         |
| Functional Requirement | FR-29, FR-30                                                                                                                                                                                                                                     |
| Description            | Verify that agent install apply rejects a stale preview digest (when project state has changed between preview and apply)                                                                                                                        |
| Preconditions          | Agent template. Target project with no agents. Authenticated user.                                                                                                                                                                               |
| Steps                  | 1. Get preview and `previewDigest` from `POST /api/template-install/agent/[id]/preview`. 2. Manually add an agent to the target project (changing project state). 3. `POST /api/template-install/agent/[id]/apply` with the old `previewDigest`. |
| Expected Result        | HTTP 409 with `{ success: false, error: { code: "PREVIEW_STALE", message: "Project state has changed since preview. Please re-preview." } }`. No changes applied.                                                                                |
| Automation             | API                                                                                                                                                                                                                                              |
| Phase                  | 3                                                                                                                                                                                                                                                |

### TC-TS-118: Install with template that has large bundle (near 4MB)

| Field                  | Value                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-118                                                                                                                         |
| Category               | boundary                                                                                                                          |
| Functional Requirement | FR-28                                                                                                                             |
| Description            | Verify that project install works correctly with a template whose bundle is close to the 4MB limit                                |
| Preconditions          | Template with `files` bundle totaling ~3.9MB. Authenticated user.                                                                 |
| Steps                  | 1. `POST /api/template-install/project` with the large-bundle template. 2. Verify project creation and import succeed.            |
| Expected Result        | HTTP 200. Project created and all agents/tools imported successfully despite the large bundle size. No timeout or payload errors. |
| Automation             | API                                                                                                                               |
| Phase                  | 3                                                                                                                                 |

---

## 15. Phase 3: Integration (Cross-Service) Test Cases

### TC-TS-119: Install fetches bundle server-side via template store proxy

| Field                  | Value                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-119                                                                                                                                                                                                                                                 |
| Category               | integration                                                                                                                                                                                                                                               |
| Functional Requirement | FR-28, FR-29                                                                                                                                                                                                                                              |
| Description            | Verify that the install endpoints fetch the template bundle server-side via the Studio-to-template-store proxy, not client-side                                                                                                                           |
| Preconditions          | Studio and template store both running. Published template with `files` bundle. Authenticated user.                                                                                                                                                       |
| Steps                  | 1. Complete a project install via `POST /api/template-install/project`. 2. Inspect the install response — verify it does NOT contain a `files` field (bundle is consumed server-side). 3. Verify the new project contains agents/tools from the template. |
| Expected Result        | Install response includes `project`, `applied`, `provisioningRequired` but NOT `files`. The bundle was fetched server-side and consumed by `importProjectV2()` without exposing raw content to the client. Agents and tools are correctly imported.       |
| Automation             | API                                                                                                                                                                                                                                                       |
| Phase                  | 3                                                                                                                                                                                                                                                         |

### TC-TS-120: Installed project is scoped to authenticated user's tenant

| Field                  | Value                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-120                                                                                                                                                                                                                       |
| Category               | integration                                                                                                                                                                                                                     |
| Functional Requirement | FR-28, FR-32                                                                                                                                                                                                                    |
| Description            | Verify that a project created via template install is properly scoped to the authenticated user's tenant and owned by the user                                                                                                  |
| Preconditions          | Published template. User A authenticated (tenantId: `tenant-1`). User B authenticated (tenantId: `tenant-2`).                                                                                                                   |
| Steps                  | 1. User A installs the template (creates project). 2. Query the project — verify `tenantId: "tenant-1"` and `ownerId` matches User A. 3. User B lists their projects. 4. Verify User B does NOT see User A's installed project. |
| Expected Result        | Project created with `tenantId: "tenant-1"`, `ownerId: "<user-a-id>"`. User B's project list does not include the project. Cross-tenant isolation is enforced.                                                                  |
| Automation             | API                                                                                                                                                                                                                             |
| Phase                  | 3                                                                                                                                                                                                                               |

### TC-TS-121: Agent install respects project-level tenant isolation

| Field                  | Value                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-121                                                                                                                 |
| Category               | integration                                                                                                               |
| Functional Requirement | FR-29, FR-32                                                                                                              |
| Description            | Verify that agent install into a project only succeeds when the user has access to the target project within their tenant |
| Preconditions          | Project `project-1` owned by `tenant-1`. User authenticated as `tenant-2`.                                                |
| Steps                  | 1. `POST /api/template-install/agent/[id]/preview` with `projectId` belonging to `tenant-1` using `tenant-2` JWT.         |
| Expected Result        | HTTP 404 (project not found — cross-scope returns 404, not 403). No changes to the project.                               |
| Automation             | API                                                                                                                       |
| Phase                  | 3                                                                                                                         |

### TC-TS-122: Install works when template store is the bundle source

| Field                  | Value                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-122                                                                                                                                                                                                                                         |
| Category               | integration                                                                                                                                                                                                                                       |
| Functional Requirement | FR-28, FR-29                                                                                                                                                                                                                                      |
| Description            | Verify end-to-end: template store serves the bundle, Studio install route consumes it, import pipeline processes it, project is created with correct content                                                                                      |
| Preconditions          | Template store running with seed data. Studio running. Real template with valid ABL DSL in bundle. Authenticated user.                                                                                                                            |
| Steps                  | 1. `GET /api/template-store/marketplace/templates` — pick a project template slug. 2. `POST /api/template-install/project` with the slug. 3. Navigate to the new project. 4. Query project agents. 5. Compare agent names with template manifest. |
| Expected Result        | Full install succeeds. New project contains the exact agents and tools described in the template's manifest. Agent names match. No data lost during the bundle→import→project pipeline.                                                           |
| Automation             | API                                                                                                                                                                                                                                               |
| Phase                  | 3                                                                                                                                                                                                                                                 |

---

## 16. Phase 3: E2E (Full User Journey) Test Cases

### TC-TS-123: User installs a project template end-to-end

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-123                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Functional Requirement | FR-28, FR-31, FR-34                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Description            | Full user journey: browse marketplace, find a project template, click install, enter project name, confirm, see post-install report with provisioning checklist, navigate to the new project                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Preconditions          | Studio and template store running. User logged in. Seed data includes a project-type template with prerequisites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Steps                  | 1. Navigate to marketplace. 2. Click a project-type template card. 3. Verify detail page shows "Create Project from Template" button. 4. Click "Create Project from Template". 5. Verify project name dialog appears. 6. Enter a project name. 7. Click submit/confirm. 8. Verify loading indicator during install. 9. Verify post-install report appears with: project name, agents created count, tools created count. 10. Verify provisioning checklist shows required env vars and connectors. 11. Click "Go to Project" link. 12. Verify navigation to the new project page. 13. Verify agents from the template are visible in the project. |
| Expected Result        | Complete install flow works end-to-end. Project is created, agents/tools imported, post-install report displays correctly, navigation to new project works. Install CTA says "Create Project from Template" (not "Add to Project").                                                                                                                                                                                                                                                                                                                                                                                                               |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### TC-TS-124: User installs an agent template into existing project

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-124                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Functional Requirement | FR-29, FR-30, FR-31, FR-34                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Description            | Full user journey: browse marketplace, find an agent template, click install, select target project, review preview, confirm, see success with provisioning checklist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Preconditions          | Studio and template store running. User logged in with at least one existing project. Seed data includes an agent-type template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Steps                  | 1. Navigate to marketplace. 2. Click an agent-type template card. 3. Verify detail page shows "Add to Project" button. 4. Click "Add to Project". 5. Verify project selector dropdown appears. 6. Select a target project from the dropdown. 7. Verify preview loads: shows agents to be added, tools to be added. 8. Review the preview — verify add/modify counts displayed. 9. Click "Confirm" to apply. 10. Verify loading state during apply. 11. Verify success message with applied counts. 12. Verify provisioning checklist (if template has prerequisites). 13. Navigate to the target project. 14. Verify the new agent from the template appears in the project's agent list. |
| Expected Result        | Agent install flow works end-to-end with preview step. Preview accurately shows what will be added. After confirm, agent and tools are merged into the existing project. Existing project content is preserved. Install CTA says "Add to Project" (not "Create Project from Template").                                                                                                                                                                                                                                                                                                                                                                                                   |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### TC-TS-125: Unauthenticated user sees login prompt on install button

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-125                                                                                                                                                                                                                                                                                                                                                                 |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                       |
| Functional Requirement | FR-32, FR-34                                                                                                                                                                                                                                                                                                                                                              |
| Description            | Full user journey: unauthenticated user visits a template detail page, sees install button in disabled/login-gated state, clicking it redirects to login                                                                                                                                                                                                                  |
| Preconditions          | Studio and template store running. User is NOT logged in (no session/JWT). Seed data includes templates.                                                                                                                                                                                                                                                                  |
| Steps                  | 1. Navigate directly to a template detail page URL (e.g., `/marketplace/templates/billing-support-agent`). 2. Verify the template detail renders (browse is public). 3. Verify the install button shows login-required state (disabled, or "Sign in to install" label). 4. Click the install button. 5. Verify user is redirected to login page or authentication prompt. |
| Expected Result        | Template detail page renders for unauthenticated users (public browse works). Install button is visible but gated — either disabled with tooltip, or shows "Sign in to install" label. Clicking triggers login flow. No install API call is made without auth.                                                                                                            |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                        |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                         |

### TC-TS-126: Post-install checklist shows all provisioning categories

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-126                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Category               | e2e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-31, FR-34                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Description            | Full user journey: after installing a template with multiple prerequisite categories, verify the post-install checklist displays all required provisioning items organized by category                                                                                                                                                                                                                                                                                                                                                                      |
| Preconditions          | Studio and template store running. User logged in. Template with `prerequisites: { envVars: ['OPENAI_API_KEY', 'DB_URL'], connectors: ['Salesforce CRM'], mcpServers: ['filesystem'], authProfiles: ['oauth-salesforce'], models: ['gpt-4o'] }`.                                                                                                                                                                                                                                                                                                            |
| Steps                  | 1. Complete a project install for the template with full prerequisites. 2. On the post-install report, verify "Required Environment Variables" section shows `OPENAI_API_KEY` and `DB_URL`. 3. Verify "Required Connectors" section shows `Salesforce CRM`. 4. Verify "Required MCP Servers" section shows `filesystem`. 5. Verify "Required Auth Profiles" section shows `oauth-salesforce`. 6. Install a different template with empty prerequisites. 7. Verify post-install report shows "No additional configuration needed" instead of empty sections. |
| Expected Result        | Post-install checklist renders all provisioning categories with the correct items. Empty categories are hidden. Template with no prerequisites shows a clean "No additional configuration needed" message. All labels use i18n keys.                                                                                                                                                                                                                                                                                                                        |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 17. Phase 3: Unit (Component) Test Cases

### TC-TS-127: InstallButton renders type-specific CTA label

| Field                  | Value                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-127                                                                                                                                                                                                                                                                         |
| Category               | positive                                                                                                                                                                                                                                                                          |
| Functional Requirement | FR-34                                                                                                                                                                                                                                                                             |
| Description            | Verify that the InstallButton component renders the correct CTA label based on template type                                                                                                                                                                                      |
| Preconditions          | Component rendered in test environment with mocked auth store.                                                                                                                                                                                                                    |
| Steps                  | 1. Render `<InstallButton template={{ type: 'project', ... }} />`. 2. Verify button text is "Create Project from Template" (or i18n equivalent). 3. Render `<InstallButton template={{ type: 'agent', ... }} />`. 4. Verify button text is "Add to Project" (or i18n equivalent). |
| Expected Result        | Project templates show "Create Project from Template". Agent templates show "Add to Project". Labels come from i18n keys.                                                                                                                                                         |
| Automation             | UI                                                                                                                                                                                                                                                                                |
| Phase                  | 3                                                                                                                                                                                                                                                                                 |

### TC-TS-128: InstallButton shows login prompt when not authenticated

| Field                  | Value                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-128                                                                                                                                                                                                                                                                 |
| Category               | positive                                                                                                                                                                                                                                                                  |
| Functional Requirement | FR-32, FR-34                                                                                                                                                                                                                                                              |
| Description            | Verify that the InstallButton shows a disabled or login-gated state when the user is not authenticated                                                                                                                                                                    |
| Preconditions          | Auth store returns `isAuthenticated: false`.                                                                                                                                                                                                                              |
| Steps                  | 1. Render `<InstallButton template={{ type: 'project', ... }} />` with unauthenticated state. 2. Verify button is disabled or shows "Sign in to install" label. 3. Click the button. 4. Verify click handler does not fire install action (fires login redirect instead). |
| Expected Result        | Button indicates login is required. Clicking does not trigger install API. User is directed to sign in.                                                                                                                                                                   |
| Automation             | UI                                                                                                                                                                                                                                                                        |
| Phase                  | 3                                                                                                                                                                                                                                                                         |

### TC-TS-129: ProjectInstallDialog validates input and submits

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-129                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Category               | positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Functional Requirement | FR-28, FR-34                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Description            | Verify that the ProjectInstallDialog renders name/slug inputs, validates input, and submits the correct payload                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Preconditions          | Dialog rendered with template prop `{ slug: "test-template", latestVersion: "1.0.0" }`. Mock API handler.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Steps                  | 1. Verify dialog renders with name input and slug preview. 2. Submit button is disabled when name is empty. 3. Type a project name — verify slug is auto-generated. 4. Verify submit button becomes enabled. 5. Click submit. 6. Verify API call with `{ templateSlug: "test-template", version: "1.0.0", projectName: "<entered>", projectSlug: "<auto-generated>" }`. 7. Verify loading state shown during API call. 8. Clear name input — verify submit disabled again. 9. Click cancel — verify dialog closes without API call. |
| Expected Result        | Dialog validates required name. Slug auto-generates from name. Submit sends correct payload. Cancel closes without side effects. Loading state shown during submission.                                                                                                                                                                                                                                                                                                                                                             |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### TC-TS-130: AgentInstallDialog shows project selector and preview

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-130                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Category               | positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Functional Requirement | FR-29, FR-30, FR-34                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Description            | Verify that the AgentInstallDialog renders a project selector, fetches a preview on project selection, displays add/modify counts, and allows confirm/cancel                                                                                                                                                                                                                                                                                                                                                                                      |
| Preconditions          | Dialog rendered with template prop. User has 3 projects. Mock API returns preview data.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Steps                  | 1. Verify dialog renders with a project selector dropdown. 2. Verify confirm button is disabled before project selection. 3. Select a project. 4. Verify preview API is called with `{ templateSlug, version, projectId }`. 5. Verify preview results display: "1 agent to be added", "2 tools to be added". 6. Verify confirm button is now enabled. 7. Click confirm. 8. Verify apply API is called with `{ templateSlug, version, projectId, previewDigest }`. 9. Click cancel instead of confirm — verify dialog closes, no apply API called. |
| Expected Result        | Project selector populates with user's projects. Selecting a project triggers preview. Preview results show accurate add/modify counts. Confirm fires apply. Cancel exits cleanly.                                                                                                                                                                                                                                                                                                                                                                |
| Automation             | UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Phase                  | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## 18. Phase 3: Integration Regression Test Cases (Bugs Found During Manual Testing)

These test cases were added on 2026-05-13 after 5 bugs were discovered during manual testing of the install flow. They target specific gaps in the test suite that allowed these bugs to ship undetected.

### TC-TS-131: Public browse endpoint returns 200 when foreign JWT is in Authorization header

| Field                  | Value                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-ID                  | TC-TS-131                                                                                                                                                                                                                                                                            |
| Category               | integration                                                                                                                                                                                                                                                                          |
| Functional Requirement | FR-35                                                                                                                                                                                                                                                                                |
| Description            | Verify that the public browse endpoint returns 200 (not 401) when the Authorization header contains a JWT signed by a different service (e.g., Studio's JWT forwarded to template-store). The test server MUST include `optionalAuth` middleware.                                    |
| Preconditions          | Template store Express server running WITH `optionalAuth` middleware in the chain (not the simplified test server). At least one published template seeded. A JWT signed with a different secret than template-store's configured secret (simulating Studio forwarding its own JWT). |
| Steps                  | 1. Build Express app with `optionalAuth` -> `rateLimiter` -> `marketplaceRouter` middleware chain (matching production). 2. Seed one published template. 3. `GET /api/v1/marketplace/templates` with `Authorization: Bearer <foreign-jwt>`. 4. Inspect response status and body.     |
| Expected Result        | HTTP 200. Response body: `{ success: true, data: { templates: [...] } }` with at least one template. The `optionalAuth` middleware silently ignores the unverifiable JWT and continues without user context. No 401 error.                                                           |
| Automation             | API                                                                                                                                                                                                                                                                                  |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                         |
| Bug Reference          | Bug 1 — Foreign JWT causes 401 on public endpoints                                                                                                                                                                                                                                   |

### TC-TS-132: Public bundle endpoint returns 200 when foreign JWT is in Authorization header

| Field                  | Value                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-132                                                                                                                                                                                                                                                                         |
| Category               | integration                                                                                                                                                                                                                                                                       |
| Functional Requirement | FR-35                                                                                                                                                                                                                                                                             |
| Description            | Verify that the public bundle endpoint returns 200 when a foreign JWT is present. This is the endpoint Studio calls server-to-server during install.                                                                                                                              |
| Preconditions          | Template store server WITH `optionalAuth` middleware. Published template with version and `files` bundle. Foreign JWT.                                                                                                                                                            |
| Steps                  | 1. Seed a template with slug `foreign-jwt-bundle`, version `1.0.0`, with `files` containing a `project.json` and agent ABL file. 2. `GET /api/v1/marketplace/templates/foreign-jwt-bundle/versions/1.0.0/bundle` with `Authorization: Bearer <foreign-jwt>`. 3. Inspect response. |
| Expected Result        | HTTP 200. Response body: `{ success: true, data: { files: { "project.json": "...", ... } } }`. Bundle content is returned regardless of the unverifiable JWT.                                                                                                                     |
| Automation             | API                                                                                                                                                                                                                                                                               |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                      |
| Bug Reference          | Bug 1 — Foreign JWT causes 401 on public endpoints                                                                                                                                                                                                                                |

### TC-TS-133: Public detail endpoint returns 200 when foreign JWT is in Authorization header

| Field                  | Value                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-133                                                                                                                                                                     |
| Category               | integration                                                                                                                                                                   |
| Functional Requirement | FR-35                                                                                                                                                                         |
| Description            | Verify that the public detail endpoint returns 200 when a foreign JWT is present                                                                                              |
| Preconditions          | Template store server WITH `optionalAuth` middleware. Published template. Foreign JWT.                                                                                        |
| Steps                  | 1. Seed a template with slug `foreign-jwt-detail`. 2. `GET /api/v1/marketplace/templates/foreign-jwt-detail` with `Authorization: Bearer <foreign-jwt>`. 3. Inspect response. |
| Expected Result        | HTTP 200. Response body: `{ success: true, data: { template: { slug: "foreign-jwt-detail", ... } } }`. Template detail returned normally despite the unverifiable JWT.        |
| Automation             | API                                                                                                                                                                           |
| Phase                  | 3-regression                                                                                                                                                                  |
| Bug Reference          | Bug 1 — Foreign JWT causes 401 on public endpoints                                                                                                                            |

### TC-TS-134: Seed template ABL files pass import-validator syntax validation

| Field                  | Value                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-134                                                                                                                                                                                                                                                                                                                                           |
| Category               | integration                                                                                                                                                                                                                                                                                                                                         |
| Functional Requirement | FR-36                                                                                                                                                                                                                                                                                                                                               |
| Description            | Verify that ALL agent ABL files in ALL seed template bundles pass `validateAgentSyntax()` from the import pipeline. This catches format mismatches between the seed script's DSL output and what the import pipeline accepts (e.g., `AGENT supervisor` vs `AGENT: supervisor`).                                                                     |
| Preconditions          | Seed script has been run against a test MongoMemoryServer. `validateAgentSyntax` imported from `@agent-platform/project-io/import`. All seed template versions have non-empty `files` bundles.                                                                                                                                                      |
| Steps                  | 1. Run seed script against MongoMemoryServer. 2. Query all `TemplateVersion` documents with non-empty `files`. 3. For each version, iterate over `files` entries where the key matches `agents/*.agent.abl` or ends in `.abl`. 4. For each ABL file, call `validateAgentSyntax(filePath, fileContent)`. 5. Collect all errors across all templates. |
| Expected Result        | Zero validation errors across all seed templates. Every ABL file uses the colon syntax (`AGENT: name` / `SUPERVISOR: name`) that the import pipeline requires. No `E_IMPORT_AGENT_SYNTAX` errors.                                                                                                                                                   |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                 |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                                                                                        |
| Bug Reference          | Bug 2 — ABL DSL syntax (missing colon in AGENT header)                                                                                                                                                                                                                                                                                              |

### TC-TS-135: Seed template bundles pass full dry-run import without blocking issues

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-135                                                                                                                                                                                                                                                                                                                                                                                                       |
| Category               | integration                                                                                                                                                                                                                                                                                                                                                                                                     |
| Functional Requirement | FR-38                                                                                                                                                                                                                                                                                                                                                                                                           |
| Description            | Verify that every seed template's full `files` bundle passes a dry-run import via the real import pipeline. This is the round-trip test: seed -> extract bundle -> import pipeline -> assert no blocking issues. Catches problems beyond syntax (e.g., missing `project.json`, manifest schema issues, cross-reference errors).                                                                                 |
| Preconditions          | Seed script run against test MongoMemoryServer. A fresh test project created for each dry-run. Import pipeline available (`previewStudioLayeredImportV2` or `importProjectV2` with `dryRun: true`).                                                                                                                                                                                                             |
| Steps                  | 1. Run seed script against MongoMemoryServer. 2. For each seed template version with `files`, create a fresh test project. 3. Convert `files` Record to `Map<string, string>`. 4. Call the import preview function with `{ files: fileMap, projectId, tenantId, userId, conflictStrategy: 'replace' }`. 5. Inspect the preview result for blocking issues. 6. Collect all blocking issues across all templates. |
| Expected Result        | Every seed template's bundle produces `hasBlockingIssues === false` on dry-run import. Zero syntax errors. Non-blocking warnings may be present (and that's acceptable — the install flow auto-acknowledges them). The bundle -> import pipeline round-trip succeeds for every seed template.                                                                                                                   |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bug Reference          | Bug 2 — Validates seed content survives the full import pipeline                                                                                                                                                                                                                                                                                                                                                |

### TC-TS-136: Project install succeeds with real import pipeline (not mocked)

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-136                                                                                                                                                                                                                                                                                                                                                                       |
| Category               | integration                                                                                                                                                                                                                                                                                                                                                                     |
| Functional Requirement | FR-28, FR-37                                                                                                                                                                                                                                                                                                                                                                    |
| Description            | Verify that project template install works end-to-end using the REAL `previewStudioLayeredImportV2` and `applyStudioLayeredImportV2` functions (not mocked). This catches the acknowledgement bug where `applyStudioLayeredImportV2` requires `previewDigest` + `acknowledgedIssueIds` when the preview contains non-blocking issues.                                           |
| Preconditions          | Published template with valid `files` bundle containing real ABL DSL (correct syntax). Template store running (or mocked at HTTP level only). Authenticated user with `project:create` permission. MongoMemoryServer for project data.                                                                                                                                          |
| Steps                  | 1. Seed a published template with a bundle containing `project.json` (valid ManifestV2), 1+ agent ABL files (with colon syntax), and optionally tool YAML files. 2. `POST /api/template-install/project` with `{ templateSlug, version, projectName }` and valid JWT. 3. Verify HTTP 201. 4. Query the new project's agents. 5. Verify agent count matches the template bundle. |
| Expected Result        | HTTP 201. Project created. All agents from the bundle exist in the project. The route correctly ran preview, auto-acknowledged non-blocking issues, and applied with the preview digest. No `IMPORT_FAILED` or `IMPORT_BLOCKED` error.                                                                                                                                          |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                             |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                                                                                                                    |
| Bug Reference          | Bug 3 — Import preview acknowledgement required                                                                                                                                                                                                                                                                                                                                 |

### TC-TS-137: Agent install succeeds with real import pipeline (not mocked)

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-137                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Category               | integration                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Functional Requirement | FR-29, FR-37                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Description            | Verify that agent template install (preview + apply) works end-to-end using the REAL import pipeline functions. Catches the same acknowledgement bug as TC-TS-136 but on the agent install path.                                                                                                                                                                                                                                       |
| Preconditions          | Published agent-type template with valid `files` bundle. Target project exists with at least one existing agent. Authenticated user. MongoMemoryServer.                                                                                                                                                                                                                                                                                |
| Steps                  | 1. Seed agent template with valid bundle. Create target project with one existing agent. 2. `POST /api/template-install/agent/[id]/preview` with valid JWT. 3. Extract `previewDigest` from response. 4. `POST /api/template-install/agent/[id]/apply` with `{ templateSlug, version, projectId, previewDigest }`. 5. Verify HTTP 200. 6. Query project agents. 7. Verify the template's agent was added alongside the existing agent. |
| Expected Result        | Preview returns valid digest. Apply succeeds (HTTP 200). Project now has both the original agent and the template's agent. Merge strategy preserved existing content. The route correctly auto-acknowledged non-blocking issues during apply.                                                                                                                                                                                          |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Bug Reference          | Bug 4 — Same acknowledgement issue on agent apply route                                                                                                                                                                                                                                                                                                                                                                                |

### TC-TS-138: Install succeeds when import preview produces non-blocking warnings

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-138                                                                                                                                                                                                                                                                                                                                                                                                               |
| Category               | integration                                                                                                                                                                                                                                                                                                                                                                                                             |
| Functional Requirement | FR-37                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Description            | Explicitly verify the auto-acknowledgement mechanism: when a template bundle produces non-blocking warnings during import preview, the install route auto-acknowledges them and proceeds to apply successfully. This is the specific behavior that was missing before the bug fix.                                                                                                                                      |
| Preconditions          | Published template whose bundle intentionally produces non-blocking import warnings (e.g., a fresh project import typically produces ~24 non-blocking warnings for missing optional fields, deprecation notices, etc.). Authenticated user. Real import pipeline (not mocked).                                                                                                                                          |
| Steps                  | 1. Seed a template with a bundle that is known to produce non-blocking import warnings on preview. 2. `POST /api/template-install/project` with valid auth. 3. Verify HTTP 201 (not 400 or 500). 4. Verify project was created with imported agents/tools. 5. Optionally verify via logs or response that auto-acknowledgement occurred (the route logs "Auto-acknowledging non-blocking issues for template install"). |
| Expected Result        | HTTP 201. Project created and fully populated. Non-blocking warnings were auto-acknowledged by the install route. The user did NOT need to manually acknowledge anything. The `acknowledgedIssueIds` array passed to `applyStudioLayeredImportV2` contained the IDs of all non-blocking issues from the preview.                                                                                                        |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                                                                                                                                                            |
| Bug Reference          | Bugs 3 & 4 — Import preview acknowledgement required on both project and agent install                                                                                                                                                                                                                                                                                                                                  |

### TC-TS-139: Install fails with clear error when template bundle has blocking syntax issues

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ID                  | TC-TS-139                                                                                                                                                                                                                                                                                                                                                                                                           |
| Category               | negative                                                                                                                                                                                                                                                                                                                                                                                                            |
| Functional Requirement | FR-28, FR-36                                                                                                                                                                                                                                                                                                                                                                                                        |
| Description            | Verify that project install returns a clear error when the template bundle contains ABL content with blocking syntax issues (e.g., malformed AGENT header). This verifies the error path that would have caught Bug 2 if the seed data had been validated.                                                                                                                                                          |
| Preconditions          | Published template with intentionally malformed ABL content in the bundle (e.g., `AGENT supervisor` without colon, which passes storage but fails import validation). Authenticated user.                                                                                                                                                                                                                           |
| Steps                  | 1. Seed a template with a bundle where agent ABL files use `AGENT supervisor` (no colon) instead of `AGENT: supervisor`. 2. `POST /api/template-install/project` with valid auth. 3. Inspect response.                                                                                                                                                                                                              |
| Expected Result        | HTTP 400 with `{ success: false, error: { code: "IMPORT_BLOCKED", message: "Template bundle has blocking validation issues", blockingIssues: [...] } }`. The `blockingIssues` array includes at least one issue with `code: "E_IMPORT_AGENT_SYNTAX"`. The project may or may not have been created (empty) — the import was blocked. The response clearly indicates a content problem, not an auth or server error. |
| Automation             | API                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Phase                  | 3-regression                                                                                                                                                                                                                                                                                                                                                                                                        |
| Bug Reference          | Bug 2 — Validates the error path for malformed ABL content                                                                                                                                                                                                                                                                                                                                                          |

---

## Test Coverage Summary

### Coverage by Functional Requirement

#### Phase 1 (FR-1 through FR-15)

| FR    | Description                      | Test Cases                                                  | Count |
| ----- | -------------------------------- | ----------------------------------------------------------- | ----- |
| FR-1  | Public browse API (paginated)    | TC-TS-001, 015, 018, 021, 022, 023, 024, 025, 032, 046      | 10    |
| FR-2  | Filters and search               | TC-TS-002, 003, 004, 005, 006, 019, 026, 027, 041, 045, 054 | 11    |
| FR-3  | Template detail by slug          | TC-TS-007, 016, 028, 043, 055, 056                          | 6     |
| FR-4  | Categories endpoint              | TC-TS-008, 030, 042, 065                                    | 4     |
| FR-5  | Featured endpoint                | TC-TS-009, 031, 040                                         | 3     |
| FR-6  | View count increment             | TC-TS-010, 029, 043                                         | 3     |
| FR-7  | Analytics events + TTL           | TC-TS-011, 012, 036, 051, 052, 053                          | 6     |
| FR-8  | Rate limiting                    | TC-TS-017                                                   | 1     |
| FR-9  | Request ID header                | TC-TS-013, 037                                              | 2     |
| FR-10 | Standard error format            | TC-TS-014, 016, 017, 018, 019, 020, 071, 072, 073           | 9     |
| FR-11 | Studio proxy                     | TC-TS-033, 034, 037, 085                                    | 4     |
| FR-12 | Sidebar navigation               | TC-TS-040, 049                                              | 2     |
| FR-13 | Landing page layout              | TC-TS-040, 044, 050, 058                                    | 4     |
| FR-14 | Template card badges and metrics | TC-TS-040, 041, 047, 048, 089                               | 5     |
| FR-15 | Composable detail sections       | TC-TS-040, 043, 055, 056, 058, 090, 094                     | 7     |

#### Phase 2 (FR-16 through FR-27)

| FR    | Description                          | Test Cases                              | Count |
| ----- | ------------------------------------ | --------------------------------------- | ----- |
| FR-16 | TemplateVersion.files bundle storage | TC-TS-067, 092                          | 2     |
| FR-17 | TemplateVersion.manifest ManifestV2  | TC-TS-066, 092                          | 2     |
| FR-18 | Browse excludes `files` (projection) | TC-TS-059                               | 1     |
| FR-19 | Bundle endpoint                      | TC-TS-060, 071, 072, 073, 085, 088, 092 | 7     |
| FR-20 | Prerequisites field                  | TC-TS-062, 070, 079, 084, 091           | 5     |
| FR-21 | `media[]` replaces `screenshots[]`   | TC-TS-061, 078, 080, 081, 083, 090, 094 | 7     |
| FR-22 | `reviewStatus` field                 | TC-TS-063, 074, 075, 088                | 4     |
| FR-23 | Type filter tabs                     | TC-TS-064, 065, 082, 089, 093, 095      | 6     |
| FR-24 | Prerequisites display on detail page | TC-TS-062, 079, 084, 091, 095           | 5     |
| FR-25 | Seed script with files + manifests   | TC-TS-069, 070                          | 2     |
| FR-26 | Bundle size validation (4MB max)     | TC-TS-077                               | 1     |
| FR-27 | Static media serving                 | TC-TS-068, 076, 086, 087, 090           | 5     |

#### Phase 3 (FR-28 through FR-34)

| FR    | Description                              | Test Cases                                                                 | Count |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------- | ----- |
| FR-28 | Project template install (one-step)      | TC-TS-096, 097, 106, 107, 108, 109, 113, 114, 120, 122, 123, 129, 136, 139 | 14    |
| FR-29 | Agent template install (preview + apply) | TC-TS-098, 099, 102, 104, 107, 110, 111, 115, 116, 121, 122, 124, 130, 137 | 14    |
| FR-30 | Agent install preview (add/modify)       | TC-TS-104, 115, 116, 124, 130                                              | 5     |
| FR-31 | Post-install report + provisioning       | TC-TS-100, 105, 117, 123, 124, 126                                         | 6     |
| FR-32 | Auth gating (browse public, install JWT) | TC-TS-106, 107, 110, 118, 121, 125, 128                                    | 7     |
| FR-33 | Install count + analytics                | TC-TS-101, 102, 103, 119                                                   | 4     |
| FR-34 | Install UI (CTA, dialogs, flow)          | TC-TS-123, 124, 125, 126, 127, 128, 129, 130                               | 8     |

#### Phase 3 Integration Regression (FR-35 through FR-38)

| FR    | Description                                         | Test Cases          | Count |
| ----- | --------------------------------------------------- | ------------------- | ----- |
| FR-35 | Public endpoints tolerate foreign/invalid JWTs      | TC-TS-131, 132, 133 | 3     |
| FR-36 | Seed template ABL content passes import validation  | TC-TS-134, 139      | 2     |
| FR-37 | Install routes auto-acknowledge non-blocking issues | TC-TS-136, 137, 138 | 3     |
| FR-38 | Seed bundles pass full dry-run import pipeline      | TC-TS-135           | 1     |

### Coverage by Category

| Category              | Test Cases                                  | Count   |
| --------------------- | ------------------------------------------- | ------- |
| Positive (Ph1)        | TC-TS-001 through 015, 047 through 056, 058 | 26      |
| Positive (Ph2)        | TC-TS-059 through 070                       | 12      |
| Positive (Ph3)        | TC-TS-096 through 105, 127 through 130      | 14      |
| Negative (Ph1)        | TC-TS-016 through 023                       | 8       |
| Negative (Ph2)        | TC-TS-071 through 076                       | 6       |
| Negative (Ph3)        | TC-TS-106 through 112, 139                  | 8       |
| Boundary (Ph1)        | TC-TS-024 through 032                       | 9       |
| Boundary (Ph2)        | TC-TS-077 through 084                       | 8       |
| Boundary (Ph3)        | TC-TS-113 through 119                       | 7       |
| Integration (Ph1)     | TC-TS-033 through 039, 057                  | 8       |
| Integration (Ph2)     | TC-TS-085 through 088                       | 4       |
| Integration (Ph3)     | TC-TS-120 through 122                       | 3       |
| Integration (Ph3-reg) | TC-TS-131 through 138                       | 8       |
| E2E (Ph1)             | TC-TS-040 through 046                       | 7       |
| E2E (Ph2)             | TC-TS-089 through 095                       | 7       |
| E2E (Ph3)             | TC-TS-123 through 126                       | 4       |
| **Total**             |                                             | **139** |

### Minimum Coverage Targets vs. Actuals

| Target                                          | Required | Actual     | Status                                                                      |
| ----------------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------- |
| Test cases per FR (min 2)                       | 2        | 1-14       | All FRs have 1+ (FR-8, FR-18, FR-26, FR-38 have 1 each; all others have 2+) |
| Boundary/edge cases (min 5)                     | 5        | 24 (9+8+7) | PASS                                                                        |
| Negative cases (min 5)                          | 5        | 22 (8+6+8) | PASS                                                                        |
| E2E scenarios (min 5)                           | 5        | 18 (7+7+4) | PASS                                                                        |
| Total test cases (min 30)                       | 30       | 139        | PASS                                                                        |
| Phase 2 FRs covered (FR-16 to FR-27)            | 12       | 12         | PASS — all Phase 2 FRs have at least 1 test case                            |
| Phase 3 FRs covered (FR-28 to FR-34)            | 7        | 7          | PASS — all Phase 3 FRs have at least 4 test cases                           |
| Phase 3 Regression FRs covered (FR-35 to FR-38) | 4        | 4          | PASS — all regression FRs have at least 1 test case                         |
