# Agent Blueprint Language (ABL) Runtime Architecture

## 1. Overview

### Development Mode (Current)

The current runtime is designed for development iteration, not production:

```
.agent.abl --> parse --> compile --> IR (in memory) --> execute
     ^
     +-- Re-read on every agent load
```

**Issues for production:**

1. **No caching** - Recompiles on every load
2. **No hot reload** - Must manually reload agents
3. **No versioning** - Can't rollback or A/B test
4. **Filesystem scanning** - `discoverAgents()` walks directories on every call
5. **No precompilation** - IR generated at runtime

### Recommended Production Architecture

```bash
# Build step: ABL --> IR JSON files
pnpm compile:agents

# Output structure:
dist/
  agents/
    booking_agent.ir.json      # Compiled IR
    booking_agent.meta.json    # Version, checksum, timestamps
    booking_agent.graph.json   # Static graph for visualization
```

**IR Schema with Versioning:**

```typescript
interface CompiledAgent {
  // Versioning
  version: string; // Semantic version from ABL
  checksum: string; // SHA256 of source ABL
  compiledAt: string; // ISO timestamp
  compilerVersion: string; // Compiler version used

  // Content
  ir: AgentIR; // The compiled IR
  staticGraph: StaticGraph; // Pre-extracted graph

  // Metadata
  source: {
    path: string;
    size: number;
    lastModified: string;
  };
}
```

---

## 2. Message Execution Flow -- Full Path

Complete execution path when a user sends a chat message, covering every file and method touched in execution order.

### Flow Diagram (Summary)

```
CLIENT (Browser)
  |
  |  WebSocket: { type: 'send_message', sessionId, text }
  v
+---------------------------------------------------------------+
| 1. SERVER BOOTSTRAP                                            |
|    index.ts --> server.ts                                      |
|    Config load, HTTP + WS server setup, route registration     |
+-----------------------------+---------------------------------+
                              v
+---------------------------------------------------------------+
| 2. WEBSOCKET HANDLER                                           |
|    websocket/handler.ts                                        |
|    handleConnection() --> handleMessage() --> handleSendMessage() |
+-----------------------------+---------------------------------+
                              v
+---------------------------------------------------------------+
| 3. RUNTIME EXECUTOR                                            |
|    services/runtime-executor.ts                                |
|    executeMessage() --> executeWithTools()                      |
|    +--------------------------------------+                    |
|    |  AGENTIC LOOP (max 10 iterations)    |                    |
|    |  +--------------+                    |                    |
|    |  | LLM Call     |<---- tool results  |                    |
|    |  +------+-------+                    |                    |
|    |         v                            |                    |
|    |  +--------------+   no tools         |                    |
|    |  | Tool Calls?  |----------> BREAK   |                    |
|    |  +------+-------+                    |                    |
|    |         v yes                        |                    |
|    |  +--------------+                    |                    |
|    |  | Execute Tool |----> loop back     |                    |
|    |  +--------------+                    |                    |
|    +--------------------------------------+                    |
+-----------------------------+---------------------------------+
                              v
+---------------------------------------------------------------+
| 4. LLM CLIENT                                                  |
|    services/llm/session-llm-client.ts                          |
|    chatWithToolUse() --> resolveConfig() --> provider.completeWithTools() |
+-----------------------------+---------------------------------+
                              v
+---------------------------------------------------------------+
| 5. MODEL RESOLUTION                                            |
|    services/llm/model-resolution.ts                            |
|    6-level chain: Agent IR --> Agent DB --> Project --> Tenant  |
|                   --> Platform Demo --> System Default          |
+-----------------------------+---------------------------------+
                              v
+---------------------------------------------------------------+
| 6. LLM PROVIDER                                                |
|    @abl/compiler: platform/llm/providers/{openai,anthropic}.ts |
|    HTTP call to OpenAI/Anthropic/Gemini API                    |
+-----------------------------+---------------------------------+
                              v
+---------------------------------------------------------------+
| 7. RESPONSE STREAMING                                          |
|    websocket/handler.ts                                        |
|    responseStart --> responseChunk(s) --> responseEnd           |
|    + traceEvent(s) + stateUpdate + actionTaken                 |
+-----------------------------+---------------------------------+
                              v
CLIENT (Browser receives streamed response)
```

---

### 2.1 Phase 0: ABL Loading (Parse --> Compile --> IR --> Cache)

Before any messages flow, the agent must be loaded and compiled.

#### Pre-Execution ABL Compilation File Chain

| #   | File                                             | Key Method                | Output                                         |
| --- | ------------------------------------------------ | ------------------------- | ---------------------------------------------- |
| 1   | `packages/core/src/parser/agent-based-parser.ts` | `parseAgentBasedABL(dsl)` | `ParseResult { document: AgentBasedDocument }` |
| 2   | `packages/compiler/src/platform/ir/compiler.ts`  | `compileABLtoIR([doc])`   | `CompilationOutput { agents }`                 |
| 3   | `apps/runtime/src/services/session/ir-cache.ts`  | `TwoTierIRCache.set()`    | L1 LRU + L2 Redis                              |
| 4   | `apps/runtime/src/services/runtime-executor.ts`  | `createSession()`         | Wired `RuntimeSession`                         |
| 5   | `apps/runtime/src/services/runtime-executor.ts`  | `wireToolExecutor()`      | `ToolBindingExecutor` or `MockToolExecutor`    |
| 6   | `apps/runtime/src/services/runtime-executor.ts`  | `wireLLMClient()`         | `SessionLLMClient` with model resolution       |

#### Data Transformations

```
ABL Source Text
    |  parseAgentBasedABL()
    v
AgentBasedDocument (AST)
    |  compileABLtoIR()
    v
CompilationOutput { agents: { "Sales_Agent": AgentIR, ... } }
    |  computeIRHash() --> SHA256
    v
L1 Cache (pod-local LRU, 50 entries) + L2 Store (Redis/Memory)
    |  createSession()
    v
RuntimeSession {
  agentIR,
  compilationOutput,
  toolExecutor: ToolBindingExecutor | MockToolExecutor,
  llmClient: SessionLLMClient,
  threads: [],
  data: { values: {}, gatheredKeys: Set },
  conversationHistory: [],
}
```

#### Key Data Structures

**AgentIR** (compiler output, used at runtime):

```typescript
interface AgentIR {
  metadata: { name; version; type; source_hash };
  execution: { mode: 'reasoning' | 'scripted'; timeouts; model };
  identity: { goal; persona; system_prompt };
  tools: ToolDefinition[];
  gather: GatherConfig;
  constraints: ConstraintConfig;
  coordination: { delegates; handoffs; escalation };
  completion: CompletionConfig;
  flow?: FlowConfig; // scripted mode only
  routing?: RoutingConfig; // supervisor only
}
```

---

### 2.2 Phase 1: Message Reception (WebSocket Handler)

#### Files

| File                                    | Role                                       |
| --------------------------------------- | ------------------------------------------ |
| `apps/runtime/src/index.ts`             | Bootstrap: loads config, starts server     |
| `apps/runtime/src/server.ts`            | Express + WebSocket server, route mounting |
| `apps/runtime/src/websocket/handler.ts` | Connection management, message routing     |

#### Call Chain

```
index.ts:main()                          [line 13]
  --> loadConfig()                       load env-based config (Zod validated)
  --> startServer()                      from server.ts

server.ts:startServer()                  [line 157]
  --> Express app with routes
  --> WebSocketServer at /ws, /ws/sdk
  --> upgrade handler routes to correct WSS

handler.ts:handleConnection(ws, req)     [line 50]
  --> Extract auth token from `Sec-WebSocket-Protocol: web-debug-auth,<access_token>` [line 58]
  --> Reject missing/invalid bearer token before client state is created
  --> Extract userId                     [line 62]
  --> Store client state                 [line 72]
  --> ws.on('message') --> handleMessage() [line 89]

handler.ts:handleMessage(ws, data)       [line 121]
  --> Parse JSON message                 [line 130]
  --> Route by type:
      'load_agent'    --> handleLoadAgent()
      'send_message'  --> handleSendMessage()   <-- USER MESSAGE
      'reset_session' --> handleResetSession()
      'run_test'      --> handleRunTest()
      'get_state'     --> handleGetState()
```

---

### 2.3 Phase 2: Message Processing (handleSendMessage)

**File**: `apps/runtime/src/websocket/handler.ts` -- `handleSendMessage()` [line 408]

#### Steps

1. **Retrieve session** from `TestSessionService.getSession(sessionId)` [line 414]
2. **Add user message** via `TestSessionService.addUserMessage()` [line 420]
3. **Get runtime session** and trace emitter [line 427]
4. **Send `responseStart`** to client [line 436]
5. **Call executor** with streaming callbacks [line 465]:

```typescript
const result = await executor.executeMessage(
  runtimeSession.id,
  text,
  (chunk) => {
    // Stream each chunk to client
    send(ws, ServerMessages.responseChunk(sessionId, responseMessageId, chunk));
  },
  (event) => {
    // Forward trace events to client + store
    send(ws, ServerMessages.traceEvent(sessionId, traceEvent));
    getTraceStore().addEvent(sessionId, traceEvent);
  },
);
```

6. **Send `responseEnd`** with full response text [line 492]
7. **Send `stateUpdate`** with gather progress, context [line 504]
8. **Send `actionTaken`** (continue/handoff/escalate/complete) [line 526]

---

### 2.4 Phase 3: Runtime Executor (executeMessage)

**File**: `apps/runtime/src/services/runtime-executor.ts` [line 1567]

```typescript
async executeMessage(
  sessionId: string,
  userMessage: string,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void
): Promise<ExecutionResult>
```

#### Steps

| Step | Line | Action                                                                  |
| ---- | ---- | ----------------------------------------------------------------------- |
| 1    | 1573 | Get session from `this.sessions` map                                    |
| 2    | 1584 | Check if session/thread is completed or escalated                       |
| 3    | 1625 | `ensureSessionLLMClient()` -- wire LLM if not yet done                  |
| 4    | 1630 | **Mode detection**: `currentFlowStep` set --> Flow mode, else Reasoning |
| 5    | 1640 | Add user message to `conversationHistory`                               |
| 6    | 1644 | Emit incoming message trace event                                       |
| 7    | 1653 | `checkConstraints(session)` -- pre-execution guardrails                 |
| 8    | 1659 | `buildSystemPrompt(session)` -- generate full system instructions       |
| 9    | 1662 | `buildTools(session)` -- compile tool definitions + action tools        |
| 10   | 1665 | **`executeWithTools()`** -- enter the agentic loop                      |

---

### 2.5 Phase 4: Agentic Loop (executeWithTools, max 10 iterations)

**File**: `apps/runtime/src/services/runtime-executor.ts` [line 3263]

This is the core loop where LLM calls and tool executions happen iteratively.

#### Pre-Loop Setup

| Line | Action                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 3280 | Build messages array from `session.conversationHistory`                                                               |
| 3296 | **GATHER extraction**: if agent has GATHER fields, call `extractEntitiesWithLLM()` to pull entities from user message |
| 3341 | Post-extraction constraint check                                                                                      |

#### Loop (max 10 iterations)

```
WHILE iterations < 10:
  |
  +-- 1. LLM CALL [line 3355]
  |     result = session.llmClient.chatWithToolUse(
  |       systemPrompt, messages, tools, 'response_gen')
  |
  +-- 2. EMIT TRACE [line 3359]
  |     onTraceEvent({ type: 'llm_call', data: {
  |       model, tokens, duration, messages, response,
  |       rawRequest, rawResponse }})
  |
  +-- 3. CHECK TOOL CALLS [line 3393]
  |     |
  |     +-- YES: tool calls present
  |     |    +-- Add assistant message with tool_use blocks to messages [line 3395]
  |     |    +-- Stream intermediate text via onChunk [line 3400]
  |     |    +-- FOR EACH tool call:
  |     |    |    +-- executeToolCall() [line 3408]
  |     |    |         +-- __handoff__  --> handleHandoff()  [line 3502, breakLoop=true]
  |     |    |         +-- __delegate__ --> handleDelegate() [line 3510]
  |     |    |         +-- __complete__ --> handleComplete() [line 3515, breakLoop=true]
  |     |    |         +-- __escalate__ --> handleEscalate() [line 3524, breakLoop=true]
  |     |    |         +-- regular tool --> toolExecutor.execute(name, input, 30000) [line 3533]
  |     |    +-- Add tool results as user message [line 3444]
  |     |    +-- CONTINUE loop (next LLM call with tool results)
  |     |
  |     +-- NO: text-only response
  |          +-- finalResponse = result.text; BREAK [line 3454]
  |
  +-- 4. BREAK if breakLoop flag set (handoff/complete/escalate)
```

#### Post-Loop

| Line | Action                                                      |
| ---- | ----------------------------------------------------------- |
| 3465 | Add final response to `session.conversationHistory`         |
| 3469 | Stream via `onChunk()` if action is 'continue'              |
| 3474 | Return `ExecutionResult { response, action, stateUpdates }` |

---

### 2.6 Phase 5: LLM Call (SessionLLMClient, Model Resolution)

**File**: `apps/runtime/src/services/llm/session-llm-client.ts`

#### chatWithToolUse() [line 219]

```typescript
async chatWithToolUse(
  systemPrompt: string,
  messages: AnthropicMessage[],
  tools: AnthropicTool[],
  operationType: OperationType = 'response_gen'
): Promise<ChatResult>
```

| Step | Line | Action                                                                              |
| ---- | ---- | ----------------------------------------------------------------------------------- |
| 1    | 225  | `resolveConfig(operationType)` -- 6-level model resolution                          |
| 2    | 226  | `getOrCreateProvider(provider, apiKey, baseUrl)` -- cached provider lookup/creation |
| 3    | 227  | `stripProviderPrefix(modelId)` -- remove `openai/` prefix for direct calls          |
| 4    | 232  | `provider.completeWithTools(systemPrompt, messages, options)`                       |
| 5    | 245  | `toChatResult(result, resolvedModel)` -- normalize response                         |

#### toChatResult() [line 370]

Maps compiler's `ToolCompletionResult` to runtime's `ChatResult`:

```typescript
ChatResult {
  text: string;
  toolCalls: Array<{ id, name, input }>;
  stopReason: string;
  rawContent: Array<TextContent | ToolUseContent>;
  usage?: { inputTokens, outputTokens };
  resolvedModel?: { modelId, provider, source };
  rawRequest?: unknown;    // Exact JSON sent to LLM API
  rawResponse?: unknown;   // Exact JSON received from LLM API
}
```

#### Model Resolution Chain

**File**: `apps/runtime/src/services/llm/model-resolution.ts`

6-level resolution chain (first match wins):

| Level | Source                                     | Example                                               |
| ----- | ------------------------------------------ | ----------------------------------------------------- |
| 1     | Agent IR `operation_models[operationType]` | ABL defines `MODEL: gpt-4o`                           |
| 2     | Agent DB (AgentModelConfig overrides)      | Admin sets per-agent model                            |
| 3     | Project DB (default ModelConfig)           | Project-level default                                 |
| 4     | Tenant DB (TenantModel by tier)            | Org-level tier mapping                                |
| 5     | Platform Demo (demo tenant models)         | Platform demo defaults                                |
| 6     | System Default                             | `LLM_PROVIDER` env --> `gpt-4o` or `claude-3-5-haiku` |

Returns: `{ modelId, provider, apiKey, baseUrl, source }`

#### LLM Provider (Outbound HTTP)

**File**: `packages/compiler/src/platform/llm/providers/openai.ts` (or `anthropic.ts`)

```
Build request body --> formatMessages() + formatTool() + formatToolChoice()
      |
      v
HTTP POST to provider API (e.g., https://api.openai.com/v1/chat/completions)
      |
      v
Parse response --> extract text, tool_calls, usage, stop_reason
      |
      v
Return ToolCompletionResult { text, toolCalls, usage, rawRequest, rawResponse }
```

OpenAI Message Format Conversion [line 287]: internally converts Anthropic-format content blocks to OpenAI format -- `tool_use` blocks become OpenAI `tool_calls` arrays on assistant messages, and `tool_result` blocks become OpenAI `role: 'tool'` messages.

---

### 2.7 Phase 6: Tool Execution (Action Tools, Regular Tools, Handoff)

**File**: `apps/runtime/src/services/runtime-executor.ts` -- `executeToolCall()` [line 3484]

#### Action Tools (Built-in)

| Tool Name              | Handler                  | Line | Effect                                                                                        |
| ---------------------- | ------------------------ | ---- | --------------------------------------------------------------------------------------------- |
| `__handoff__`          | `handleHandoff()`        | 3570 | Creates new thread (or resumes waiting thread) for target agent, recursive `executeMessage()` |
| `__delegate__`         | `handleDelegate()`       | 3952 | Calls sub-agent, returns result to current agent                                              |
| `__complete__`         | `handleComplete()`       | 4006 | Ends conversation, sets completion state                                                      |
| `__escalate__`         | `handleEscalate()`       | 4024 | Transfers to human agent                                                                      |
| `__return_to_parent__` | `handleReturnToParent()` | —    | Child returns control to parent supervisor (digression handling)                              |

#### Regular Tools

```typescript
toolResult = await session.toolExecutor.execute(
  toolCall.name,
  toolCall.input,
  30000, // 30s timeout
);
```

Tool executor can be:

- **ToolBindingExecutor** -- real HTTP calls to external APIs (see Section 5 for the full tool executor architecture)
- **MockToolExecutor** -- returns mock data for testing

#### Handoff Deep Dive [line 3570]

```
handleHandoff(session, input, onChunk, onTraceEvent)
  |
  +-- Validate target agent exists in agentRegistry
  +-- Emit 'handoff' trace event
  +-- Set current thread: status = 'waiting' (if return) or 'completed' (if permanent)
  +-- Check for existing WAITING thread for target agent (thread resume)
  |   +-- If found: reactivate existing thread (status → active), merge new context
  |   |   (preserves conversation history and gathered data)
  |   +-- If not found: build initial history, create new AgentThread
  +-- Stream "Transferring to {agent}..." via onChunk
  +-- Recursively call executeMessage() on the (new or resumed) thread
  +-- If return expected: merge gathered data back to parent thread
  +-- If return_to_parent: forward child's message to parent conversation
```

---

### 2.8 Phase 7: Response Delivery (WebSocket Streaming Sequence)

**File**: `apps/runtime/src/websocket/handler.ts`

#### WebSocket Message Sequence

```
Client receives (in order):
  1. { type: 'responseStart',  sessionId, messageId }
  2. { type: 'responseChunk',  sessionId, messageId, chunk }  <-- may repeat
  3. { type: 'traceEvent',     sessionId, event }              <-- interleaved
  4. { type: 'responseEnd',    sessionId, messageId, response }
  5. { type: 'stateUpdate',    sessionId, state }
  6. { type: 'actionTaken',    sessionId, action }
```

#### Trace Event Storage

**File**: `apps/runtime/src/services/trace-store.ts`

```
getTraceStore().addEvent(sessionId, traceEvent)
  +-- Store in ring buffer (max 500 events per session)
  +-- Forward to OTEL trace bridge (OpenTelemetry)
  +-- Broadcast to all subscribed WebSocket clients
```

For storage backend details (MongoDB, ClickHouse, Redis), see [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md).

#### Trace Events Emitted During Execution

| Event Type          | Where                 | What                                                          |
| ------------------- | --------------------- | ------------------------------------------------------------- |
| `llm_call`          | executeWithTools:3359 | Model, tokens, latency, full messages, response, raw payloads |
| `tool_call`         | executeToolCall:3550  | Tool name, input, output, success, latency                    |
| `handoff`           | handleHandoff:3601    | From agent, to agent, context, return expected                |
| `delegate_start`    | handleDelegate        | Target agent, input                                           |
| `delegate_complete` | handleDelegate        | Result from sub-agent                                         |
| `escalation`        | handleEscalate:4035   | Reason, priority, context                                     |
| `constraint_check`  | checkConstraints:3341 | Constraint type, passed/failed, context                       |
| `agent_enter`       | handleSendMessage:457 | Agent activation                                              |
| `agent_exit`        | handleSendMessage:545 | Agent completion                                              |
| `flow_step_enter`   | executeFlowStep       | Step name (scripted mode)                                     |
| `flow_step_exit`    | executeFlowStep       | Step result                                                   |
| `flow_transition`   | executeFlowStep       | From step --> to step                                         |
| `dsl_collect`       | executeFlowStep       | GATHER/COLLECT field extraction                               |

> **Note:** This table covers the primary trace events emitted during a single message execution flow. For the complete trace event type system (31+ types including guardrail events, memory events, error events, and DSL-specific events), see [OBSERVABILITY_AND_TRACING.md](./OBSERVABILITY_AND_TRACING.md).

---

## 3. Agent Loading & Caching

### Runtime Loading Strategy

```typescript
class ProductionAgentLoader {
  private cache: Map<string, CompiledAgent> = new Map();
  private watcher: FSWatcher | null = null;

  constructor(
    private config: {
      precompiledDir: string; // dist/agents/
      sourceDir: string; // examples/
      enableHotReload: boolean; // Watch for changes
      cacheStrategy: 'memory' | 'redis' | 'none';
    },
  ) {}

  async loadAgent(agentId: string): Promise<CompiledAgent> {
    // 1. Check cache
    if (this.cache.has(agentId)) {
      return this.cache.get(agentId)!;
    }

    // 2. Load precompiled IR (fast path)
    const irPath = `${this.config.precompiledDir}/${agentId}.ir.json`;
    if (await fileExists(irPath)) {
      const compiled = await this.loadPrecompiled(irPath);
      this.cache.set(agentId, compiled);
      return compiled;
    }

    // 3. Fallback: compile on-demand (dev mode)
    return this.compileOnDemand(agentId);
  }

  enableHotReload() {
    this.watcher = watch(this.config.sourceDir, async (event, filename) => {
      if (filename?.endsWith('.agent.abl')) {
        const agentId = this.filenameToAgentId(filename);
        await this.recompileAgent(agentId);
        this.notifyClients(agentId); // WebSocket broadcast
      }
    });
  }
}
```

### Build-Time Compilation Script

```typescript
// scripts/compile-agents.ts
import { compileABLtoIR } from '@abl/compiler';
import { glob } from 'glob';
import { createHash } from 'crypto';

async function compileAllAgents() {
  const ablFiles = await glob('examples/**/*.agent.abl');

  for (const file of ablFiles) {
    const source = await fs.readFile(file, 'utf-8');
    const checksum = createHash('sha256').update(source).digest('hex');

    // Check if recompilation needed
    const metaPath = getMetaPath(file);
    if (await fileExists(metaPath)) {
      const meta = await fs.readJSON(metaPath);
      if (meta.checksum === checksum) {
        console.log(`Skipping ${file} (unchanged)`);
        continue;
      }
    }

    // Compile
    const parsed = parseAgentBasedABL(source);
    const ir = compileABLtoIR([parsed.document]);

    // Write outputs
    await fs.writeJSON(getIRPath(file), {
      version: ir.metadata?.version || '1.0.0',
      checksum,
      compiledAt: new Date().toISOString(),
      compilerVersion: COMPILER_VERSION,
      ir,
    });

    console.log(`Compiled ${file}`);
  }
}
```

### Hot Reload Architecture

```
+-----------------------------------------------------------+
|                    File Watcher                             |
|  (chokidar watching examples/**/*.agent.abl)               |
+--------------------------+--------------------------------+
                           | file change detected
                           v
+-----------------------------------------------------------+
|              Incremental Compiler                           |
|  - Parse changed file                                      |
|  - Compile to IR                                           |
|  - Update cache                                            |
|  - Broadcast via WebSocket                                 |
+--------------------------+--------------------------------+
                           | 'agent:updated' event
                           v
+-----------------------------------------------------------+
|              WebSocket Broadcast                            |
|  { type: 'agent_updated', agentId, newIR }                 |
+--------------------------+--------------------------------+
                           |
                           v
+-----------------------------------------------------------+
|                 UI Clients                                  |
|  - Refresh agent list                                      |
|  - Reload current agent if affected                        |
|  - Update static graph visualization                       |
+-----------------------------------------------------------+
```

### Quick Caching Example

```typescript
// apps/runtime/src/services/agent-loader.ts

const agentCache = new Map<string, { agent: AgentDetails; mtime: number }>();

export function loadAgent(agentId: string): AgentDetails | null {
  const info = discoverAgents().find((a) => a.id === agentId);
  if (!info) return null;

  // Check cache
  const stats = fs.statSync(info.filePath);
  const cached = agentCache.get(agentId);

  if (cached && cached.mtime === stats.mtimeMs) {
    return cached.agent; // Cache hit!
  }

  // Cache miss - compile
  const agent = loadAgentFromPath(info.filePath, info.domain);
  if (agent) {
    agentCache.set(agentId, { agent, mtime: stats.mtimeMs });
  }

  return agent;
}
```

---

## 4. Unified BaseRuntime (Digital / Voice / Workflow)

### Overview

All three runtimes (Digital, Voice, Workflow) extend a shared `BaseRuntime` abstract class that provides common infrastructure:

```
BaseRuntime (abstract)
+-- DigitalRuntime  -- Omni-channel chat (web, WhatsApp, SMS, email, API)
+-- VoiceRuntime    -- Low-latency voice with streaming
+-- WorkflowRuntime -- Durable workflows with Human-in-the-Loop
```

### BaseRuntime Provides

| Concern                | Implementation                                                                    |
| ---------------------- | --------------------------------------------------------------------------------- |
| **Store management**   | Holds ConversationStore, TraceStore, AuditStore, FactStore                        |
| **Agent registration** | `registerAgent()`, `registerAgents()`, `getAgentIR()`                             |
| **Execution context**  | `buildExecutionContext()` wires stores, agent registry, config, LLM/tool adapters |
| **Trace lifecycle**    | `startTrace()`, `withTraceLifecycle()` with error handling                        |
| **Tenant isolation**   | `assertTenantAccess()`, `scopeToTenant()`, `TenantContext`                        |
| **Rate limiting**      | `checkRateLimit()` emits events for platform-level enforcement                    |
| **Initial state**      | `createInitialAgentState()` delegates to `createInitialState()`                   |

### What Each Runtime Adds

| Runtime      | Unique Features                                                                            |
| ------------ | ------------------------------------------------------------------------------------------ |
| **Digital**  | Checkpointing, supervisor routing, rich cards, multi-channel sessions                      |
| **Voice**    | AsyncGenerator streaming, transcript buffer (compliance), SSML/emotion, latency monitoring |
| **Workflow** | WorkflowStore, HumanTaskStore, approval gates, pause/resume, background polling            |

### Abstract Methods (Subclass Must Implement)

```typescript
abstract get runtimeType(): RuntimeType;
protected abstract adaptLLMClient(): ConstructLLMClient;
protected abstract adaptToolExecutor(): ConstructToolExecutor;
```

Each runtime has its own LLM/tool interfaces optimized for its channel. The adapters bridge to the shared `ConstructExecutor` interface.

### Tenant Isolation

Every runtime instance can be bound to a tenant:

```typescript
const runtime = new DigitalRuntime({
  ...config,
  tenantId: 'org_abc123',
  rateLimiting: { requestsPerMinute: 100, tokensPerMinute: 100000, ... },
});
```

Key methods:

- `assertTenantAccess(resourceTenantId)` -- throws `TenantAccessError` if mismatch
- `scopeToTenant(query)` -- adds `tenantId` to any query object
- `checkRateLimit(operation)` -- emits rate limit check events

---

## 5. Tool Executor Architecture

### Overview

The tool execution layer provides a unified pipeline for all outbound tool calls with security, observability, and resilience built in:

```
Agent Turn --> ToolBindingExecutor --> [Middleware Chain] --> Specific Executor --> External Service
                                                                  |
                                                  +---------------+---------------+
                                                  v               v               v
                                           HttpToolExecutor  McpToolExecutor  LambdaToolExecutor
                                                  |
                                        +---------+---------+
                                        v         v         v
                                  SSRF Check  Auth Inject  Proxy Route
```

### ToolBindingExecutor

`packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`

Central dispatcher that maps tool names to their specific executors:

| Feature             | Implementation                                             |
| ------------------- | ---------------------------------------------------------- |
| Tool binding        | Maps tool definitions to HTTP/MCP/Lambda/Sandbox executors |
| Middleware chain    | Composable pre/post processing via `composeMiddleware()`   |
| Trace deduplication | Skips inline trace when middleware handles logging         |
| Fallback executor   | Delegates unknown tools to a fallback executor             |
| Secrets injection   | Passes `SecretsProvider` to auth-requiring executors       |

### Middleware Chain

```typescript
// Registration order defines execution order (onion model)
const executor = new ToolBindingExecutor({
  tools: agentIR.tools,
  secrets: secretsProvider,
  middleware: [
    createAuditMiddleware(auditLogger), // Outermost: audit all calls
    loggingMiddleware(trace), // Trace logging
    timingMiddleware(), // Add latencyMs to results
  ],
});
```

Each middleware wraps the next, forming an onion: `mw1 --> mw2 --> mw3 --> dispatch --> mw3 --> mw2 --> mw1`.

### HttpToolExecutor

`packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`

Executes HTTP tool bindings with:

- **SSRF validation** -- blocks private IPs, cloud metadata, IPv6 loopback, encoding bypasses
- **Redirect following** -- manual redirect with SSRF re-validation per hop (max 5)
- **Auth injection** -- `bearer`, `api_key`, `basic`, `oauth2_client_credentials`, `oauth2_user`
- **Response limits** -- configurable `maxResponseBytes` with streaming body counter
- **Retry with backoff** -- configurable retries with exponential backoff
- **Proxy routing** -- via `ProxyResolver` for org-level proxy/gateway configs

### Secrets Provider

`apps/runtime/src/services/secrets-provider.ts`

Multi-layer resolution: session auth token --> encrypted DB store --> agent IR config --> environment variables.

Per-session caching avoids repeated DB + decryption overhead.

---

## 5.1 Compaction Strategies

Conversation history compaction is governed by `CompactionPolicy` with 4 strategy tiers (none → truncate → structured → summarize). Configuration is resolved via 3-level merge: platform defaults → project DB → agent IR.

Tool-level `compaction.essential_fields` annotations declare which fields to preserve during structured compression — this works for all tool types (HTTP, MCP, connector, searchai, sandbox, workflow).

The `summarize` strategy runs an async LLM call after turn completion (fire-and-forget), falling back to `structured` on failure. Model is resolved: agent → project → platform default.

See `apps/runtime/src/services/execution/compaction-policy.ts` for resolution logic and defaults.

---

## 6. Performance Characteristics

### Current (Development Mode)

| Operation          | Time         | Notes                 |
| ------------------ | ------------ | --------------------- |
| File read          | ~1-5ms       | Depends on file size  |
| Parse              | ~5-20ms      | AST generation        |
| Compile to IR      | ~10-50ms     | Depends on complexity |
| **Total per load** | **~20-80ms** | No caching            |

### With Precompilation

| Operation        | Time       | Notes                    |
| ---------------- | ---------- | ------------------------ |
| Cache hit        | <1ms       | In-memory lookup         |
| Load precompiled | ~2-5ms     | JSON parse only          |
| **Build time**   | ~100-500ms | One-time, parallelizable |

### Scaling Factors

| Factor           | Impact                                          |
| ---------------- | ----------------------------------------------- |
| ABL file size    | Linear -- larger files take longer to parse     |
| Number of agents | Linear for discovery, constant for cached loads |
| FLOW complexity  | Affects IR size and graph extraction            |
| Number of tools  | Minimal impact                                  |

---

## 7. Implementation Status & TODOs

### Implementation Priority

1. ~~**Phase 1: Caching** (Quick win)~~ -- Done. SessionService L1/L2 caching.
2. ~~**Phase 2: Precompilation** (Build pipeline)~~ -- Done. VersionService compiles at version creation time, stores IR in AgentVersion.
3. **Phase 3: Hot Reload** (Dev experience) -- File watcher with chokidar, WebSocket broadcast on change, UI auto-refresh.
4. ~~**Phase 4: Versioning** (Production)~~ -- Done. Full version lifecycle: create (with compile), promote (draft --> testing --> staged --> active --> deprecated), diff, dedup by sourceHash, tenant-isolated, RBAC, audit logged. See `apps/runtime/src/services/version-service.ts`.
5. **Phase 5: Deployment Service** (Next) -- Manifest resolution (agent --> version mapping per environment), deployment-aware session creation. See `docs/design-compilation-persistence.md` Phase 2.

### Feature Status

| Feature                  | Status          | Notes                                               |
| ------------------------ | --------------- | --------------------------------------------------- |
| Basic agent loading      | Done            | `loadAgent()` in agent-loader.ts                    |
| Filesystem discovery     | Done            | `discoverAgents()` walks directories                |
| Parse + compile pipeline | Done            | ABL --> AST --> IR in memory                        |
| In-memory caching        | Done            | SessionService L1/L2 IR cache                       |
| Precompilation pipeline  | Done            | Compile at version time via VersionService          |
| Version Service          | Done            | Create, list, promote, diff, dedup, tenant-isolated |
| Version REST API         | Done            | 5 endpoints with auth, RBAC, rate limiting, audit   |
| Project Agents API       | Done            | List, get, save working copy with tenant isolation  |
| Hot reload               | Not implemented | Manual reload required                              |
| Deployment service       | Not implemented | Phase 2 -- manifest resolution + deploy             |
| Redis/external cache     | Not implemented | Memory-only                                         |

### Open TODOs

| Priority   | Item                                | Effort | Status      |
| ---------- | ----------------------------------- | ------ | ----------- |
| **High**   | Deployment service (Phase 2)        | Medium | Not started |
| **High**   | Deployment-aware sessions (Phase 3) | Medium | Not started |
| **Medium** | File watcher with chokidar          | Medium | Not started |
| **Low**    | Redis cache adapter                 | Large  | Not started |

### Missing Test Coverage

- [ ] Performance benchmarks (load time, compile time)
- [ ] Cache hit/miss scenarios
- [ ] Hot reload behavior
- [ ] Concurrent agent loading

---

## 8. File Reference

### Complete Execution-Order File Chain

Every file touched during a single message execution, in call order:

| #   | File                                                     | Key Method                 | Line  | Role                                     |
| --- | -------------------------------------------------------- | -------------------------- | ----- | ---------------------------------------- |
| 1   | `apps/runtime/src/index.ts`                              | `main()`                   | 13    | Bootstrap config, start server           |
| 2   | `apps/runtime/src/server.ts`                             | `startServer()`            | 157   | HTTP + WS server setup                   |
| 3   | `apps/runtime/src/websocket/handler.ts`                  | `handleConnection()`       | 50    | Accept WS, auth, store client            |
| 4   | `apps/runtime/src/websocket/handler.ts`                  | `handleMessage()`          | 121   | Route by message type                    |
| 5   | `apps/runtime/src/websocket/handler.ts`                  | `handleSendMessage()`      | 408   | Dispatch to executor, stream response    |
| 6   | `apps/runtime/src/services/runtime-executor.ts`          | `executeMessage()`         | 1567  | Session lookup, mode detect, constraints |
| 7   | `apps/runtime/src/services/runtime-executor.ts`          | `buildSystemPrompt()`      | 4530  | Generate system instructions from IR     |
| 8   | `apps/runtime/src/services/runtime-executor.ts`          | `buildTools()`             | 4708  | Compile tool defs + action tools         |
| 9   | `apps/runtime/src/services/runtime-executor.ts`          | `executeWithTools()`       | 3263  | GATHER extraction + agentic loop         |
| 10  | `apps/runtime/src/services/runtime-executor.ts`          | `extractEntitiesWithLLM()` | ~2760 | LLM-based entity extraction              |
| 11  | `apps/runtime/src/services/llm/session-llm-client.ts`    | `chatWithToolUse()`        | 219   | Model resolution + provider call         |
| 12  | `apps/runtime/src/services/llm/model-resolution.ts`      | `resolveConfig()`          | --    | 6-level model+credential resolution      |
| 13  | `packages/compiler/src/platform/llm/providers/openai.ts` | `completeWithTools()`      | 91    | HTTP call to OpenAI API                  |
| 14  | `apps/runtime/src/services/runtime-executor.ts`          | `executeToolCall()`        | 3484  | Tool dispatch (action or regular)        |
| 15  | `apps/runtime/src/services/runtime-executor.ts`          | `handleHandoff()`          | 3570  | Thread creation, recursive execution     |
| 16  | `apps/runtime/src/services/trace-store.ts`               | `addEvent()`               | 128   | Ring buffer + broadcast + OTEL           |
| 17  | `apps/runtime/src/websocket/handler.ts`                  | `send()`                   | 909   | WebSocket JSON transmission              |

### Service Directory Structure

```
apps/runtime/src/services/
+-- agent-loader.ts            # discoverAgents(), loadAgent()
+-- runtime-executor.ts        # Session management, message dispatch
+-- trace-store.ts             # Trace event ring buffer + OTEL bridge
+-- secrets-provider.ts        # Multi-layer secret resolution
+-- session/
|   +-- ir-cache.ts            # Two-tier IR cache (L1 LRU + L2 Redis)
+-- llm/
|   +-- session-llm-client.ts  # Per-session LLM client
|   +-- model-resolution.ts    # 6-level model resolution chain
+-- execution/
    +-- reasoning-executor.ts  # LLM-driven reasoning mode
    +-- flow-step-executor.ts  # Deterministic flow/scripted mode
    +-- routing-executor.ts    # Supervisor routing logic
    +-- constraint-checker.ts  # Runtime constraint enforcement
    +-- prompt-builder.ts      # System prompt construction
```

### Tool Executor Files

| File                                                                           | Purpose                                 |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Central tool dispatcher with middleware |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`    | HTTP execution with SSRF, auth, retry   |
| `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`     | MCP protocol tool execution             |
| `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts`  | AWS Lambda invocation                   |
| `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts` | Sandboxed code execution                |
| `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`       | Middleware types + composition          |
| `packages/compiler/src/platform/constructs/executors/builtin-middleware.ts`    | Logging + timing middleware             |
| `packages/compiler/src/platform/constructs/executors/audit-middleware.ts`      | SOC2/HIPAA audit trail                  |
| `packages/compiler/src/platform/constructs/executors/proxy-resolver.ts`        | Org proxy routing with mTLS             |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`        | PII/secret scrubbing                    |
| `packages/compiler/src/platform/constructs/executors/http-resilience.ts`       | Circuit breaker + rate limiter          |

### BaseRuntime Files

| File                                                            | Purpose                    |
| --------------------------------------------------------------- | -------------------------- |
| `packages/compiler/src/platform/runtimes/base-runtime.ts`       | BaseRuntime abstract class |
| `packages/compiler/src/platform/runtimes/digital-runtime.ts`    | Digital channel runtime    |
| `packages/compiler/src/platform/runtimes/voice-runtime.ts`      | Voice channel runtime      |
| `packages/compiler/src/platform/runtimes/workflow-runtime.ts`   | Workflow runtime           |
| `packages/compiler/src/__tests__/runtimes/base-runtime.test.ts` | 47 unit tests              |

### Compilation Pipeline Files

| File                                             | Purpose                         |
| ------------------------------------------------ | ------------------------------- |
| `packages/core/src/parser/agent-based-parser.ts` | ABL DSL --> AST parsing         |
| `packages/compiler/src/platform/ir/compiler.ts`  | AST --> AgentIR compilation     |
| `apps/runtime/src/services/session/ir-cache.ts`  | Two-tier IR cache (L1 LRU + L2) |

### Related Documentation

- [OBSERVABILITY_AND_TRACING.md](./OBSERVABILITY_AND_TRACING.md) -- Complete trace event type system (31+ types), ClickHouse storage, OTEL bridge, session replay
- [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md) -- MongoDB, Redis, ClickHouse storage schemas, connection pooling, encryption at rest
