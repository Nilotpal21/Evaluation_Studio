---
name: data-flow-audit
description: Generic framework for auditing field propagation, dependency wiring, removed field cleanup, and schema-route alignment across multi-layer features. Traces fields from definition through every layer to consumption. Catches omission bugs where a field exists in one layer but is silently dropped in the next.
---

# Data Flow Audit — Generic Framework

## Purpose

Catches **omission bugs** in any multi-layer feature where a field is defined in one layer but silently dropped in a downstream layer. Each file looks correct in isolation — the bug is a missing line, not a wrong line.

Also catches:

- **Wiring gaps** where a dependency is constructed but never passed to its consumer
- **Stale references** to removed fields that become dead code or runtime errors
- **Schema ↔ route misalignment** where validation accepts a field but the handler never persists it
- **Interface divergence** where duplicate type definitions drift apart

## When to Use

- After adding or modifying a field that flows through multiple layers (schema → service → UI → API → runtime)
- After removing fields from a data model (trace stale references)
- Before PRs that touch data models, API routes, and UI in the same feature
- When reviewing changes that span 3+ packages or layers
- When a field "should work" but doesn't at runtime — trace it through all layers

## The Pattern

Every multi-layer feature has a **data pipeline** — a field is defined somewhere, flows through transformations, and is consumed somewhere else. Omission bugs happen at layer boundaries where a field is available but not forwarded.

```
Definition Layer     → Where the field is first defined (schema, config, external source)
Transformation Layer → Where the field is enriched, mapped, or restructured
Presentation Layer   → Where the field is surfaced to users (UI, API response)
Persistence Layer    → Where the field is stored (DB write, API POST/PUT)
Consumption Layer    → Where the field is read back and used (runtime, background job, external call)
```

## Audit Procedure

### Step 1: Map the Layers

For your feature, identify every layer the field passes through. Ask:

1. **Where is the field defined?** (Schema, config type, external data source)
2. **Where is it transformed?** (Service layer, mapper, enrichment)
3. **Where is it presented?** (UI component, API response)
4. **Where is it persisted?** (DB write route, create/update handler)
5. **Where is it consumed?** (Runtime read, background job, external API call)

Document each layer with:

- Exact file path(s)
- Function or code block that handles the field
- Direction: READ / WRITE / PASS-THROUGH

### Step 2: List All Fields

From the definition layer, enumerate every field in the data model. Include:

- Required vs optional
- Fields with default values
- Fields that only apply conditionally (e.g., OAuth-only fields)
- **Fields that were removed** — these need stale reference tracing (Step 7)

### Step 3: Build the Propagation Matrix

Create a matrix: rows = fields, columns = layers. Mark each cell:

| Symbol  | Meaning                                             |
| ------- | --------------------------------------------------- |
| **Y**   | Field is handled at this layer                      |
| **-**   | Field is intentionally not applicable at this layer |
| **GAP** | Field should be here but isn't — potential bug      |
| **N/A** | Layer doesn't exist for this field type             |

Example:

```
| Field        | Schema | Service | UI     | API Write | Runtime |
|--------------|--------|---------|--------|-----------|---------|
| name         | Y      | Y       | Y      | Y         | Y       |
| description  | Y      | Y       | Y      | Y         | -       |
| secretField  | Y      | -       | redact | Y (enc)   | Y (dec) |
| newField     | Y      | Y       | GAP    | Y         | GAP     |
```

### Step 4: Verify with Concrete Data

Pick 3-5 real data examples (not synthetic) and trace them through the full pipeline:

1. Find a real record in the DB or config that uses the field
2. Walk through each layer with that concrete value
3. Verify the value arrives correctly at the consumption layer

This catches bugs that the matrix alone misses — e.g., type coercion, serialization issues, default value conflicts.

### Step 5: Check Parallel Implementations

Many codebases have mirrored implementations (e.g., two packages with the same logic, workspace vs project routes, v1 vs v2 APIs). For each field:

- List all parallel paths
- Verify the field is handled identically in each
- Flag any path that's missing the field

### Step 6: Check Conditional Fields

Fields that only apply under certain conditions are the highest risk for omission:

- Fields gated by a type discriminator (e.g., `authType === 'oauth2_app'`)
- Fields that are optional in the schema but required by certain consumers
- Fields with defaults that may mask missing propagation

For each conditional field, verify:

- The condition is checked at every layer
- The field is forwarded even when the condition isn't met (if needed for future use)
- Default values are consistent across layers

### Step 7: Audit Removed Fields (Stale Reference Tracing)

When a PR removes fields from a data model, trace every former reference to ensure clean removal.

**Procedure:**

1. List every field removed from the model/schema
2. For each removed field, search the entire codebase: `grep -r "fieldName" --include="*.ts" --include="*.tsx"`
3. Classify each hit:
   - **Production stale reference** — code reads/writes the field that no longer exists (BUG)
   - **Dead code** — guarded by if-check so no runtime error, but unreachable (CLEANUP)
   - **Unrelated type** — same field name on a different model (OK)
   - **Comment/doc reference** — informational only (OK)
   - **Migration script** — intentionally references old field (OK)
   - **Import/export compat** — backward-compatible import schemas (OK if stripped)

**Example from PR #622:**

```
FIELD: encryptedCredentials (REMOVED from ConnectorConnection)
  routing-executor.ts:3056 — STALE: reads connDoc.encryptedCredentials, attempts decrypt
    Impact: Dead code (guarded by if-check), but should use authProfileResolver
    Verdict: LOW — not a runtime error, but dead code should be cleaned up
  connections-assembler.ts:10 — OK: defensive stripping (no-op if field absent)
  drop-legacy-fields.ts:39 — OK: migration script, intentional reference
```

### Step 8: Schema ↔ Route Alignment Audit

Catches fields that are validated by the schema but silently dropped in the route handler.

**Procedure:**

1. Read the Zod/validation schema for create and update operations
2. Read the route handler's create payload (`Model.create({...})`) or update assignments (`if (updates.X) doc.X = ...`)
3. Compare every schema field against the handler — flag any field present in schema but absent in handler

**Why this matters:** When a schema validates a field and the DB model has a default, the field is silently dropped and the default is used instead. The API appears to work (201 Created) but the user's value is ignored.

**Example from PR #622:**

```
FIELD: connectionMode
  Schema (Zod):     OK — z.enum(['shared', 'per_user']).default('shared')
  DB Model:         OK — { type: String, enum: [...], default: 'shared' }
  POST Route:       GAP — body.connectionMode never passed to AuthProfile.create()
  PUT Route:        GAP — updates.connectionMode never assigned to doc
  IMPACT: User selects 'per_user' in UI → API validates it → route drops it →
          Mongoose defaults to 'shared' → per-user OAuth grant lookup broken
  FIX: Add connectionMode to create payload and update assignments in all 4 routes
```

**Checklist:**

- [ ] Every field in `CreateSchema` has a corresponding line in the `create()` payload
- [ ] Every field in `UpdateSchema` has a corresponding `if (updates.X) doc.X = ...` assignment
- [ ] Fields with Mongoose defaults are still explicitly passed (defaults mask the bug)
- [ ] Both workspace and project route variants are checked

### Step 9: Dependency Wiring Audit

Catches cases where a dependency is constructed in one place but never passed to a consumer that needs it.

**Procedure:**

1. Identify all services/resolvers constructed during app initialization
2. For each service, list every consumer (router, executor, background job) that uses it
3. Verify the dependency is actually passed via constructor args or factory deps
4. Check that the consumer's deps interface includes the dependency type

**Why this matters:** A dependency can be fully implemented and tested in isolation, but if the wiring code in `start()` or `main()` never passes it to the consumer, the feature is silently broken at runtime.

**Example from PR #622:**

```
DEPENDENCY: authProfileResolver
  Constructed at: workflow-engine/src/index.ts:375-380
  Consumer 1: ConnectionResolver (line 383) — WIRED ✓
  Consumer 2: ConnectorToolExecutor via connectorDepsFactory (line 388) — WIRED ✓
  Consumer 3: ConnectionService via createConnectionRouter (line 493) — NOT WIRED ✗
    Impact: POST /:connectionId/test always throws "Auth profile resolver not configured"
    Root cause: ConnectionRouteDeps interface didn't include authProfileResolver
    Fix: Extend deps interface, pass resolver from start()
```

**Checklist:**

- [ ] Every constructed service/resolver is passed to all its consumers
- [ ] Consumer deps interfaces include the dependency (not just `as any` casting)
- [ ] Optional deps that are `null` when prerequisites fail are handled by consumers
- [ ] Multiple consumer paths (e.g., CRUD routes vs execution path) are all checked

### Step 10: Interface Divergence Check

Catches duplicate type/interface definitions that have drifted apart.

**Procedure:**

1. Search for interfaces/types with the same name across the codebase
2. Compare their field lists — flag any field present in one but not the other
3. Determine if the divergence is intentional (different contexts) or accidental (copy-paste drift)

**Example from PR #622:**

```
INTERFACE: AuthProfileResolverLike
  Copy 1: connection-service.ts:73  — { authProfileId, tenantId, projectId? }
  Copy 2: connection-resolver.ts:13 — { authProfileId, tenantId, projectId?, environment? }
  Divergence: 'environment' field in copy 2 only
  Risk: If a consumer uses copy 1's type but the implementation expects environment,
        the field is silently undefined
  Recommendation: Consolidate into one canonical definition, re-export from barrel
```

## Reporting Format

For each field with a gap:

```
FIELD: <fieldName>
  Layer 1 (Definition):    OK — defined at <file>:<line>
  Layer 2 (Transform):     OK — mapped at <file>:<line>
  Layer 3 (Presentation):  GAP — missing from <function> in <file>
  Layer 4 (Persistence):   OK — stored at <file>:<line>
  Layer 5 (Consumption):   GAP — not read in <function> at <file>
  VERDICT: INCOMPLETE — gaps at Layer 3, Layer 5
  IMPACT: <what breaks for the user>
  FIX: Add field to <function> in <file>, propagate to <function> in <file>
```

## Common Omission Patterns

These are the most frequent ways fields get dropped:

| Pattern                  | Example                                                                            | How to Catch                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Prefill miss**         | UI maps 8 of 9 fields from a provider config                                       | Compare provider type definition against prefill function — every field should appear |
| **Resolver miss**        | Interface has 10 fields, return object has 9                                       | Compare interface definition against the `return {}` block                            |
| **Parallel drift**       | Package A adds a field, package B doesn't                                          | Diff the two parallel files after any change                                          |
| **Spread vs explicit**   | `...config` passes everything, but a later explicit assignment overwrites          | Check for `{...obj, field: undefined}` patterns that delete fields                    |
| **Type narrowing**       | Function accepts `Record<string, unknown>` but caller has `Record<string, string>` | Fields with non-string values silently fail                                           |
| **Conditional skip**     | `if (field) { use(field) }` skips falsy but valid values like `0` or `""`          | Check for strict null checks: `if (field !== undefined)`                              |
| **Schema-route gap**     | Zod validates `connectionMode` but route handler never passes it to `Model.create` | Compare schema fields against create/update payload — every field must appear         |
| **Wiring gap**           | `authProfileResolver` constructed in `start()` but never passed to router deps     | Trace every constructed dependency to all its consumers                               |
| **Default masking**      | DB model has `default: 'shared'` so missing field doesn't cause an error           | Fields with defaults are highest risk — the bug is silent                             |
| **Stale reference**      | Code reads `doc.encryptedCredentials` after field was removed from model           | Search for every removed field name across the codebase                               |
| **Interface divergence** | Two copies of `AuthProfileResolverLike` with different fields                      | Search for same-named interfaces, compare field lists                                 |

## Applying to Specific Features

For domain-specific audits with pre-built layer maps and field matrices, see:

- **Auth profiles**: `/data-propagation-audit` — 8-layer OAuth field flow with provider test cases

When creating a new domain-specific audit skill, use this framework as the template and fill in:

1. The exact layers and file paths for your feature
2. The complete field list from your schema
3. The expected propagation matrix
4. Concrete test cases with real data
5. Known design decisions (intentional gaps)
