# Seed Data — Low-Level Design

## Task T-1: PromptCatalog (Hardcoded Defaults)

### Files

- `packages/shared/src/prompts/prompt-catalog.ts` — Single source of truth for all hardcoded prompt defaults

### Structure

The `PromptCatalog` object contains 10 sections:

1. **systemPrompt** — 5 agent role templates: `supervisor`, `supervisor_direct`, `specialist`, `standalone`, `fallback`. Each is a complete Handlebars template with conditional blocks for context, memory, voice, constraints.
2. **llmPrompts** — Task-specific prompts: entity extraction, correction detection, field validation, field inference.
3. **toolDescriptions** — Descriptions for system tools: `handoff`, `delegate`, `escalate`, `fan_out`, `set_context`.
4. **sharedDescriptions** — Cross-tool descriptions: `reason`, `thought`, `thought_with_budget`.
5. **messages** — Default messages: error/fallback/voice messages.
6. **escalation** — Channel-specific escalation templates: `digital`, `voice`, `plain`, `msteams`, `slack`, `whatsapp`, `messenger`.
7. **voiceFormatRules** — Voice channel response format constraints.
8. **toolSchemas** — JSON schema objects for system tools (properties + required arrays).
9. **conditionPatterns** — Regex mappings for routing condition descriptions.
10. **arch** — Studio Arch AI prompts (chat stages, workflow, generate, shared fragments).

### Type Exports

- `SystemPromptKey` — Union of system prompt template names
- `MessageKey` — Union of message template names
- `ToolSchemaKey` — Union of tool schema names
- `LLMPromptKey` — Union of LLM task prompt names
- `EscalationChannel` — Union of escalation channel names

---

## Task T-2: PromptTemplate Model

### Files

- `packages/database/src/models/prompt-template.model.ts` — Mongoose model for `prompt_templates` collection

### Schema

```typescript
interface IPromptTemplate {
  _id: string; // uuidv7
  key: string; // Unique, e.g., 'system_prompt.supervisor'
  category:
    | 'system_prompt'
    | 'tool_schema'
    | 'tool_description'
    | 'message'
    | 'escalation'
    | 'pattern';
  content: unknown; // String for prompts, object for JSON schemas
  description?: string;
  version: number; // Default 1
  createdAt: Date;
  updatedAt: Date;
}
```

### Indexes

- `{ key: 1 }` — unique
- `{ category: 1 }` — for category-based queries

---

## Task T-3: PromptTemplateLoader

### Files

- `packages/shared/src/prompts/prompt-template-loader.ts` — DB-cached template resolver

### Key Methods

- `loadFromDB(PromptTemplateModel?)` — Loads all templates from MongoDB into `Map<key, content>`. Called once during IR compilation/resolution. Falls back silently if model is undefined or query fails.
- `loadFromEntries(entries)` — Direct cache population for testing/migration.
- `getSystemPrompt(key)` — Returns cached DB value or falls back to `PromptCatalog.systemPrompt[key]`.
- `getToolSchema(key)` — Returns cached DB value or falls back to `PromptCatalog.toolSchemas[key]`.
- `getMessage(key)` — Returns cached DB value or falls back to `PromptCatalog.messages[key]`.
- `getLLMPrompt(key)` — Returns cached DB value or falls back to `PromptCatalog.llmPrompts[key]`.
- `getEscalation(channel)` — Maps runtime ChannelType to EscalationChannel, returns cached or catalog fallback.

### Channel Mapping

Static `CHANNEL_TO_ESCALATION` record maps channel types (msteams, slack, whatsapp, vxml, web, etc.) to escalation template keys (msteams, slack, whatsapp, voice, digital, etc.).

### Cache Characteristics

- Populated once at IR compilation time (not per-request)
- No max size (loads all templates)
- No TTL (persists for process lifetime)
- Reload requires process restart or explicit `loadFromDB()` call

---

## Task T-4: Seed Data Route

### Files

- `apps/runtime/src/routes/seed-data.ts` — `GET /api/seed-data`

### Route

- `GET /api/seed-data` — Auth required (any authenticated user), tenant rate limited
  - Query: `keys` (comma-separated prompt_template keys)
  - Validation: max 50 keys per request
  - Resolution: DB lookup via `$in`, then `getCatalogFallback()` for missing keys
  - Returns `{ success: true, data: { key: content, ... } }`
  - DB errors caught gracefully — falls back to catalog for all keys

### Catalog Fallback Logic

`getCatalogFallback(key)` splits the key by `.` and dispatches by category prefix:

| Key Prefix                   | Catalog Path                                   |
| ---------------------------- | ---------------------------------------------- |
| `llm_prompt.*`               | `PromptCatalog.llmPrompts[name]`               |
| `system_prompt.*`            | `PromptCatalog.systemPrompt[name]`             |
| `tool_schema.*`              | `PromptCatalog.toolSchemas[name]`              |
| `tool_description.shared.*`  | `PromptCatalog.sharedDescriptions[name]`       |
| `tool_description.<tool>.*`  | `PromptCatalog.toolDescriptions[tool][subKey]` |
| `message.*`                  | `PromptCatalog.messages[name]`                 |
| `escalation.*`               | `PromptCatalog.escalation[name]`               |
| `pattern.voice_format_rules` | `PromptCatalog.voiceFormatRules`               |

---

## Task T-5: Node Type Seed Data

### Files

- `packages/pipeline-engine/src/pipeline/seed-node-types.ts` — Seeder function
- `packages/pipeline-engine/src/pipeline/seed-data/node-type-definitions.json` — 36 node type definitions
- `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json` — Trigger definitions

### seedNodeTypes()

1. `loadSeedData()` — Reads `node-type-definitions.json` from disk (relative path, works in both src/ and dist/)
2. Builds `operations` array: one `updateOne` with `upsert: true` per entry, filter: `{ _id, tenantId: 'SYSTEM' }`, update: `$set` with `updatedAt: new Date()`
3. Executes `NodeTypeDefinitionModel.bulkWrite(operations)`
4. Garbage collects: `deleteMany({ tenantId: 'SYSTEM', _id: { $nin: seedIds } })`
5. Returns `{ count: operations.length }`

### Node Type Categories (36 total)

| Category    | Count | Examples                                                             |
| ----------- | ----- | -------------------------------------------------------------------- |
| compute     | 18    | compute-sentiment, compute-intent, llm-evaluate, simulate-persona    |
| data        | 6     | read-conversation, transform, db-query, filter, aggregate            |
| logic       | 4     | node-group, wait-for-event, delay, sub-pipeline                      |
| integration | 4     | http-request, send-email, send-slack, publish-kafka                  |
| action      | 4     | store-results, store-insight, send-notification, run-legacy-workflow |

### Each Node Type Entry

```json
{
  "_id": "compute-intent",
  "tenantId": "SYSTEM",
  "label": "Intent Classification",
  "description": "Classifies conversation intent...",
  "category": "compute",
  "executionModel": "async",
  "defaultTimeout": 30000,
  "defaultRetries": 1,
  "traits": ["compute", "llm", "storage"],
  "configSchema": [
    { "name": "taxonomy", "type": "object[]", "label": "...", "description": "...", "itemSchema": [...] }
  ],
  "version": 1,
  "isActive": true
}
```

### Trigger Registry

- `trigger-registry.ts` loads `trigger-definitions.json` on first access (lazy, cached)
- Uses `readFileSync` with memoization (`cachedDefinitions`)

### Startup Integration

In `apps/runtime/src/server.ts` (around line 1257):

```typescript
const { seedNodeTypes } = await import('@agent-platform/pipeline-engine');
const seedResult = await seedNodeTypes();
serverLog.info(`Seeded ${seedResult.count} node type definitions`);
```

---

## Task T-6: Studio Proxy Route

### Files

- `apps/studio/src/app/api/seed-data/route.ts` — Next.js API route proxy

### Design

- `GET` handler: requires auth via `requireAuth(request)`
- Forwards `Authorization` header and query params to `${getRuntimeUrl()}/api/seed-data`
- Returns runtime response as-is
- On error: returns 502 with `{ success: false, error: 'Failed to fetch seed data from runtime' }`

---

## Known Gaps

| Gap                                                | Severity | Notes                                                |
| -------------------------------------------------- | -------- | ---------------------------------------------------- |
| PromptTemplateLoader cache has no max size or TTL  | Low      | Loads all templates; bounded by total template count |
| PromptTemplateLoader uses console.warn on DB error | Low      | Should use createLogger                              |
| Studio proxy uses console.error                    | Low      | Should use structured logger                         |
| No per-tenant prompt template overrides            | Medium   | Currently platform-wide only                         |
| No seed data versioning/migration                  | Low      | JSON files are versioned via git only                |
| Trigger definitions not tested in seed-data tests  | Low      | Only node type definitions validated                 |

## Exit Criteria

- `seedNodeTypes()` upserts all 36 node types with SYSTEM tenant at startup
- Stale SYSTEM entries are deleted when removed from seed JSON
- `GET /api/seed-data` resolves keys from DB first, then PromptCatalog fallback
- PromptCatalog contains all system prompts, tool schemas, messages, escalation templates
- PromptTemplateLoader caches DB templates and falls back to catalog
- Studio proxy forwards seed data requests to runtime
- All unit and integration tests pass
