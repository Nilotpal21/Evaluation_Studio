# Workflow Memory & Agent Context — Authoring Guide

This guide shows you how to use the three first-class workflow primitives — `memory`, `agentSession`, and `agentContext` — from inside workflow expressions and function nodes.

> **Status**: STABLE (v1)
> **Audience**: workflow authors building automation in Studio
> **Companion docs**: [Workflows — High-Level Understanding](workflows-high-level-understanding.md), [Workflows Deployment & Components](workflows-deployment-and-components.md)

---

## What you get

Three workflow-native objects available inside every workflow run:

| Object                | What it is                                                                                                      | When it's available      |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **`memory.workflow`** | Persistent memory shared across runs of the same workflow                                                       | Always                   |
| **`memory.project`**  | Persistent memory shared across all workflows in the project (and with agent code-tools)                        | Always                   |
| **`memory.user`**     | Persistent memory keyed on the end-user invoking the workflow                                                   | Only on agent-bound runs |
| **`agentSession`**    | Read-only snapshot of the agent session that triggered this run (channel, end-user id, etc.)                    | Only on agent-bound runs |
| **`agentContext`**    | Read-only snapshot of the invocation context (which tool the agent called, with what args, attachment metadata) | Only on agent-bound runs |

Use them in two places:

1. **Workflow expressions** anywhere you'd type `{{trigger.payload.x}}` — Start input variables, Condition node tests, End node output mapping, API node URLs and bodies, etc.
2. **Function (script) nodes** as bare globals (`memory`) and via the `context` proxy (`context.agentSession`, `context.agentContext`).

---

## Cheat sheet

**Function node (JavaScript):**

```js
// Read
const cursor = memory.workflow.get('lastCursor');
const banner = memory.project.get('siteBanner');
const lang = memory.user.get('preferredLanguage'); // throws if non-agent run
const channel = context.agentSession?.channel; // 'web' | 'whatsapp' | 'voice' | …
const tool = context.agentContext?.invocation?.tool;

// Write — value must be JSON-serializable
memory.workflow.set('lastCursor', { id: 42, at: Date.now() });
memory.project.set('siteBanner', 'maintenance', '1h'); // 3rd arg = TTL
memory.user.set('preferredLanguage', 'fr', '90d'); // agent runs only

// Delete (tombstone; later read returns undefined)
memory.workflow.delete('lastCursor');
```

**Workflow expressions** (Start input, Condition test, End output mapping, API node URL/body):

<!-- prettier-ignore -->
```text
{{memory.workflow.lastCursor.id}}
{{memory.project.subscriberCount}}
{{memory.user.preferredLanguage}}
{{agentSession.channel}}
{{agentContext.invocation.tool}}
```

---

## Memory scopes

Three scopes, same `get` / `set` / `delete` API on each.

### `memory.workflow` — workflow-scoped

Persists across runs of **the same workflow**. Two different workflows in the same project never see each other's `memory.workflow` keys, even when they use the same key name. Internally, keys are namespaced as `wf:<workflowId>:<key>`.

**Use for**: cursors, last-processed IDs, aggregate counters, anything specific to one workflow's logic.

```js
// Read (returns undefined if never written, or after delete)
const last = memory.workflow.get('processedUntilTs') ?? 0;

// Write — value can be any JSON-serializable value
memory.workflow.set('processedUntilTs', Date.now());
memory.workflow.set('lastCursor', { id: 42, page: 3 });
memory.workflow.set('counters', { ok: 5, error: 1 });

// Delete — tombstones; subsequent reads return undefined
memory.workflow.delete('lastCursor');
```

### `memory.project` — project-scoped

Persists across **all workflows in the project**, and is also visible to agent code-tools that read project-scope memory. Keyed on `tenantId + projectId`.

**Use for**: shared state that multiple workflows or agents read, like rate-limit windows, feature flags, last-customer-touched timestamps.

```js
// Cross-workflow cursor — workflow A writes, workflow B reads
memory.project.set('lastSyncCompletedAt', new Date().toISOString());

const lastSync = memory.project.get('lastSyncCompletedAt');
if (lastSync && Date.now() - new Date(lastSync).getTime() < 60_000) {
  workflow.setOutput({ skipped: true, reason: 'recent_sync' });
  return;
}

// Increment a shared counter (last-write-wins; v1 has no atomic CAS)
const subs = memory.project.get('subscriberCount') ?? 0;
memory.project.set('subscriberCount', subs + 1);
```

> **Note on concurrency.** v1 is last-write-wins. Two runs incrementing the same key concurrently can lose an update. If you need exactly-once or atomic semantics, use unique keys per event (e.g. `subscriberSeen.<userId>`) instead of a shared counter.

### `memory.user` — per-end-user

Keyed on `tenantId + projectId + endUserId`, where `endUserId` is the **end user the agent is interacting with** (your contact / customer / anonymous visitor) — never the workspace user who created the workflow.

**Available only when** the workflow run was invoked by an agent (the agent's session has an end-user identity). Studio direct-runs, cron triggers, and webhook triggers don't have an end-user; reads/writes from those throw `UNAVAILABLE_SCOPE`.

**Use for**: per-customer preferences, per-contact session state, GDPR-erasable data tied to one end user.

```js
// Always guard with the agentSession check before touching memory.user
if (context.agentSession?.endUserId) {
  memory.user.set('preferredLanguage', 'fr', '90d');

  const purchases = memory.user.get('recentPurchases') ?? [];
  purchases.push({ at: Date.now(), sku: 'item-42' });
  memory.user.set('recentPurchases', purchases);
}
```

> **GDPR / right-to-erasure.** When you delete a contact via `DELETE /api/contacts/manage/:id/gdpr`, **all `memory.user.*` keys owned by that contact are surgically purged** automatically. `memory.workflow.*` and `memory.project.*` are untouched (they're not owned by the contact).

### TTL — keep keys for a bounded time

Pass a duration string or millisecond number as the third argument to `set`:

```js
memory.workflow.set('rateLimitWindow', { count: 1 }, '15m');
memory.project.set('siteBanner', 'maintenance', '1h');
memory.user.set('shoppingCart', cart, '7d');
memory.workflow.set('quickCache', tmp, 60_000); // 60 seconds (ms)
```

Supported units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Bare integers are milliseconds.

If no TTL is given, keys inherit the platform default (90 days). The hard ceiling is 365 days — TTLs above that are clamped down to 365d (you'll see a `ttl_clamped` trace event but the write succeeds).

---

## `agentSession` — who's calling you

Read-only projection of the agent session that triggered this workflow run. **Only present** when an agent invoked the workflow as a tool. For cron / webhook / Studio direct-runs, `context.agentSession` is `undefined`.

The projection is built from a strict positive-list — secrets, OAuth tokens, full conversation transcripts, and attachment binaries are **never** included.

Available fields:

| Path                     | Type                  | Notes                                                                |
| ------------------------ | --------------------- | -------------------------------------------------------------------- |
| `agentSession.sessionId` | `string`              | The session ID                                                       |
| `agentSession.agentName` | `string`              | Which agent invoked the workflow                                     |
| `agentSession.channel`   | `string`              | `'web'` &#124; `'whatsapp'` &#124; `'voice'` &#124; `'sms'` &#124; … |
| `agentSession.source`    | `string`              | `'public'` &#124; `'channel'` &#124; `'studio-debug'`                |
| `agentSession.endUserId` | `string \| undefined` | The end user's ID — same value `memory.user` keys on                 |

```js
const ses = context.agentSession;
if (ses) {
  workflow.setOutput({
    routingChannel: ses.channel,
    customerId: ses.endUserId,
    invokedBy: ses.agentName,
  });
} else {
  // Non-agent run (cron, webhook, Studio direct-run) — branch logic accordingly
  workflow.setOutput({ routingChannel: 'no-agent' });
}

// Attempted writes throw — agentSession is deep-frozen
// context.agentSession.channel = 'sms'; // → TypeError: Cannot assign...
```

In workflow expressions:

<!-- prettier-ignore -->
```text
{{agentSession.channel}}                    ← string or empty if absent
{{agentSession.endUserId ?? 'anonymous'}}   ← fallback for non-agent runs
```

---

## `agentContext` — what the agent asked you to do

Read-only projection of the invocation context: which tool was called, with what args, plus attachment metadata.

Available fields:

| Path                           | Type                            | Notes                                                |
| ------------------------------ | ------------------------------- | ---------------------------------------------------- |
| `agentContext.invocation.tool` | `string`                        | Name of the tool the agent invoked (= this workflow) |
| `agentContext.invocation.args` | `object`                        | JSON args the agent provided                         |
| `agentContext.attachments`     | `Array<{name, mimeType, size}>` | Metadata only — **never** binary content             |
| `agentContext.caller`          | `object`                        | Caller projection (subset of fields)                 |

```js
const ctx = context.agentContext;
if (ctx) {
  const tool = ctx.invocation.tool;
  const args = ctx.invocation.args;
  const fileCount = ctx.attachments?.length ?? 0;

  workflow.setOutput({ invokedAs: tool, withArgs: args, fileCount });
}
```

**Important**: `agentContext.attachments` carries _metadata only_. To download binary content for processing, fetch via the runtime's signed-URL API in a downstream step — the binaries are intentionally excluded from the workflow context.

In workflow expressions:

<!-- prettier-ignore -->
```text
{{agentContext.invocation.tool}}
{{agentContext.invocation.args.amount}}
{{agentContext.attachments[0].name}}
```

---

## Expressions (non-script nodes)

Anywhere you'd write `{{trigger.payload.x}}`, you can now also use `{{memory.*}}`, `{{agentSession.*}}`, and `{{agentContext.*}}`.

**Common spots** in Studio canvas:

- **Start node** — Input variable defaults: `defaultValue: '{{memory.project.defaultRegion}}'`
- **Condition node** — Branch test: `{{memory.workflow.retryCount}} > 3`
- **API node** — URL or body: `https://api.example.com/users/{{agentSession.endUserId}}`
- **End node** — Output mapping: `customerId: '{{agentSession.endUserId}}'`

**Safety**: even if a memory value contains `{{...}}` syntax (for example a customer name with curly braces), the workflow expression evaluator does **not** recursively re-resolve it. The value is inserted as an inert literal. This protects against template injection from end-user input.

---

## Common patterns

### Cross-run cursor (workflow scope)

Process records since the last successful run.

```js
const last = memory.workflow.get('processedUntilTs') ?? 0;
const records = await fetchSince(last); // pseudo
memory.workflow.set('processedUntilTs', Date.now());
workflow.setOutput({ count: records.length });
```

### Cross-trigger continuity (project scope)

Webhook writes; Studio direct-run / cron reads later.

```js
// Workflow A — webhook triggered
memory.project.set('lastWebhookEvent', { id: trigger.payload.id, at: Date.now() });

// Workflow B — cron triggered, reads what A wrote
const last = memory.project.get('lastWebhookEvent');
if (!last) {
  workflow.setOutput({ status: 'no_events_yet' });
  return;
}
```

### Per-end-user preferences (user scope, agent-bound only)

```js
const userId = context.agentSession?.endUserId;
if (!userId) {
  workflow.setOutput({ status: 'no_user_context' });
  return;
}

const profile = memory.user.get('profile') ?? {};
profile.lastSeenAt = Date.now();
profile.totalSessions = (profile.totalSessions ?? 0) + 1;
memory.user.set('profile', profile, '365d');

workflow.setOutput({ totalSessions: profile.totalSessions });
```

### Branching on agent vs non-agent invocation

```js
const isAgentRun = !!context.agentSession?.endUserId;

if (isAgentRun) {
  // Personalized path
  const lang = memory.user.get('preferredLanguage') ?? 'en';
  workflow.setOutput({ greeting: `Hello in ${lang}` });
} else {
  // Generic path for webhook/cron/Studio direct-run
  workflow.setOutput({ greeting: 'Hello' });
}
```

### Idempotent writes (avoid double-counting on replay)

```js
const eventId = trigger.payload.eventId;
const seenKey = `event.${eventId}`;

if (memory.project.get(seenKey)) {
  workflow.setOutput({ skipped: true, reason: 'already_processed' });
  return;
}

// First-time processing
const count = memory.project.get('processedTotal') ?? 0;
memory.project.set('processedTotal', count + 1);
memory.project.set(seenKey, true, '7d'); // remember for a week
```

---

## Limits and quotas

Per-write enforcement at the runtime memory boundary:

| Limit                                                        | What happens when exceeded                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| Key length > 256 characters                                  | Throws `QUOTA_KEY_LENGTH`                                       |
| Value JSON > 64 KiB                                          | Throws `QUOTA_VALUE_SIZE`                                       |
| > 100 writes per workflow run                                | Throws `QUOTA_WRITE_COUNT`                                      |
| TTL > 365 days                                               | Clamped to 365d, succeeds with a `ttl_clamped` warn trace       |
| Key starts with `wf:`, `_meta:`, `_system:`, `_audit:`       | Throws `RESERVED_PREFIX` (these prefixes are platform-internal) |
| `memory.user.*` on a non-agent run                           | Throws `UNAVAILABLE_SCOPE`                                      |
| Value not JSON-serializable (BigInt, function, circular ref) | Throws `INVALID_VALUE`                                          |
| Backing storage unreachable                                  | Throws `STORAGE_UNAVAILABLE`                                    |

Workflow-scope projection size cap: ~256 KiB total per run. If you need larger payloads, store them in object storage and keep only references in memory.

---

## Error handling

Errors thrown inside the function-node sandbox have `e.message` starting with the error code, so you can branch:

```js
try {
  memory.workflow.set('foo', {
    /* big payload */
  });
} catch (e) {
  if (e.message.startsWith('QUOTA_VALUE_SIZE:')) {
    // Compact and retry, or move to object storage
    memory.workflow.set('foo', summarize(payload));
  } else if (e.message.startsWith('STORAGE_UNAVAILABLE:')) {
    // Transient — rethrow to fail the step (Restate will retry per workflow policy)
    throw e;
  } else {
    // Unknown — rethrow
    throw e;
  }
}
```

Common codes you might see:

| Code                                                          | When                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `RESERVED_PREFIX`                                             | Tried to write a `wf:` / `_meta:` / `_system:` / `_audit:` key |
| `UNAVAILABLE_SCOPE`                                           | `memory.user.*` on a non-agent run                             |
| `QUOTA_KEY_LENGTH` / `QUOTA_VALUE_SIZE` / `QUOTA_WRITE_COUNT` | Quota exceeded                                                 |
| `TTL_INVALID`                                                 | TTL string didn't parse (`'5x'`, `-5`, `'banana'`)             |
| `INVALID_VALUE`                                               | Value not JSON-serializable                                    |
| `STORAGE_UNAVAILABLE`                                         | Mongo or Redis unreachable                                     |

---

## Workflow-as-tool nesting

When a workflow invokes another workflow as a tool (workflow-as-tool), both runs see the same `agentSession` and `agentContext` — propagated from the **outermost** agent invocation. This means:

- Outer and inner workflow's `context.agentSession.endUserId` are identical.
- Both can read the same `memory.user.*` values.
- `memory.workflow.*` is **not shared** — each workflow has its own workflow-scope namespace (`wf:<outerWfId>:` vs `wf:<innerWfId>:`). If you need to pass data between outer and inner, use the inner workflow's `args` (via `agentContext.invocation.args`), or write it to `memory.project.*`.

---

## Authoring tips

1. **Always optional-chain `agentSession` and `agentContext`.** They're `undefined` on non-agent runs; treating them as required values will produce surprising failures.
2. **Don't store secrets in memory.** Memory values inherit MongoDB's at-rest encryption, but they're plain JSON to anyone with database access. Use the secret-resolution layer for credentials.
3. **Prefer narrow keys.** `memory.user.set('profile', { ...everything })` re-writes the whole blob; `memory.user.set('profile.lang', 'fr')` is not a feature (no nested-path writes), so structure your keys per-update.
4. **Date values become strings on the way in/out.** Memory values JSON-roundtrip — `Date` instances are stored as ISO strings; reading back returns a string. Wrap with `new Date(value)` if you need the Date object.
5. **The function-node sandbox is async.** Memory ops feel synchronous in the script (`memory.workflow.set('x', 1)` returns immediately) but they're host-side network calls. They're bounded by a 5s per-op timeout — slow Mongo can surface as `STORAGE_UNAVAILABLE`.

---

## Where memory lives

Persistent memory is stored in the platform `Fact` collection. Each scope maps to a different `(userId, scope)` pair:

| Scope             | `userId` field           | `scope` field | Key namespace           |
| ----------------- | ------------------------ | ------------- | ----------------------- |
| `memory.workflow` | `__project__` (sentinel) | `project`     | `wf:<workflowId>:<key>` |
| `memory.project`  | `__project__` (sentinel) | `project`     | `<key>` (no prefix)     |
| `memory.user`     | `<endUserId>`            | `user`        | `<key>`                 |

Tenant + project filters are enforced on every read and write. Cross-tenant or cross-project access returns `undefined` (never an error that would leak existence).

---

## Related docs

- [Workflows — High-Level Understanding](workflows-high-level-understanding.md) — overall workflow execution model
- [Workflows Deployment & Components](workflows-deployment-and-components.md) — runtime architecture
- [Feature Spec — Workflow First-Class Memory](../features/sub-features/workflow-first-class-memory-and-context.md) — formal contract, FRs, gaps
- [Test Spec](../testing/sub-features/workflow-first-class-memory-and-context.md) — coverage matrix and scenarios

---

## Quick FAQ

**Q. Is `memory.workflow` shared across versions of the same workflow?**
Yes. `memory.workflow` keys are namespaced by `workflowId`, not by version. A v2 deployment of a workflow reads the same keys as v1 wrote.

**Q. Can I read `memory.user` from one workflow and write it from another?**
Yes — both reach the same key namespace (per `endUserId`). Two agent-bound workflows invoked by the same end user will share `memory.user.*`.

**Q. What happens to `memory.workflow.*` when the workflow is deleted?**
Keys persist (they're orphaned but not auto-purged). To clean them up, call the workflow-delete cascade or manually delete via a one-off script.

**Q. What happens to `memory.user.*` when an end user is GDPR-deleted?**
All `memory.user.*` keys for that end user are purged automatically. `memory.workflow.*` and `memory.project.*` are untouched.

**Q. Can I do atomic increments?**
Not in v1 (last-write-wins). Use unique keys per event (`event.<id>`) instead of a shared counter to avoid lost updates.

**Q. Why does `memory.user.get('foo')` throw on a webhook trigger?**
Webhook triggers don't have an end-user identity. `memory.user` is only available on agent-bound runs. Guard with `context.agentSession?.endUserId` first, or wrap in `try/catch` for `UNAVAILABLE_SCOPE`.
