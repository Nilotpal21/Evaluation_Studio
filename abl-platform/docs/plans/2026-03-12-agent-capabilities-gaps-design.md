# Agent Capabilities Gaps — Design Specification

**Date**: 2026-03-12
**Status**: Approved
**Scope**: 16 requirements across PII safety, attachment tools, thoughts/reasoning visibility, voice thought handling, Studio UX, and dynamic tool filtering

---

## Table of Contents

1. [Overview](#overview)
2. [Phase 1: PII Safety (P1)](#phase-1-pii-safety-p1)
3. [Phase 2: Attachment Agent Tools & DSL](#phase-2-attachment-agent-tools--dsl)
4. [Phase 3: Thoughts & Reasoning Visibility](#phase-3-thoughts--reasoning-visibility)
5. [Phase 4: Studio UX & Tool Filtering](#phase-4-studio-ux--tool-filtering)
6. [Implementation Priority & Dependencies](#implementation-priority--dependencies)
7. [Migration & Rollout](#migration--rollout)

---

## Overview

### Problem Statement

Sixteen capability gaps have been identified across the ABL platform's attachment handling, agent tooling, reasoning visibility, and voice systems. The most critical is **PII exposure** (P1): attachment content containing personally identifiable information is injected into LLM context without redaction, despite the platform detecting PII during processing.

### Design Principles

- **Minimal insertion points**: Each fix targets the narrowest possible code path
- **Reuse existing infrastructure**: PII detection, presigned URLs, trace events, and processing pipeline all exist — we wire them together rather than rebuild
- **Backward compatible**: All new features are opt-in or additive; existing agent behavior is unchanged unless tenant/project settings are modified
- **Tenant-scoped configuration**: Every new setting follows the tenant-default → project-override hierarchy

### Requirements Addressed

| #   | Requirement                                 | Phase | Priority |
| --- | ------------------------------------------- | ----- | -------- |
| 1   | PII not scrubbed before LLM injection       | P1    | **P1**   |
| 2   | No per-upload mode control                  | P1    | P2       |
| 3   | No retry for failed processing              | P1    | P2       |
| 4   | No `type: attachment` tool parameter        | P2    | P2       |
| 5   | No `upload_attachment` tool                 | P2    | P2       |
| 6   | No `get_attachment_url` tool                | P2    | P2       |
| 7   | No `route_attachment` tool                  | P2    | P2       |
| 8   | No `AWAIT_ATTACHMENT` flow step             | P2    | P2       |
| 9   | No `DESTINATIONS` DSL block                 | P2    | P2       |
| 10  | Thoughts gated behind `enableThinking`      | P3    | P2       |
| 11  | No in-progress signal during tool execution | P3    | P2       |
| 12  | Scripted agents produce no thoughts         | P3    | P3       |
| 13  | No thought → LLM call linkage               | P3    | P3       |
| 14  | Voice: no thought handling                  | P3    | P3       |
| 15  | Studio UI attachment gaps                   | P4    | P3       |
| 16  | No dynamic/pre-filtered tool injection      | P4    | P3       |

---

## Phase 1: PII Safety (P1)

### 1.1 PII Detection on Attachment Content

**Current state**: `hasPII` field exists on the Attachment model but is always initialized to `false`. PII detection (`containsPII()`, `detectPII()`) exists in `pii-detector.ts` but is only called on messages, not on attachment `processedContent`.

**Design**:

In `process-job.ts`, after text extraction completes for any category (document, audio, video), run PII detection on the extracted content:

```typescript
// In process-job.ts, after processedContent is set
const piiResult = detectPII(processedContent);
await Attachment.findOneAndUpdate(
  { _id: attachmentId, tenantId },
  {
    hasPII: piiResult.hasPII,
    piiDetections: piiResult.detections.map((d) => d.type), // ['email', 'ssn', 'phone', ...]
  },
);
```

**Schema change** — add to `IAttachment`:

```typescript
piiDetections: string[];  // Types of PII detected: 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address'
```

**Files modified**:

- `apps/multimodal-service/src/jobs/process-job.ts`
- `packages/database/src/models/attachment.model.ts`

### 1.2 PII Redaction Interceptor in MessagePreprocessor

**Current state**: `MessagePreprocessor.preprocess()` injects `processedContent` as-is into `contentBlocks[]`. The `redactPII()` function exists in `pii-detector.ts` but is never called on attachment content.

**Design**:

Add a redaction step in `MessagePreprocessor` between content extraction and content block assembly. The behavior is controlled by a new `attachmentPiiPolicy` setting.

**Policy values**:

- `'redact'` (default) — Replace detected PII with type-tagged placeholders: `[REDACTED_EMAIL]`, `[REDACTED_SSN]`, etc. using existing `redactPII()` (matching the label format in `pii-detector.ts`).
- `'block'` — If `hasPII === true`, inject `[File blocked: {filename} — contains personally identifiable information]` instead of content. The agent is informed the file exists but cannot see its content.
- `'allow'` — Inject content as-is. Opt-in for use cases where PII handling is the agent's explicit purpose (e.g., KYC verification agents).

**Insertion point** in `message-preprocessor.ts`:

```typescript
// After: const content = attachment.processedContent;
// Before: building the text content block

let safeContent = content;
if (piiPolicy === 'redact' && attachment.hasPII) {
  // Build exempt types from active GATHER fields:
  // e.g., GATHER field 'phone_number' → exemptTypes = new Set<PIIType>(['phone'])
  const exemptTypes: Set<PIIType> = buildExemptTypesFromGatherFields(activeGatherFields);
  const result = detectPIISelective(content, exemptTypes, piiRegistry);
  safeContent = result.redacted;
} else if (piiPolicy === 'block' && attachment.hasPII) {
  safeContent = null; // triggers blocked message
}
```

**PII-Guard integration**: When a GATHER step is active, `detectPIISelective()` (signature: `detectPIISelective(text: string, exemptTypes?: Set<PIIType>, registry?: PIIRecognizerRegistry)`) exempts PII types matching the active gather fields. GATHER field type → PIIType mapping: `phone_number` → `'phone'`, `email` → `'email'`, `ssn` → `'ssn'`, `credit_card` → `'credit_card'`. This prevents redacting a user's phone number from an uploaded document when the flow is explicitly collecting their phone number.

**Configuration hierarchy**: Tenant attachment config → Project settings override. Stored as:

```typescript
// In ITenantAttachmentConfig (packages/database/src/models/tenant-attachment-config.model.ts)
attachmentPiiPolicy: 'redact' | 'block' | 'allow'; // default: 'redact'

// In project-settings.model.ts (optional override)
attachmentPiiPolicy?: 'redact' | 'block' | 'allow'; // default: inherit from tenant
```

**Resolution path**: `project-settings.attachmentPiiPolicy` → `tenant-attachment-config.attachmentPiiPolicy` → `'redact'` (system default).

**Files modified**:

- `apps/runtime/src/attachments/message-preprocessor.ts` — add redaction interceptor; also fix pre-existing `console.warn`/`console.error` calls (lines ~203, ~270) to use `createLogger('message-preprocessor')`
- `packages/database/src/models/tenant-attachment-config.model.ts` — add `attachmentPiiPolicy`
- `packages/database/src/models/project-settings.model.ts` — add optional `attachmentPiiPolicy`

### 1.3 Per-Upload Processing Mode

**Current state**: Every uploaded file goes through the full scan → extract → embed → inject pipeline with no opt-out.

**Design**:

Add an optional `processingMode` parameter to the upload endpoint:

| Mode               | Pipeline Steps                             | Use Case                                                                                                                        |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `'full'` (default) | scan → validate → process → index → inject | Standard: document understanding, search                                                                                        |
| `'scan-only'`      | scan → validate → store                    | Store safely but don't extract text or inject into LLM. For pass-through forwarding to external systems via `route_attachment`. |
| `'store-raw'`      | store only                                 | Trusted internal uploads (agent-generated). Requires `attachment:upload-raw` permission. No scanning.                           |

**Implementation**:

- Upload endpoint accepts `processingMode` in request body (multipart field or JSON)
- `AttachmentService.upload()` stores `processingMode` on the attachment record
- After storage, enqueue jobs conditionally:
  - `'full'`: enqueue scan-job (existing behavior)
  - `'scan-only'`: enqueue scan-job, but scan-job checks `processingMode` and after validation sets `processingStatus: 'skipped'` instead of enqueuing process-job
  - `'store-raw'`: set `scanStatus: 'skipped'`, `processingStatus: 'skipped'` immediately

**MessagePreprocessor behavior**: Already handles `processingStatus: 'skipped'` → outputs `[Unsupported file: {filename}]`. Additionally, add an explicit guard for `store-raw` mode: if `scanStatus === 'skipped'`, always output `[File not scanned: {filename} — raw storage mode]` regardless of other status fields. This prevents unscanned content from ever reaching the LLM, even if future MessagePreprocessor logic changes.

**Schema change**:

```typescript
processingMode: 'full' | 'scan-only' | 'store-raw'; // default: 'full'
```

**Files modified**:

- `apps/multimodal-service/src/routes/attachments.ts` — accept `processingMode`
- `apps/multimodal-service/src/services/multimodal-service.ts` — conditional job enqueue
- `apps/multimodal-service/src/jobs/scan-job.ts` — respect `processingMode` after validation
- `packages/database/src/models/attachment.model.ts` — add `processingMode`

### 1.4 Retry for Failed Processing

**Current state**: Attachments with `processingStatus: 'failed'` are permanently stuck. No API or UI affordance to retry.

**Design**:

**New endpoint**:

```
POST /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/retry
```

**Behavior**:

1. Validate `attachment.processingStatus === 'failed'` OR `attachment.scanStatus === 'error'`
2. Check `retryCount < 3` (prevent infinite retry loops)
3. Increment `retryCount`, clear `processingError`
4. Determine re-entry point:
   - If `scanStatus === 'error'`: reset to `scanStatus: 'pending'`, enqueue scan-job
   - If `scanStatus === 'clean'` and `processingStatus === 'failed'`: reset to `processingStatus: 'pending'`, enqueue process-job
5. Return `{ success: true, data: { retryCount, status: 'pending' } }`

**Schema change**:

```typescript
retryCount: number; // default: 0, max: 3
```

**Files modified**:

- `apps/multimodal-service/src/routes/attachments.ts` — add retry endpoint
- `apps/multimodal-service/src/services/multimodal-service.ts` — retry logic
- `packages/database/src/models/attachment.model.ts` — add `retryCount`
- `apps/runtime/src/routes/attachments.ts` — proxy retry to multimodal service

---

## Phase 2: Attachment Agent Tools & DSL

### 2.1 `type: attachment` Tool Parameter

**Current state**: `ToolParameter.type` (at `packages/compiler/src/platform/ir/schema.ts:670`) is declared as `type: string` — a plain string, not a constrained union. The `ablTypeToJsonSchema()` function in `apps/runtime/src/services/execution/prompt-builder.ts` (line ~77) handles known values via pattern matching: `string`, `integer`, `number`, `boolean`, `date`, `email`, `phone`, `url`, `object`, `json`, `map`, `array`, and array notation like `string[]`. No `attachment` case exists, so the LLM receives no hint that a parameter expects an attachment ID.

**Design**:

Add an `'attachment'` case to `ablTypeToJsonSchema()` in the runtime's `prompt-builder.ts`. No IR schema change needed since the type field is already a free-form string.

**Runtime** (`apps/runtime/src/services/execution/prompt-builder.ts` → `ablTypeToJsonSchema()`):

```typescript
case 'attachment':
  return {
    type: 'string',
    format: 'attachment-id',
    description: `${param.description ?? ''} (A valid session attachment ID. Use list_attachments to find available IDs.)`.trim()
  };
```

**Runtime validation** (`tool-binding-executor.ts`):

```typescript
// Before executing tool, validate attachment params (tenant + project isolation)
for (const param of toolDef.parameters.filter((p) => p.type === 'attachment')) {
  const attachmentId = toolInput[param.name];
  if (attachmentId) {
    const exists = await Attachment.findOne({
      _id: attachmentId,
      sessionId,
      tenantId,
      projectId, // Project isolation: prevent cross-project attachment access
    });
    if (!exists) {
      throw new ToolInputValidationError(`Invalid attachment ID: ${attachmentId}`);
    }
  }
}
```

**DSL syntax**:

```yaml
TOOL: process_document
  SIGNATURE: process_document(doc: attachment, language: string) → ProcessResult
```

**Files modified**:

- `apps/runtime/src/services/execution/prompt-builder.ts` — add `'attachment'` case to `ablTypeToJsonSchema()`
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` — attachment ID validation

### 2.2 `upload_attachment` Tool

**Current state**: Agents cannot register agent-generated content as session attachments. The underlying `AttachmentService.upload()` supports file buffers, but there is no agent-facing tool.

**Design**:

New system tool in `AttachmentToolExecutor`:

```typescript
// Tool schema
{
  name: 'upload_attachment',
  description: 'Upload agent-generated content as a session attachment. Accepts base64-encoded bytes or a URL.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Base64-encoded file content OR a publicly accessible URL' },
      source: { type: 'string', enum: ['base64', 'url'], description: 'Whether content is base64-encoded bytes or a URL to fetch' },
      filename: { type: 'string', description: 'Filename with extension (e.g., "report.pdf")' },
      mimeType: { type: 'string', description: 'MIME type of the content (e.g., "application/pdf")' },
      processingMode: { type: 'string', enum: ['full', 'scan-only', 'store-raw'], description: 'How to process the upload. Default: full' }
    },
    required: ['content', 'source', 'filename', 'mimeType']
  }
}

// Return value
{ attachmentId: string, filename: string, processingStatus: string }
```

**Implementation**:

- New internal endpoint: `POST /internal/attachments/from-agent`
  - Accepts JSON body (not multipart) with `{ content, source, filename, mimeType, processingMode, sessionId, tenantId, projectId }`
  - If `source === 'url'`: fetch content from URL (with SSRF protection: deny private IPs, max 50MB)
  - If `source === 'base64'`: decode buffer
  - Proceed through standard upload flow (storage → job enqueue based on processingMode)
- `AttachmentToolExecutor.execute('upload_attachment', ...)` calls `MultimodalServiceClient.uploadFromAgent()`

**Size limits**:

- base64: max 50MB decoded (67MB encoded)
- URL: max 50MB fetched content, enforced as a **streaming byte-count cutoff** — the download is aborted after 50MB received (not a post-download check), preventing slow-drip attacks
- Timeout: 30s for URL fetch
- SSRF protection: use the unified validator at `packages/shared-kernel/src/security/ssrf-validator.ts` (not the HTTP tool executor's copy, which imports from shared-kernel)

**Files modified**:

- `apps/runtime/src/tools/attachment-tool-executor.ts` — add upload_attachment handler
- `apps/multimodal-service/src/routes/attachments.ts` — add `/internal/attachments/from-agent`
- `apps/multimodal-service/src/services/multimodal-service.ts` — `uploadFromAgent()` method
- `apps/runtime/src/attachments/multimodal-service-client.ts` — `uploadFromAgent()` client method

### 2.3 `get_attachment_url` Tool

**Current state**: `get_attachment` returns extracted text and image descriptions but not a presigned download URL. The REST endpoint `GET .../attachments/:id/url` exists and works.

**Design**:

New system tool in `AttachmentToolExecutor`:

```typescript
{
  name: 'get_attachment_url',
  description: 'Get a temporary download URL for an attachment. Use this to pass file locations to external APIs.',
  input_schema: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', description: 'The attachment ID' },
      expiresIn: { type: 'number', description: 'URL validity in seconds (default: 3600, max: 86400)' },
      disposition: { type: 'string', enum: ['inline', 'attachment'], description: 'Content-Disposition header. "inline" for browser display, "attachment" for download.' }
    },
    required: ['attachmentId']
  }
}

// Return value
{ url: string, expiresInSeconds: number, filename: string, mimeType: string }
```

**Implementation**: Thin wrapper calling existing `MultimodalServiceClient.getDownloadUrl()`.

**Files modified**:

- `apps/runtime/src/tools/attachment-tool-executor.ts` — add get_attachment_url handler

### 2.4 `route_attachment` Tool

**Current state**: No built-in way to forward attachment bytes to an external system.

**Design**:

New system tool in `AttachmentToolExecutor`:

```typescript
{
  name: 'route_attachment',
  description: 'Forward an attachment to an external system via HTTP.',
  input_schema: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', description: 'The attachment ID to forward' },
      destination: { type: 'string', description: 'A DESTINATIONS name from the agent DSL, or an inline URL' },
      method: { type: 'string', enum: ['POST', 'PUT'], description: 'HTTP method (default: POST)' },
      headers: { type: 'object', description: 'Additional HTTP headers to include' },
      fieldName: { type: 'string', description: 'Multipart form field name (default: "file")' }
    },
    required: ['attachmentId', 'destination']
  }
}

// Return value
{ statusCode: number, responseBody: string, destinationUrl: string }
```

**Implementation flow**:

1. Resolve `destination`:
   - If matches a name in `agentIR.destinations[]` → use configured URL, method, auth, headers
   - If a URL string → use directly (with SSRF protection)
2. Get presigned download URL for the attachment
3. Stream the file from storage to the destination as `multipart/form-data`
4. Return the response status and body

**SSRF protection**: Use the unified SSRF validator at `packages/shared-kernel/src/security/ssrf-validator.ts`. Denies requests to private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1), link-local, and metadata endpoints (169.254.169.254).

**Timeout**: 60 seconds (configurable via destination config).

**Files modified**:

- `apps/runtime/src/tools/attachment-tool-executor.ts` — add route_attachment handler
- `apps/runtime/src/attachments/multimodal-service-client.ts` — add streaming download method

### 2.5 `DESTINATIONS` DSL Block

**Current state**: No DSL block for declaring named target endpoints.

**Design**:

New top-level DSL block compiled to IR:

**DSL syntax**:

```yaml
DESTINATIONS:
  crm_upload:
    url: https://crm.example.com/api/files
    method: POST
    auth: bearer # References an auth profile
    headers:
      X-Source: abl-agent
      X-Correlation-Id: '{{sessionId}}'
    timeout: 30000

  document_store:
    url: https://docs.internal.com/v2/upload
    method: PUT
    auth: api_key
    headers:
      X-API-Key: '{{secrets.DOC_STORE_KEY}}'
```

**IR representation**:

```typescript
interface DestinationDefinition {
  name: string;
  url: string;
  method: 'POST' | 'PUT';
  auth?: string;              // Auth profile name
  headers?: Record<string, string>;
  timeout?: number;           // ms, default 30000
}

// On AgentIR
destinations?: DestinationDefinition[];
```

**Secrets management**: Template markers like `{{secrets.DOC_STORE_KEY}}` are resolved at runtime, not compile time:

- Secrets are stored in the existing `ProjectSecret` collection (tenant + project scoped, AES-256 encrypted at rest)
- Resolution: `SecretResolver.resolve(tenantId, projectId, secretName)` → decrypted value
- Secret values are **never** included in trace events. The `route_attachment` tool executor must redact `Authorization` and any header value matching `{{secrets.*}}` patterns before emitting trace data
- Invalid secret references produce a clear error: `"Secret 'DOC_STORE_KEY' not found in project secrets"`

**Compiler changes**:

- New parser section for `DESTINATIONS:` block
- Validation: URL format, method enum, no duplicate names
- Template interpolation markers (`{{sessionId}}`, `{{secrets.*}}`) compiled to IR template expressions with type annotations (secret vs. context variable) so the runtime knows to use `SecretResolver` for secrets and session context for variables

**Files modified**:

- `packages/compiler/src/dsl/parser.ts` — parse DESTINATIONS block
- `packages/compiler/src/dsl/validator.ts` — validate destination definitions
- `packages/compiler/src/platform/ir/schema.ts` — `DestinationDefinition` type, add to `AgentIR`
- `packages/compiler/src/__tests__/` — parser/validator tests for DESTINATIONS
- `packages/database/src/models/project-secret.model.ts` — **new model** for `ProjectSecret` collection (tenant + project scoped, AES-256 encrypted `value` field)
- `apps/runtime/src/services/secret-resolver.ts` — **new service** for resolving `{{secrets.*}}` template markers at runtime

### 2.6 `AWAIT_ATTACHMENT` Flow Step

**Current state**: No flow step type to declaratively pause until a file is received. GATHER has no `type: attachment` field.

**Design**:

New flow step type that suspends execution until a matching attachment arrives:

**DSL syntax**:

```yaml
FLOW:
  steps:
    - AWAIT_ATTACHMENT:
        name: id_document
        prompt: 'Please upload your government-issued ID'
        accept:
          - image/*
          - application/pdf
        maxSize: 10MB
        timeout: 300s
        processingMode: full
        required: true
        onTimeout: GOTO timeout_handler
```

**IR representation**:

```typescript
interface AwaitAttachmentStep {
  type: 'await_attachment';
  name: string; // Variable name to store attachmentId
  prompt: string; // Prompt sent to user
  accept?: string[]; // MIME type patterns (glob-style)
  maxSizeBytes?: number; // Max file size
  timeoutMs?: number; // Max wait time
  processingMode?: ProcessingMode; // How to process the upload
  required?: boolean; // default: true
  maxRetries?: number; // default: 3
  onTimeout?: FlowTransition; // Where to go on timeout
  onReject?: FlowTransition; // Where to go if file doesn't match criteria
}
```

**Runtime execution** — `AwaitAttachmentExecutor`:

1. **Emit prompt**: Send the `prompt` message to the user
2. **Set session state**: `session.awaitingAttachment = { stepName, accept, maxSizeBytes, startedAt, timeoutMs }`
3. **Return control**: Yield back to the message loop (same pattern as GATHER)
4. **On next message with attachment**:
   - Validate attachment against `accept` patterns and `maxSizeBytes`
   - If valid: store `attachmentId` in flow context as `context[name]`, advance to next step
   - If invalid: send rejection message, re-prompt (up to `maxRetries` attempts, default 3, then `onReject`)
5. **On timeout**: Execute `onTimeout` transition
6. **On message without attachment**: Re-prompt "I'm waiting for a file upload. {prompt}"

**Reuse pattern**: Follows the same session-suspension mechanism as `GatherExecutor` — sets a pending state, returns, and resumes on the next matching input.

**Files modified**:

- `packages/compiler/src/dsl/parser.ts` — parse AWAIT_ATTACHMENT step
- `packages/compiler/src/dsl/validator.ts` — validate step config
- `packages/compiler/src/platform/ir/schema.ts` — `AwaitAttachmentStep` type
- `apps/runtime/src/services/execution/await-attachment-executor.ts` — new executor
- `apps/runtime/src/services/execution/flow-step-executor.ts` — wire AwaitAttachmentExecutor

---

## Phase 3: Thoughts & Reasoning Visibility

### 3.1 Always Emit Reason as Thought

**Current state**: The `thought` field is only added to tool schemas when `enableThinking: true` (in `prompt-builder.ts`). The `reason` field is always required on tool calls. A `decision` trace event containing `reasoning` is already emitted for every tool call (line ~1784-1792 in `reasoning-executor.ts`), but this goes only to the Observatory. The `tool_thought` event (which the chat UI consumes for the thought bulb) is only emitted when `thought` is truthy (line ~1793: `if (thought) { onTraceEvent... }`), and since `thought` is only present when `enableThinking: true`, agents with thinking disabled produce no chat-visible thoughts despite the `decision` event being emitted.

**Design**:

Decouple `tool_thought` emission from the `enableThinking` flag, so the chat UI receives thought content regardless:

**When `enableThinking: true`** (no change):

- Inject `thought` and `reason` into tool schemas
- Emit `tool_thought` with both `thought` (detailed) and `reasoning` (concise)

**When `enableThinking: false`** (new behavior):

- `reason` remains required in tool schemas (already the case)
- `thought` is NOT injected into schemas (already the case)
- **New**: Emit `tool_thought` event with `thought: null` and `reasoning: reason`
- Chat UI renders the `reasoning` field in the thought bulb

**Change in ReasoningExecutor** (lines ~1790-1803, ~2233-2243):

```typescript
// Before: only emit if thought is truthy
// After: emit if thought OR reason is present
if (thought || reason) {
  onTraceEvent?.({
    type: 'tool_thought',
    data: {
      toolName: toolCall.name,
      thought: thought ?? null,
      reasoning: reason,
      agent: session.agentName,
    },
  });
}
```

**Chat UI change** (WebSocketContext.tsx, MessageList.tsx):

- When rendering a `tool_thought`, prefer `thought` if present, fall back to `reasoning`
- Label: "Thinking..." when `thought` present, "Reasoning..." when only `reasoning`

**Files modified**:

- `apps/runtime/src/services/execution/reasoning-executor.ts` — always emit tool_thought when reason exists
- `apps/studio/src/components/chat/MessageList.tsx` — render reasoning fallback

### 3.2 In-Progress Signal During Tool Execution

**Current state**: `tool_call_start` and `tool_call_end` events exist in the LLM streaming layer (`session-llm-client.ts` lines 171-173) as SSE chunk types that signal the LLM is constructing/finishing a tool call JSON. These are **not** the same as tool execution — they represent the LLM output phase, not the runtime execution phase. No events currently signal when the runtime begins/completes executing a tool after the LLM has returned.

**Design**:

Forward tool execution state to the chat UI via new `tool_exec_start`/`tool_exec_end` trace events. These are deliberately named differently from the existing LLM-layer `tool_call_start`/`tool_call_end` SSE events to avoid collision — the existing events signal "LLM is outputting a tool call", while the new events signal "runtime is executing a tool."

**Runtime** — emit trace events for tool execution lifecycle:

```typescript
// In reasoning-executor.ts, around tool execution (after LLM returns tool calls)
onTraceEvent?.({ type: 'tool_exec_start', data: { toolName, toolCallId, agent } });
// ... execute tool ...
onTraceEvent?.({
  type: 'tool_exec_end',
  data: { toolName, toolCallId, durationMs, success, agent },
});
```

**Add to TraceEventType union** in `apps/runtime/src/types/index.ts`: `'tool_exec_start' | 'tool_exec_end'`

**Studio WebSocketContext** — handle execution events:

```typescript
case 'tool_exec_start':
  // Add to activeToolCalls set in session store
  addActiveToolCall({ toolName, toolCallId, startedAt: Date.now() });
  break;
case 'tool_exec_end':
  removeActiveToolCall(toolCallId);
  break;
```

**Chat UI** — `ToolExecutionIndicator` component:

- Renders below the current thought card (or standalone if no thought)
- Shows animated spinner + "Running {toolName}..." for each active tool
- Multiple concurrent tools shown as stacked list
- Auto-removed when `tool_exec_end` received
- Fade-out animation on completion

**Files modified**:

- `apps/runtime/src/services/execution/reasoning-executor.ts` — emit tool_exec_start/end trace events
- `apps/runtime/src/types/index.ts` — add `tool_exec_start`, `tool_exec_end` to TraceEventType
- `apps/studio/src/contexts/WebSocketContext.tsx` — handle tool execution events
- `apps/studio/src/store/session-store.ts` — `activeToolCalls` state
- `apps/studio/src/components/chat/ToolExecutionIndicator.tsx` — new component

### 3.3 Scripted Step Thoughts

**Current state**: Flow steps that execute without an LLM call (RESPOND, COLLECT, SET, GOTO) emit `flow_step_enter`/`flow_step_exit` events but no user-facing thought. Users see nothing between scripted steps.

**Design**:

Emit a new `step_thought` trace event from `flow-step-executor.ts` for each scripted step:

**Event structure**:

```typescript
{
  type: 'step_thought',
  data: {
    stepType: 'respond' | 'collect' | 'set' | 'goto' | 'condition' | 'await_attachment',
    stepName: string,
    summary: string,   // Human-readable description of what the step does
    agent: string,
  }
}
```

**Auto-generated summaries**:

- `RESPOND`: `"Sending response"` (don't leak message content into thought)
- `COLLECT`: `"Collecting: {fieldName}"`
- `SET`: `"Setting {varName}"`
- `GOTO`: `"Navigating to: {targetStep}"`
- `CONDITION`: `"Evaluating: {conditionPreview}"`
- `AWAIT_ATTACHMENT`: `"Waiting for file upload"`

**Chat UI rendering**:

- `StepThoughtItem` component — same collapsible card as `ThoughtItem` but with a flow icon (GitBranch from Lucide) instead of lightbulb
- Collapsed by default (less prominent than LLM thoughts)

**Opt-out**: `EXECUTION: show_step_thoughts: false` in agent DSL. Default: `true`.

**Files modified**:

- `apps/runtime/src/services/execution/flow-step-executor.ts` — emit step_thought events
- `apps/runtime/src/types/index.ts` — add `step_thought` to TraceEventType
- `apps/studio/src/contexts/WebSocketContext.tsx` — handle step_thought
- `apps/studio/src/components/chat/StepThoughtItem.tsx` — new component
- `packages/compiler/src/platform/ir/schema.ts` — add `show_step_thoughts` to `ExecutionConfig`
- `packages/compiler/src/dsl/parser.ts` — parse `show_step_thoughts` from `EXECUTION:` block

**Note**: `show_step_thoughts` and `enableThinking` are orthogonal settings. `enableThinking` controls whether the LLM emits detailed internal reasoning (via the `thought` field on tool calls). `show_step_thoughts` controls whether scripted flow steps (RESPOND, SET, GOTO, etc.) emit visibility events to the chat UI. Both can be independently enabled/disabled.

### 3.4 Thought → LLM Call Linkage

**Current state**: `tool_thought` events carry `agentName` and timestamp but no reference to the parent `llm_call` event. Correlation in the Observatory requires manual timestamp matching.

**Design**:

Thread the LLM call's `spanId` through to `tool_thought` events:

**In ReasoningExecutor**, the LLM call already has a `spanId` from the trace system. When extracting thoughts from tool responses:

```typescript
onTraceEvent?.({
  type: 'tool_thought',
  data: {
    toolName,
    thought,
    reasoning: reason,
    agent: session.agentName,
    parentLlmCallSpanId: currentLlmCallSpanId, // NEW
  },
});
```

**Observatory enhancement**: When viewing a thought, clicking "View prompt context" navigates to the parent LLM call span, showing: system prompt, message history, tool definitions, and the full LLM response.

**Chat UI**: Add a subtle "View context" link on expanded thought cards that deep-links to `observatory/traces/{traceId}/spans/{parentLlmCallSpanId}`.

**Files modified**:

- `apps/runtime/src/services/execution/reasoning-executor.ts` — thread spanId to tool_thought
- `apps/studio/src/components/chat/MessageList.tsx` — add "View context" link

### 3.5 Voice Thought Handling

**Current state**: The SDK handler sends `trace_event` messages over WebSocket (including `tool_thought`), but the voice-specific path has no mechanism to surface thoughts to users. No verbal acknowledgement on `response_start`, no `onThought` callback, no companion visual panel, no substitution mechanism.

**Design — 4 layers**:

#### Layer 1: Verbal Filler on Processing Start

When `response_start` fires in the voice path, inject a brief TTS acknowledgement before the full response begins:

```typescript
// In sdk-handler.ts voice message handling
if (voiceConfig?.acknowledgement?.enabled) {
  const phrase = pickRandom(voiceConfig.acknowledgement.phrases);
  // Send phrase to TTS, emit as voice_realtime_audio before main response
  await synthesizeAndSend(ws, phrase, ttsService);
}
```

**Configuration** (per deployment `voiceConfig`):

```typescript
acknowledgement: {
  enabled: boolean;           // default: true
  phrases: string[];          // default: ["Let me check on that.", "One moment.", "Working on it."]
  minDelayMs: number;         // Only speak if response takes longer than this (default: 2000ms)
}
```

The `minDelayMs` prevents acknowledgements on fast responses — only speak filler if the response will actually take time.

#### Layer 2: `onThought` Callback for Embedding Apps

Add `onThought` to `RealtimeVoiceExecutorConfig`:

```typescript
interface RealtimeVoiceExecutorConfig {
  // ... existing callbacks ...
  onThought?: (thought: {
    text: string;
    toolName?: string;
    agentName: string;
    isExecuting: boolean;
  }) => void;
}
```

**SDK handler wiring**: When a `tool_thought` trace event fires during a voice session, call `onThought` and emit a `voice_thought` WebSocket message:

```typescript
send(ws, {
  type: 'voice_thought',
  data: { text: thought.reasoning || thought.thought, toolName, agentName, isExecuting: true },
});
```

#### Layer 3: Companion Visual Panel (Client Concern)

The runtime emits `voice_thought` messages. Client apps (SDK widget, web app) can render these in a sidebar or overlay. This is purely a client-side rendering concern — no additional runtime work needed beyond Layer 2.

**Recommended client behavior**:

- Show thought text in a floating card overlaying the voice UI
- Auto-dismiss after 5 seconds or when next message arrives
- Show tool execution progress indicator while `isExecuting: true`

#### Layer 4: Thought-to-Speech (Opt-in)

For pure voice experiences (no screen), optionally speak a condensed version of the thought:

```typescript
voiceConfig.speakThoughts: {
  enabled: boolean;          // default: false (adds latency)
  maxWords: number;          // default: 15
  prefix: string;            // default: "I'm going to"
}
```

When enabled:

1. Take the `reasoning` field from the thought
2. Truncate to `maxWords` words
3. Prepend `prefix`
4. Send to TTS and emit before tool execution

**Note**: This is opt-in because it adds ~500ms-1s latency per tool call. Only recommended for long-running tools where the silence would be confusing. A hard TTS timeout of 2 seconds applies — if synthesis takes longer (e.g., due to TTS service latency), the thought is silently dropped to avoid blocking the response.

**Files modified**:

- `apps/runtime/src/services/voice/realtime-voice-executor.ts` — add onThought callback
- `apps/runtime/src/websocket/sdk-handler.ts` — emit voice_thought, handle acknowledgement
- `apps/runtime/src/websocket/events.ts` — add voice_thought message type

---

## Phase 4: Studio UX & Tool Filtering

### 4.1 Studio UI Attachment Gaps

#### 4.1a Download Button

Add a download icon button to `AttachmentCard` in the message history:

```tsx
<IconButton
  icon={<Download size={14} />}
  onClick={async () => {
    const { url } = await fetchAttachmentUrl(attachmentId);
    window.open(url, '_blank');
  }}
  title="Download file"
/>
```

Call `GET /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/url?disposition=attachment` and open the presigned URL.

#### 4.1b Drag-and-Drop & Clipboard Paste

Add event handlers to the chat input container:

```tsx
// ChatInput.tsx
const handleDrop = (e: DragEvent) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files);
  files.forEach((file) => uploadAttachment(file));
};

const handlePaste = (e: ClipboardEvent) => {
  const items = Array.from(e.clipboardData.items);
  const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile());
  files.forEach((file) => uploadAttachment(file));
};
```

Visual feedback:

- Drop zone overlay with dashed border and "Drop files here" text on `dragover`
- Upload progress indicator per file

#### 4.1c Audio/Video MIME Types

Update the file input `accept` attribute:

```tsx
// Current: accept="image/*,application/pdf,.doc,.docx,.txt,.csv,.json,.xml"
// Updated:
accept =
  'image/*,audio/*,video/*,application/pdf,.doc,.docx,.txt,.csv,.json,.xml,.mp3,.wav,.mp4,.webm';
```

The backend already supports audio (Whisper transcription) and video (ffmpeg + Whisper) processing.

#### 4.1d Image Thumbnail Preview

For image attachments in the message bubble, render an inline thumbnail:

```tsx
{
  attachment.category === 'image' && (
    <img
      src={thumbnailUrl} // Fetched via presigned URL for thumbnailStorageKey
      alt={attachment.originalFilename}
      className="max-w-48 rounded-md cursor-pointer"
      onClick={() => openFullSize(attachment)}
    />
  );
}
```

The `thumbnailStorageKey` is already generated by `process-job.ts` during image processing. Fetch via the existing presigned URL endpoint.

#### 4.1e Per-Project Attachment Configuration

Add an "Attachments" tab in project settings with fields:

| Setting                 | Type           | Default             |
| ----------------------- | -------------- | ------------------- |
| `enabled`               | boolean        | Inherit from tenant |
| `maxFileSize`           | number (bytes) | Inherit from tenant |
| `allowedMimeTypes`      | string[]       | Inherit from tenant |
| `attachmentPiiPolicy`   | enum           | Inherit from tenant |
| `defaultProcessingMode` | enum           | `'full'`            |

**Files modified**:

- `apps/studio/src/components/chat/AttachmentCard.tsx` — download button
- `apps/studio/src/components/chat/ChatInput.tsx` — drag-drop, paste, audio/video accept
- `apps/studio/src/components/chat/MessageBubble.tsx` — image thumbnail
- `apps/studio/src/components/settings/AttachmentSettingsTab.tsx` — new component
- `apps/studio/src/app/api/projects/[id]/settings/attachments/route.ts` — settings endpoint

### 4.2 Dynamic Tool Filtering

**Current state**: An opt-in pipeline-based `tool-filter.ts` exists that uses a separate LLM call to select relevant tools. By default, the full tool set is injected into every LLM call, inflating token usage.

**Design — Hybrid Contextual Tool Filtering**:

Add a zero-LLM-cost rule-based filter as the default mode, keeping the existing LLM filter as an opt-in upgrade:

#### Mode 1: `auto` (default — rule-based, no LLM cost)

**State-based rules**:

- GATHER active → only `_extract_entities` + tools tagged `gather_compatible`
- AWAIT_ATTACHMENT active → only attachment tools
- First turn in conversation → full tool set (cold start)
- Handoff imminent (routing signal detected) → routing tools + target info

**Relevance scoring**:

- Tools are tagged with `categories` at compile time (e.g., `['search']`, `['file_management']`)
- Scoring algorithm:
  1. Tokenize user message: lowercase, split on whitespace/punctuation, remove stop words (top 50 English stop words)
  2. For each tool: combine `description` + `categories` + `parameter names` into a token bag (same tokenization)
  3. Score = |intersection(message_tokens, tool_tokens)| / |tool_tokens| (Jaccard-like overlap, normalized by tool token count to avoid bias toward verbose descriptions)
  4. Ties broken by tool declaration order in the DSL (earlier = higher priority)
- Include top-K tools (default K=20) + all system tools + tools used in last 3 turns (recency boost)

**Implementation**:

```typescript
function filterToolsByContext(
  tools: ToolDefinition[],
  sessionState: SessionState,
  lastMessage: string,
  recentToolNames: string[],
  config: ToolFilterConfig,
): ToolDefinition[] {
  // 1. State-based mandatory inclusions/exclusions
  // 2. Score remaining by relevance
  // 3. Take top-K + system tools + recent tools
}
```

#### Mode 2: `full` (no filtering)

Inject all tools every call. Current behavior. For agents with small tool sets where filtering overhead isn't worth it.

#### Mode 3: `llm` (existing pipeline filter)

Existing `tool-filter.ts` LLM-based selection. Best for agents with 50+ tools where rule-based isn't selective enough.

**DSL configuration**:

```yaml
EXECUTION:
  tool_filtering:
    mode: auto | full | llm # default: auto
    max_tools: 20 # for auto mode
    categories: # optional: override auto-detected categories
      search_docs: ['search', 'knowledge']
      send_email: ['communication']
```

**Files modified**:

- `apps/runtime/src/services/pipeline/tool-filter.ts` — add rule-based mode
- `apps/runtime/src/services/execution/reasoning-executor.ts` — integrate contextual filter before LLM call
- `packages/compiler/src/platform/ir/schema.ts` — `tool_filtering` config in ExecutionConfig

---

## Implementation Priority & Dependencies

```
Phase 1 (Sprint 1-2) — PII Safety [P1]
├── 1.1 PII detection on attachments (process-job)
├── 1.2 PII redaction interceptor (MessagePreprocessor)
├── 1.3 Per-upload processing mode
└── 1.4 Retry for failed processing
    No dependencies. Highest urgency.

Phase 2 (Sprint 2-4) — Attachment Tools & DSL
├── 2.1 type: attachment parameter
├── 2.2 upload_attachment tool
├── 2.3 get_attachment_url tool        ← No dependencies
├── 2.4 route_attachment tool          ← Depends on 2.5 (DESTINATIONS)
├── 2.5 DESTINATIONS DSL block
└── 2.6 AWAIT_ATTACHMENT flow step     ← Independent
    Depends on Phase 1 for PII-safe upload flow.

Phase 3 (Sprint 3-5) — Thoughts & Reasoning
├── 3.1 Always emit reason as thought  ← No dependencies
├── 3.2 In-progress tool signals       ← No dependencies
├── 3.3 Scripted step thoughts         ← No dependencies
├── 3.4 Thought → LLM linkage         ← Depends on 3.1
└── 3.5 Voice thought handling         ← Depends on 3.1, 3.2
    Independent of Phases 1-2.

Phase 4 (Sprint 4-6) — Studio UX & Tools
├── 4.1a Download button               ← No dependencies (uses existing presigned URL endpoint)
├── 4.1b Drag-drop & paste             ← No dependencies (uses existing upload endpoint)
├── 4.1c Audio/video MIME types         ← No dependencies (backend already supports these)
├── 4.1d Image thumbnail preview        ← No dependencies (thumbnailStorageKey already generated)
├── 4.1e Per-project attachment config ← Depends on Phase 1 (PII policy setting)
└── 4.2 Dynamic tool filtering         ← Independent
```

---

## Migration & Rollout

### Phase 1 — PII Safety

- **Default behavior change**: `attachmentPiiPolicy` defaults to `'redact'`, which means existing deployments will start redacting PII from attachment content injected into LLM calls
- **Migration**: Run a batched backfill job to populate `hasPII` and `piiDetections` on existing attachments with `processingStatus: 'completed'`. The job processes in cursor-based batches of 100 documents, scoped per-tenant, with a progress checkpoint (last processed `_id`) persisted to a `migration_checkpoints` collection for idempotent resume after failure. Rate-limited to avoid impacting production read latency.
- **Feature flag**: `ATTACHMENT_PII_REDACTION_ENABLED` (default: true) as a kill switch during rollout

### Phase 2 — Attachment Tools

- **Additive**: New tools are opt-in (agents must reference them in TOOLS section)
- **DESTINATIONS**: New DSL block, no impact on existing agents
- **AWAIT_ATTACHMENT**: New step type, no impact on existing flows

### Phase 3 — Thoughts

- **Behavior change**: Agents with `enableThinking: false` will now emit thought events (from `reason`). This is visible in the chat UI.
- **Feature flag**: `ALWAYS_EMIT_REASON_AS_THOUGHT` (default: true) to allow rollback
- **Voice**: All voice thought features are opt-in via `voiceConfig`

### Phase 4 — Studio UX & Tool Filtering

- **Studio UI**: Additive features, no breaking changes
- **Tool filtering**: `mode: auto` is the new default but produces identical results for agents with ≤20 tools (all tools pass through)

---

## Testing Strategy

### Phase 1

- Unit: `detectPII(processedContent)` returns correct detections for each PII type
- Unit: `MessagePreprocessor` redacts/blocks/allows based on policy
- Integration: Upload file with PII → verify redacted content in LLM call
- E2E: End-to-end flow with PII document → agent response doesn't contain raw PII

### Phase 2

- Unit: Each new tool executor (upload, url, route) with mock multimodal service
- Integration: `upload_attachment` → `get_attachment_url` → verify URL works
- Compiler: AWAIT_ATTACHMENT parsing, DESTINATIONS parsing, type: attachment validation
- E2E: Flow with AWAIT_ATTACHMENT step → upload file → flow continues

### Phase 3

- Unit: ReasoningExecutor emits tool_thought with reason when thinking disabled
- Integration: WebSocket receives tool_thought, tool_call_start/end events
- UI: Thought card renders, tool execution indicator shows/hides
- Voice: voice_thought emitted, acknowledgement spoken with delay threshold

### Phase 4

- Unit: Rule-based tool filter selects correct tools for each state
- Integration: Agent with 30 tools → verify ≤20 injected per call
- UI: Drag-drop upload, paste, download, thumbnail rendering
- A/B: Compare token usage with auto filter vs full injection
