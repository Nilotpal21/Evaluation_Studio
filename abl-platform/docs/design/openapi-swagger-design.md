# OpenAPI / Swagger Design Document

**Author:** Platform Team
**Date:** 2025-02-14
**Status:** Draft
**Scope:** Runtime (Express) + Studio (Next.js)

---

## 1. Problem Statement

The ABL Platform exposes **~105 REST endpoints** via the Runtime (Express) and **~117 endpoints** via Studio (Next.js). Currently, these APIs lack machine-readable documentation, making it difficult for:

- **Developers** to discover and test available endpoints
- **SDK consumers** to understand request/response contracts
- **QA teams** to generate test cases from contracts
- **External integrations** (A2A, webhooks) to validate payloads

---

## 2. Goals

| Goal | Description                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------- |
| G1   | Every public endpoint has an OpenAPI 3.0 spec entry with summary, request schema, and response schema |
| G2   | Swagger UI is served at `/docs` (Runtime) and `/api/openapi` (Studio)                                 |
| G3   | Schemas are Zod-first — the same Zod objects that validate at runtime also generate the spec          |
| G4   | Adding OpenAPI metadata to a new route requires < 5 lines of code                                     |
| G5   | Zero impact on request/response performance (schemas are only used at spec-generation time)           |

---

## 3. Architecture

### 3.1 Package: `@agent-platform/openapi`

A shared package (`packages/openapi/`) that provides framework-agnostic OpenAPI infrastructure.

```
@agent-platform/openapi
├── Root exports        createRouteRegistry(), types
├── /express            createOpenAPIRouter(), serveOpenAPIDocs(), introspectExpressRoutes()
└── /nextjs             withOpenAPI(), scanNextjsRoutes()
```

**Core dependencies:**

- `zod` — Runtime schema validation
- `@asteasolutions/zod-to-openapi` — Zod → OpenAPI 3.0 spec generator

### 3.2 Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Developer writes                       │
│                                                           │
│   Zod schemas (body, response, params, query)            │
│                                                           │
└──────────────────┬────────────────────┬──────────────────┘
                   │                    │
        ┌──────────▼──────────┐  ┌──────▼──────────────┐
        │  Express Runtime    │  │  Next.js Studio      │
        │                     │  │                      │
        │  createOpenAPIRouter│  │  withOpenAPI(schema,  │
        │  (registry, opts)   │  │    handler)          │
        │                     │  │                      │
        │  openapi.route(     │  │  export const POST = │
        │    method, path,    │  │    withOpenAPI({...}, │
        │    schema, handler) │  │      handler)        │
        └──────────┬──────────┘  └──────┬──────────────┘
                   │                    │
                   ▼                    ▼
        ┌─────────────────────────────────────────┐
        │         RouteRegistry (singleton)         │
        │                                           │
        │  registerRoute(method, path, schema)      │
        │  generateSpec(options) → OpenAPI 3.0 JSON │
        └──────────────────┬────────────────────────┘
                           │
                           ▼
        ┌─────────────────────────────────┐
        │  Swagger UI (CDN-loaded)         │
        │                                  │
        │  Runtime: GET /docs              │
        │  Studio:  GET /api/openapi       │
        └─────────────────────────────────┘
```

### 3.3 Key Types

```typescript
// RouteSchema — attached to every route
interface RouteSchema {
  summary?: string; // Brief description for Swagger UI
  description?: string; // Detailed docs (markdown supported)
  tags?: string[]; // Grouping in Swagger UI
  params?: ZodType; // Path parameters (auto-derived if not set)
  query?: ZodType; // Query string schema
  body?: ZodType; // JSON request body (POST/PUT/PATCH)
  response?: ZodType; // Success response body
  successStatus?: number; // HTTP status code (default: 200)
  auth?: boolean; // Requires Bearer JWT (default: true)
  responseContentType?: string; // e.g., 'text/event-stream' for SSE
}
```

---

## 4. Integration Patterns

### 4.1 Runtime (Express) — `createOpenAPIRouter`

**Before (plain Express):**

```typescript
import { Router } from 'express';
const router = Router();

router.post('/', async (req, res) => {
  const { name } = req.body;
  const project = await createProject(name);
  res.status(201).json({ success: true, project });
});

export default router;
```

**After (OpenAPI-annotated):**

```typescript
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects',
  tags: ['Projects'],
});

openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new project',
    body: z.object({
      name: z.string().describe('Project name'),
    }),
    response: z.object({
      success: z.boolean(),
      project: z.object({
        id: z.string(),
        name: z.string(),
        createdAt: z.string(),
      }),
    }),
    successStatus: 201,
  },
  async (req, res) => {
    const { name } = req.body;
    const project = await createProject(name);
    res.status(201).json({ success: true, project });
  },
);

export default openapi.router;
```

**Key points:**

- Handler logic is unchanged — only the registration wrapper changes
- `basePath` + route path forms the full OpenAPI path (e.g., `/api/projects` + `/` = `/api/projects`)
- Path params are auto-derived from Express `:param` syntax
- Mixed mode: `openapi.route()` and `router.get()` can coexist on the same router

### 4.2 Studio (Next.js) — `withOpenAPI`

**Before (plain Next.js):**

```typescript
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const project = await createProject(body.name);
  return NextResponse.json({ success: true, project }, { status: 201 });
}
```

**After (OpenAPI-annotated):**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { z } from 'zod';

export const POST = withOpenAPI(
  {
    summary: 'Create a new project',
    body: z.object({
      name: z.string().describe('Project name'),
    }),
    response: z.object({
      success: z.boolean(),
      project: z.object({
        id: z.string(),
        name: z.string(),
        createdAt: z.string(),
      }),
    }),
    successStatus: 201,
  },
  async (request: NextRequest) => {
    const body = await request.json();
    const project = await createProject(body.name);
    return NextResponse.json({ success: true, project }, { status: 201 });
  },
);
```

**Key points:**

- `withOpenAPI()` is a transparent decorator — zero runtime overhead
- The handler is returned unchanged; metadata is stored on a symbol property
- `scanNextjsRoutes()` dynamically imports all `route.ts` files and extracts metadata
- Routes without `withOpenAPI()` still appear in the spec with basic method + path info

### 4.3 Registry Singleton

**Runtime** (`apps/runtime/src/openapi/registry.ts`):

```typescript
import { createRouteRegistry } from '@agent-platform/openapi';
export const runtimeRegistry = createRouteRegistry();
```

**Studio** — registry is created on-demand in the spec endpoint:

```typescript
// apps/studio/src/app/api/openapi/spec.json/route.ts
const registry = createRouteRegistry();
await scanNextjsRoutes(registry, { apiDir: join(process.cwd(), 'src/app/api') });
const spec = registry.generateSpec({ title: 'Agent Studio API', version: '1.0.0' });
```

### 4.4 Spec Serving

| App     | Endpoint                     | Mechanism                                                                            |
| ------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| Runtime | `GET /docs`                  | `serveOpenAPIDocs()` Express middleware — serves Swagger UI HTML + `/docs/spec.json` |
| Runtime | `GET /docs/spec.json`        | JSON spec from registry                                                              |
| Studio  | `GET /api/openapi`           | Next.js page route — serves Swagger UI HTML                                          |
| Studio  | `GET /api/openapi/spec.json` | Next.js API route — scans routes + generates JSON spec                               |

Swagger UI is loaded from CDN (`unpkg.com/swagger-ui-dist@5/`) — no bundled assets.

---

## 5. Auto-Generated Behaviors

The registry automatically provides:

| Feature             | Behavior                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| **Path params**     | Auto-derived from Express `:id` or Next.js `[id]` syntax — no manual `params` schema needed |
| **Tags**            | Auto-derived from first path segment if not specified (`/api/chat/stream` → `Chat`)         |
| **Error responses** | 401 (Unauthorized) and 500 (Server Error) added to every route automatically                |
| **Security**        | BearerAuth (JWT) security scheme applied by default; disable with `auth: false`             |
| **Deduplication**   | Routes registered twice (same method + path) are silently skipped                           |

---

## 6. Route Inventory

### 6.1 Runtime — 24 files, ~105 endpoints

| Tag                | Route File                    | Endpoints | Description                                         |
| ------------------ | ----------------------------- | --------- | --------------------------------------------------- |
| Sessions           | `sessions.ts`                 | 8         | Session CRUD, reset, traces, analysis               |
| Chat               | `chat.ts`                     | 4         | Stream, complete, usage, agent chat                 |
| Transcripts        | `transcripts.ts`              | 4         | Conversation transcript CRUD                        |
| Auth               | `auth.ts`                     | 1         | Dev login                                           |
| Device Auth        | `device-auth.ts`              | 4         | Device code flow (create, lookup, authorize, token) |
| OAuth              | `oauth.ts`                    | 4         | Provider OAuth flow (authorize, callback, tokens)   |
| Tool Secrets       | `tool-secrets.ts`             | 4         | Secret CRUD + rotation                              |
| Agents             | `agents.ts`                   | 2         | List agents, get agent by domain/name               |
| Project Agents     | `project-agents.ts`           | 3         | Project agent list, detail, DSL update              |
| Deployments        | `deployments.ts`              | 5         | Deploy, list, detail, retire, rollback              |
| Versions           | `versions.ts`                 | 5         | Version CRUD, promote, diff                         |
| Tenant Models      | `tenant-models.ts`            | 11        | Model CRUD + connections + validation               |
| Service Instances  | `tenant-service-instances.ts` | 5         | Service instance CRUD                               |
| Agent Model Config | `agent-model-config.ts`       | 2         | Per-agent model config get/set                      |
| Model Catalog      | `model-catalog.ts`            | 4         | Catalog list, detail, refresh, discovery            |
| Contacts           | `contacts.ts`                 | 7         | Contact CRUD + lookup + link-session                |
| Workflows          | `workflows.ts`                | 7         | Workflow CRUD + archive + associate-session         |
| Channels           | `channels.ts`                 | 4         | Channel CRUD                                        |
| Voice              | `voice.ts`                    | 4         | Capabilities, token, connect, status                |
| LiveKit            | `livekit.ts`                  | 2         | Capabilities, token                                 |
| SDK                | `sdk.ts`                      | 1         | SDK project config                                  |
| SDK Init           | `sdk-init.ts`                 | 2         | SDK init + refresh                                  |
| Proxy Config       | `proxy-config.ts`             | 4         | Proxy config CRUD                                   |
| A2A                | `a2a.ts`                      | 2         | Agent-to-Agent protocol (agent card + task)         |

### 6.2 Studio — ~45 route files, ~117 endpoints

| Tag           | Route Files | Endpoints | Description                                                                                    |
| ------------- | ----------- | --------- | ---------------------------------------------------------------------------------------------- |
| Auth          | 13 files    | 15        | Login, signup, verify, reset, refresh, logout, me, Google OAuth, dev-login, workspace, tenants |
| MFA           | 5 files     | 7         | Setup, confirm, status, verify, disable, recovery                                              |
| Device Auth   | 4 files     | 4         | Device code flow (mirrors runtime)                                                             |
| SSO           | 6 files     | 7         | Exchange, init, domains, OIDC/SAML callbacks, config                                           |
| Projects      | 6 files     | 12        | Project CRUD, sessions, agents, DSL                                                            |
| Agents        | 4 files     | 4         | Agent listing, apps, domain agents, agent detail                                               |
| Workspaces    | 2 files     | 3         | Members, invitations list/create                                                               |
| Invitations   | 3 files     | 3         | Invitation detail, accept, revoke                                                              |
| Organizations | 2 files     | 3         | Create org, list/create workspaces                                                             |
| Credentials   | 2 files     | 5         | LLM credential CRUD                                                                            |
| Models        | 2 files     | 5         | Model configuration CRUD                                                                       |
| Service Nodes | 2 files     | 5         | Service node CRUD                                                                              |
| Tenant Models | 5 files     | 11        | Runtime proxy: tenant model + connection CRUD                                                  |
| SDK           | 6 files     | 10        | API keys, preview tokens, share, widget, embed                                                 |
| Voice         | 2 files     | 2         | Token, capabilities (proxy)                                                                    |
| LiveKit       | 2 files     | 2         | Token, capabilities (proxy)                                                                    |
| Debug         | 3 files     | 5         | Debug token CRUD + validation                                                                  |
| Audit         | 1 file      | 1         | Audit log listing                                                                              |
| Admin         | 2 files     | 2         | Scheduler status, SDK client count                                                             |
| Archives      | 5 files     | 6         | Archive list, create, download, delete                                                         |
| ABL           | 2 files     | 2         | Parse, compile                                                                                 |
| Runtime       | 2 files     | 2         | Session proxy                                                                                  |
| Model Catalog | 1 file      | 1         | Catalog proxy                                                                                  |

---

## 7. Schema Guidelines

### 7.1 What to Document

| Priority                   | What          | Example                                                          |
| -------------------------- | ------------- | ---------------------------------------------------------------- |
| **Required**               | `summary`     | Every route must have a 3-10 word summary                        |
| **Required**               | `response`    | Zod schema for the success response shape                        |
| **Required for mutations** | `body`        | Zod schema for POST/PUT/PATCH request body                       |
| **Recommended**            | `description` | Longer explanation for complex routes                            |
| **Optional**               | `query`       | Only for routes with non-trivial query params                    |
| **Auto-derived**           | `params`      | Path params extracted automatically from `:id` / `[id]`          |
| **Auto-derived**           | `tags`        | From first path segment; override only for non-standard grouping |

### 7.2 Schema Conventions

```typescript
// Use .describe() for field-level docs
z.object({
  agentId: z.string().describe('Agent ID or path (e.g., "hotel-booking/booking_agent")'),
  limit: z.number().int().min(1).max(200).default(50).describe('Page size'),
});

// Use .optional() for nullable fields
z.object({
  channel: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Reuse schemas across routes (define once, import everywhere)
const PaginationSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

// SSE endpoints
openapi.route(
  'post',
  '/stream',
  {
    summary: 'Stream chat response',
    responseContentType: 'text/event-stream',
    body: chatRequestSchema,
  },
  handler,
);

// Public endpoints (no auth)
openapi.route(
  'get',
  '/.well-known/agent.json',
  {
    summary: 'A2A Agent Card',
    auth: false,
    response: agentCardSchema,
  },
  handler,
);
```

### 7.3 Shared Schema Location

Reusable Zod schemas should live in:

- `apps/runtime/src/schemas/` — Runtime-specific request/response schemas
- `apps/studio/src/schemas/` — Studio-specific schemas
- `packages/openapi/src/shared/` — Only for cross-package schemas (e.g., pagination, error)

---

## 8. Fallback: Runtime Route Introspection

For routes that haven't been manually annotated, `introspectExpressRoutes()` can be called at startup to walk the Express middleware stack and register any missing routes with basic method + path info. This ensures 100% route coverage even before all routes are manually annotated.

```typescript
// In server.ts, after all routes are mounted:
import { introspectExpressRoutes } from '@agent-platform/openapi/express';
introspectExpressRoutes(app, runtimeRegistry);
```

This provides immediate visibility of all endpoints (with auto-derived tags) while detailed schemas are added incrementally.

---

## 9. Implementation Phases

### Phase 1: Immediate Coverage via Introspection

- Call `introspectExpressRoutes()` in runtime server.ts after all routes are mounted
- Studio `scanNextjsRoutes()` already discovers all routes (even unwrapped ones)
- **Result:** All ~222 endpoints visible in Swagger UI with method + path + auto-tags

### Phase 2: Runtime Route Annotation (23 files)

- Convert each route file to use `createOpenAPIRouter` with Zod schemas
- Process in batches of 3-4 files in parallel
- Priority order: Chat → Auth → Projects → Tenants → Contacts/Workflows → Voice/SDK/Misc
- **Result:** All 105 runtime endpoints have full schemas

### Phase 3: Studio Route Annotation (~45 files)

- Wrap each handler with `withOpenAPI()` + Zod schemas
- Process in batches by domain (Auth → Projects → Credentials → SDK → Misc)
- **Result:** All 117 studio endpoints have full schemas

### Phase 4: Shared Schemas + Polish

- Extract common schemas (pagination, error, entity IDs) to shared location
- Add `description` (markdown) for complex endpoints
- Add example values where helpful
- Review Swagger UI grouping/tag names for consistency

---

## 10. Security Considerations

| Concern                              | Mitigation                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Spec exposes internal API surface    | Swagger UI is for development; disable in production via env flag if needed |
| Schema leaks DB field names          | Response schemas are hand-written, not auto-generated from models           |
| CSP blocks Swagger UI assets         | `unpkg.com` added to `script-src` and `style-src` in Studio middleware      |
| CORS on spec endpoint                | Spec endpoints follow same CORS rules as other API routes                   |
| Auth bypass via Swagger "Try it out" | Swagger sends Bearer token via "Authorize" button; no special bypass        |

---

## 11. Testing

- **Build check:** `pnpm build` ensures all Zod schemas compile
- **Spec generation test:** Unit test that calls `registry.generateSpec()` and validates output is valid OpenAPI 3.0
- **Visual verification:** Playwright/Playwriter test that loads `/docs` and `/api/openapi`, verifies no errors
- **Route coverage:** Compare `registry.routes.length` against known endpoint count to detect drift

---

## 12. Configuration

| Variable               | Location                                     | Purpose                                   |
| ---------------------- | -------------------------------------------- | ----------------------------------------- |
| `DEFAULT_RUNTIME_PORT` | `packages/config/src/constants.ts`           | Runtime server URL in spec                |
| `DEFAULT_STUDIO_PORT`  | `packages/config/src/constants.ts`           | Studio server URL in spec                 |
| Swagger UI CDN         | `packages/openapi/src/express/serve-spec.ts` | `unpkg.com/swagger-ui-dist@5/`            |
| Runtime docs mount     | `apps/runtime/src/server.ts`                 | `app.use('/docs', serveOpenAPIDocs(...))` |
| Studio docs route      | `apps/studio/src/app/api/openapi/`           | Next.js App Router page + API route       |
