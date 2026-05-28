# SearchAI Runtime API Documentation

## Overview

This directory contains the OpenAPI 3.0 specification for the SearchAI Runtime REST API.

## Viewing the Documentation

### Option 1: Swagger UI (Recommended)

Use the online Swagger Editor to view and interact with the API:

1. Open https://editor.swagger.io/
2. Go to **File > Import File**
3. Select `openapi.yaml` from this directory

### Option 2: VS Code Extension

Install the **OpenAPI (Swagger) Editor** extension:

1. Install extension: `42Crunch.vscode-openapi`
2. Open `openapi.yaml` in VS Code
3. Click the preview icon in the top right

### Option 3: Redoc

Generate static HTML documentation:

```bash
npx @redocly/cli build-docs openapi.yaml -o api-docs.html
open api-docs.html
```

### Option 4: Local Swagger UI Server

Run a local Swagger UI server:

```bash
npm install -g swagger-ui-serve
swagger-ui-serve openapi.yaml
```

Then open http://localhost:8080

## API Groups

### Vocabulary Management (API-1 to API-6)

CRUD operations for vocabulary entries embedded in DomainVocabulary documents.

**Endpoints:**

- `GET /projects/:projectId/kb/:kbId/vocabulary` - List entries
- `POST /projects/:projectId/kb/:kbId/vocabulary` - Create entry
- `PUT /projects/:projectId/kb/:kbId/vocabulary/:entryId` - Update entry
- `DELETE /projects/:projectId/kb/:kbId/vocabulary/:entryId` - Delete entry
- `PATCH /projects/:projectId/kb/:kbId/vocabulary/:entryId/toggle` - Toggle entry
- `POST /projects/:projectId/kb/:kbId/vocabulary/test` - Test resolution

**Key Features:**

- Embedded document CRUD using MongoDB array operators
- Usage tracking prevents deletion of recently used entries (30 day window)
- Duplicate term detection
- Search in term and aliases
- Pagination support

### Agent Integration (API-7, API-8)

Download-first pattern endpoints for agents to minimize LLM costs.
Agents download context once and use it locally for query classification and vocabulary resolution.

**Endpoints:**

- `GET /projects/:projectId/kb/:kbId/query-types` - Download classification examples (API-7)
- `GET /projects/:projectId/kb/:kbId/vocabulary-context` - Download vocabulary + schema (API-8)

**Key Features:**

- Agents download context once per session
- Query types: structured, semantic, hybrid, aggregation
- Caching: 1 hour for static examples, 5 minutes for vocabulary
- Connector-specific examples (generic, jira, etc.)
- Agents call the unified `/api/search/:indexId/query` endpoint to execute searches with all 4 query types

### Capability Management (API-11 to API-16)

Admin-only CRUD operations for system capabilities.

**Endpoints:**

- `GET /capabilities` - List capabilities
- `GET /capabilities/:capabilityId` - Get by ID
- `POST /capabilities` - Create (admin only)
- `PUT /capabilities/:capabilityId` - Update (admin only)
- `POST /capabilities/:capabilityId/toggle` - Toggle (admin only)
- `DELETE /capabilities/:capabilityId` - Delete (admin only)

**Key Features:**

- LRU caching with 10min TTL
- Admin role required for mutations (admin or owner)
- Capability types: aggregation, operator, sort
- Zod validation

## Authentication

All endpoints require Bearer token authentication:

```
Authorization: Bearer <jwt-token>
```

## Tenant Isolation

All operations are scoped to the authenticated user's tenant. Cross-tenant access returns 404 (not 403) to avoid leaking resource existence.

## Standard Response Format

### Success Response

```json
{
  "success": true,
  "data": {
    // Response data
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": [] // Optional validation details
  }
}
```

## Error Codes

### Common Errors

- `UNAUTHORIZED` - Missing or invalid authentication
- `FORBIDDEN` - Insufficient permissions (admin required)
- `VALIDATION_ERROR` - Request validation failed
- `INTERNAL_ERROR` - Unexpected server error

### Vocabulary Management

- `VOCABULARY_NOT_FOUND` - No vocabulary exists for KB
- `ENTRY_NOT_FOUND` - Vocabulary entry not found
- `DUPLICATE_TERM` - Entry with term already exists
- `ENTRY_IN_USE` - Cannot delete entry used in last 30 days

### Capability Management

- `CAPABILITY_NOT_FOUND` - Capability not found
- `DUPLICATE_NAME` - Capability with name already exists

## Cache Headers

Responses include appropriate cache headers:

- Query types (API-7): `Cache-Control: public, max-age=3600` (1 hour)
- Vocabulary context (API-8): `Cache-Control: public, max-age=300` (5 minutes)

## Validation Rules

### Vocabulary Entry

- **term**: 2-50 characters
- **aliases**: max 10 items
- **description**: max 500 characters
- **capabilities**: at least one must be true
- **displayWith**: max 30 fields
- **aggregateWith**: max 10 fields

### Capability

- **name**: 1-50 characters
- **description**: 1-500 characters
- **triggerKeywords**: 1-20 items
- **examples**: 1-10 items
- **supportedFieldTypes**: at least 1 item

## Testing

Use the test files in `src/routes/__tests__/` to see example request/response patterns:

- `vocabulary.routes.test.ts` - 24 tests for vocabulary management
- `agent-integration.routes.test.ts` - 14 tests for agent integration (API-7, API-8)
- `capabilities.routes.test.ts` - 25 tests for capability management

## Implementation Status

### Implemented

- API-1 to API-6: Vocabulary Management (6 endpoints)
- API-7 to API-8: Agent Integration (2 endpoints)
- API-11 to API-16: Capability Management (6 endpoints)
- Unified search pipeline: `POST /api/search/:indexId/query` supports all 4 query types (structured, semantic, hybrid, aggregation) with optional auto-classification via LLM

## Related Documentation

- Design Document: `docs/searchai/rfcs/canonical-mapping/03-DESIGN-DETAILED.md`
- Database Schema: `docs/searchai/DATABASE-SCHEMA.md`
- Implementation Plan: `docs/searchai/rfcs/canonical-mapping/IMPLEMENTATION-PLAN.md`

## Contact

For questions or issues, contact the Agent Platform Team.
