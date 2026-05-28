# Platform - TypeScript Runtime

This directory contains the **TypeScript runtime** for executing ABL-compiled agents.

## Architecture

```
platform/
├── ir/                    # Intermediate Representation
│   ├── schema.ts         # AgentIR type definitions
│   └── compiler.ts       # AST → IR compiler
│
├── constructs/            # ABL Construct Executors (shared)
│   ├── executor.ts       # Main ConstructExecutor orchestrator
│   ├── evaluator.ts      # Condition evaluation (AND/OR/nested)
│   ├── types.ts          # ExecutionContext, ConstructResult types
│   └── executors/        # Individual construct executors
│       ├── gather-executor.ts      # GATHER: LLM-based extraction
│       ├── memory-executor.ts      # MEMORY: session + persistent
│       ├── constraint-executor.ts  # CONSTRAINTS: guardrails
│       ├── delegate-executor.ts    # DELEGATE: sub-agent calls
│       ├── handoff-executor.ts     # HANDOFF: agent transfer
│       ├── escalate-executor.ts    # ESCALATE: human transfer
│       ├── complete-executor.ts    # COMPLETE: session end
│       ├── error-executor.ts       # ON_ERROR: error handling
│       └── flow-executor.ts        # FLOW: scripted steps
│
├── runtimes/              # Channel-specific runtimes
│   ├── voice-runtime.ts   # Telephony (streaming, low latency)
│   ├── digital-runtime.ts # Web/WhatsApp/SMS (checkpointing)
│   └── workflow-runtime.ts # Human-in-the-loop processes
│
├── stores/                # State management
│   ├── fact-store.ts      # Persistent memory (Redis/Postgres/Memory)
│   ├── conversation-store.ts
│   ├── trace-store.ts     # Execution tracing
│   └── audit-store.ts     # Audit logging
│
└── core/                  # Core types
    └── types.ts           # Session, Message, Channel types
```

## Key Design Decisions

### All Runtimes Use ConstructExecutor

```typescript
// Every runtime uses the shared executor
const executor = createConstructExecutor();
const result = await executor.execute(context);
```

### LLM-Only Extraction

All information extraction (GATHER) uses LLM, not regex patterns:

```typescript
// GatherExecutor always calls LLM
const result = await llmClient.extractJson(systemPrompt, messages, schema, options);
```

This ensures:

- Consistent behavior across voice/digital/workflow
- Better handling of natural language variations
- No maintenance burden for regex patterns

### Execution Flow

```
User Input
    │
    ▼
┌─────────────────────────────────────────────────────┐
│              ConstructExecutor.execute()             │
│                                                     │
│  1. Memory Recall (load persistent state)           │
│  2. Gather (extract info from input)                │
│  3. Constraints (check guardrails)                  │
│  4. Delegates (call sub-agents if needed)           │
│  5. Escalation (check human transfer triggers)      │
│  6. Handoffs (check agent transfer triggers)        │
│  7. Completion (check session end conditions)       │
│  8. Memory Remember (persist state)                 │
│                                                     │
└─────────────────────────────────────────────────────┘
    │
    ▼
ConstructResult { action, stateUpdates, metadata }
```

## Usage

```typescript
import {
  ConstructExecutor,
  createInitialState,
  type ExecutionContext,
} from './constructs/index.js';

// Create context
const context: ExecutionContext = {
  sessionId: 'session-123',
  agentIR: compiledAgent,
  state: createInitialState(),
  runtime: 'digital',
  llmClient: myLLMClient,
  toolExecutor: myToolExecutor,
  // ... other required fields
};

// Execute
const executor = createConstructExecutor();
const result = await executor.execute(context);

// Handle result
if (result.action.type === 'respond') {
  console.log(result.action.message);
} else if (result.action.type === 'collect') {
  console.log('Need more info:', result.action.fields);
}
```

## Testing

```bash
# Unit tests for constructs
npm test -- constructs/

# E2E tests with mocked LLM
npm test -- e2e/saludsa
npm test -- e2e/conversation-flows

# E2E tests with real LLM (requires ANTHROPIC_API_KEY)
npm test -- e2e/llm-integration
```
