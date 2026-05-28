# AgenticAI → ABL Migration Implementation

## Objective

Migrate AgenticAI multi-agent app definitions into ABL form so the new runtime can execute them, with backward-compatible APIs stubbing to the new runtime.

---

## 1. Config Migration (AgenticAI → ABL DSL)

### AgenticAI Agent Structure

```typescript
// AgenticAI agent configuration
interface AgenticAgentConfig {
  _id: string;
  name: string;
  role: 'SUPERVISOR' | 'WORKER' | 'DELEGATION_WORKER' | 'PROCESSOR';
  llmCredential: string;
  model: string;
  systemPrompt: string;
  tools: ToolConfig[];
  workers?: string[]; // For supervisors
  delegatesTo?: string[]; // For delegation workers
  routingConfig?: RoutingConfig;
}
```

### ABL Agent Mapping

| AgenticAI Role    | ABL Agent Type | Notes                  |
| ----------------- | -------------- | ---------------------- |
| SUPERVISOR        | `supervisor`   | Routes to child agents |
| WORKER            | `reasoning`    | Has tools, autonomous  |
| DELEGATION_WORKER | `reasoning`    | With delegate() calls  |
| PROCESSOR         | `scripted`     | Deterministic flow     |

### Conversion Example

```
# AgenticAI Supervisor
{
  name: "orchestrator",
  role: "SUPERVISOR",
  workers: ["booking_agent", "support_agent"],
  routingConfig: { strategy: "semantic" }
}

# → ABL Supervisor
supervisor orchestrator {
  agents: [booking_agent, support_agent]
  strategy: semantic
  model: "claude-sonnet-4-20250514"
}

# AgenticAI Worker
{
  name: "booking_agent",
  role: "WORKER",
  tools: [{ name: "search_flights" }],
  systemPrompt: "You are a booking assistant..."
}

# → ABL Reasoning Agent
agent booking_agent {
  name: "Booking Agent"

  reasoning {
    tools: [search_flights, book_flight]
    model: "claude-sonnet-4-20250514"

    constraints {
      max_turns: 20
    }

    on_start {
      set_goal("Help user with travel bookings")
    }
  }
}
```

---

## 2. Files to Create

### Core Migration Layer

```
packages/compiler/src/
├── compat/
│   ├── index.ts                    # Exports
│   ├── agenticai-converter.ts      # Config → ABL DSL converter
│   ├── agenticai-runtime.ts        # Compatibility runtime wrapper
│   └── api-stub.ts                 # V1 API compatibility
├── platform/
│   ├── checkpointing/
│   │   ├── index.ts
│   │   ├── checkpointer.ts         # Abstract checkpointer
│   │   ├── memory-checkpointer.ts  # In-memory (dev)
│   │   ├── redis-checkpointer.ts   # Redis (prod)
│   │   └── mongodb-checkpointer.ts # MongoDB (prod)
│   ├── model-registry/
│   │   ├── index.ts
│   │   ├── registry.ts             # Model registry
│   │   ├── gale-provider.ts        # GALE integration
│   │   └── router.ts               # Intelligent routing
│   └── mcp/
│       ├── index.ts
│       ├── protocol.ts             # Full MCP protocol
│       ├── client.ts               # MCP client
│       ├── server-manager.ts       # Server lifecycle
│       └── transport.ts            # Stdio/SSE transports
```

### Platform API Layer

```
apps/platform/src/
├── routes/
│   ├── compat/
│   │   ├── v1-run.ts               # POST /api/v1/run
│   │   ├── v1-compile.ts           # POST /api/v1/compile
│   │   └── v1-invoke.ts            # POST /api/v1/invoke
│   └── model-registry.ts           # Model management API
├── services/
│   ├── gale/
│   │   ├── gale-service.ts         # GALE integration
│   │   └── tool-cache.ts           # Tool definition cache
│   └── checkpointing/
│       └── checkpoint-service.ts   # Checkpoint management
```

---

## 3. Implementation Priority

### Phase 1: Checkpointing (Critical)

- Abstract Checkpointer interface
- Redis implementation (production)
- MongoDB implementation (production)
- Integration with BaseRuntime

### Phase 2: Config Converter

- AgenticAI config parser
- ABL DSL generator
- Tool definition mapping
- LLM credential resolution

### Phase 3: API Compatibility Layer

- /api/v1/run → ABL runtime execution
- /api/v1/compile → Agent IR compilation
- /api/v1/invoke → Session message
- Streaming response compatibility

### Phase 4: Model Registry

- Dynamic model catalog
- GALE model fetching
- Intelligent routing (cost/latency/capability)
- Fallback chains

### Phase 5: Full MCP Protocol

- Complete protocol implementation
- Multiple transport support
- Server lifecycle management
- Resource/prompt support

---

## 4. Key Interfaces

### Checkpointer Interface

```typescript
interface Checkpoint {
  id: string;
  sessionId: string;
  agentName: string;
  state: AgentState;
  messages: Message[];
  context: Record<string, unknown>;
  createdAt: Date;
  expiresAt?: Date;
}

interface Checkpointer {
  save(checkpoint: Checkpoint): Promise<void>;
  load(sessionId: string): Promise<Checkpoint | null>;
  delete(sessionId: string): Promise<void>;
  list(agentName: string, limit?: number): Promise<Checkpoint[]>;
}
```

### Model Registry Interface

```typescript
interface ModelInfo {
  id: string;
  provider: LLMProviderType;
  name: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  limits: ModelLimits;
}

interface ModelRegistry {
  getModel(id: string): Promise<ModelInfo | null>;
  listModels(filter?: ModelFilter): Promise<ModelInfo[]>;
  getModelForTask(task: TaskRequirements): Promise<ModelInfo>;
  refreshFromGale(): Promise<void>;
}
```

### MCP Protocol Interface

```typescript
interface MCPServer {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

interface MCPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  listResources(): Promise<MCPResource[]>;
  readResource(uri: string): Promise<MCPResourceContent>;
  listPrompts(): Promise<MCPPrompt[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptResult>;
}
```

---

## 5. Streaming Compatibility

### AgenticAI Streaming

```typescript
// AgenticAI uses graph engine stream
for await (const event of graph.stream(input)) {
  if (event.type === 'text') {
    yield { type: 'response_chunk', chunk: event.text };
  } else if (event.type === 'tool_call') {
    yield { type: 'tool_start', tool: event.name };
  }
}
```

### ABL Streaming (must match)

```typescript
// ABL runtime streaming adapter
class StreamingAdapter {
  async *execute(
    runtime: BaseRuntime,
    sessionId: string,
    input: string,
  ): AsyncGenerator<StreamEvent> {
    const execution = runtime.executeWithStream(sessionId, input);

    for await (const event of execution) {
      // Map ABL events to AgenticAI format
      yield this.mapEvent(event);
    }
  }

  private mapEvent(event: ABLEvent): StreamEvent {
    switch (event.type) {
      case 'text_delta':
        return { type: 'response_chunk', chunk: event.text };
      case 'tool_use_start':
        return { type: 'tool_start', tool: event.name };
      case 'tool_use_end':
        return { type: 'tool_end', tool: event.name, result: event.result };
      // ... etc
    }
  }
}
```

---

## 6. Verification Checklist

- [ ] AgenticAI config successfully converts to ABL DSL
- [ ] Converted agents execute correctly in ABL runtime
- [ ] /api/v1/run returns same response format
- [ ] Streaming events match AgenticAI format
- [ ] Checkpoints persist and restore correctly
- [ ] Model registry fetches from GALE
- [ ] MCP tools execute via full protocol
- [ ] Multi-agent supervisor routing works
- [ ] Tool execution matches AgenticAI behavior
- [ ] Error responses match AgenticAI format
