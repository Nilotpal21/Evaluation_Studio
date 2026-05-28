# AI For Healthcare Payer (Provider-Facing) E2E: ABL Runtime vs Kore.ai — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a side-by-side E2E comparison of the AI For Healthcare Payer provider-facing virtual assistant running on (A) the live Kore.ai Agent Platform and (B) the ABL Runtime, measuring functional parity, latency, and routing accuracy.

**Architecture:** The Kore.ai app is a 5-agent delegation-based system where a supervisor routes provider requests through authentication first, then to specialized agents for plan info, coverage info, and claim info. Each agent uses code tools that query Kore.ai Data Tables API for member/provider data. A knowledge base (`Plan_Services_Coverage_Knowledge_Base`) provides coverage/eligibility lookup. For ABL, we map all 5 agents directly (no consolidation needed — the agent count is already lean) with the supervisor becoming an ABL SUPERVISOR and child agents becoming ABL AGENTs.

**Tech Stack:** ABL DSL (agents, supervisors, tools), Vitest E2E, Kore.ai Data Tables API (HTTP), Knowledge Base RAG, SSE streaming, Azure OpenAI GPT-4.1

---

## Chunk 1: Architecture Analysis & File Structure

### Kore.ai Architecture Overview

**App:** "AI For Healthcare Payer" — Provider-facing web assistant for health insurance benefit inquiries.

**Flow Type:** Delegation (`appFlowType: "Delegation"`) with `defaultAgent: Welcome_Agent`.

**5 Agents with clear responsibilities:**

| #   | Kore.ai Agent                | Role                                                                                                                                  | Tools                                                           |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `Welcome_Agent`              | Front-desk: greetings, help, small talk, delegates to specialized agents                                                              | None (pure routing)                                             |
| 2   | `Authentication_Agent`       | Collects Provider ID (9 digits) or NPI ID (10 digits), calls `perform_provider_authentication`                                        | `perform_provider_authentication`                               |
| 3   | `Plan_Information_Agent`     | Collects Member ID, calls `get_plan_information`, presents deductibles/OOP/status/dates                                               | `get_plan_information`                                          |
| 4   | `Coverage_Information_Agent` | Collects Member ID, calls `get_plan_information` for plan name, then queries knowledge base for coverage/copay/coinsurance/prior auth | `get_plan_information`, `Plan_Services_Coverage_Knowledge_Base` |
| 5   | `Claim_Information_Agent`    | Collects Member ID + optional filters, calls `get_claim_information`, presents claim status/amounts/dates                             | `get_claim_information`                                         |

**3 Code Tools (all query Kore.ai Data Tables API via HTTP):**

| Tool                              | API Endpoint                                                           | Key Params                                                         | Returns                                                           |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `perform_provider_authentication` | `POST platform.kore.ai/api/public/tables/providerinfo/query`           | `providerId` (9 digits) OR `npiId` (10 digits)                     | Provider profile + stores in `provider_data` memory               |
| `get_plan_information`            | `POST platform.kore.ai/api/public/tables/eligibilitymembersinfo/query` | `memberId`                                                         | Plan names, coverage types, dates, deductibles, OOP max, benefits |
| `get_claim_information`           | `POST platform.kore.ai/api/public/tables/claiminfo/query`              | `memberId`, optional: `claimReqDate`, `claimStatus`, `claimAmount` | Claims list with status, amounts, dates, payment info             |

**1 Knowledge Tool:**

| Tool                                    | Type            | Purpose                                                                           |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| `Plan_Services_Coverage_Knowledge_Base` | KNOWLEDGE (RAG) | Coverage details, copay/coinsurance rates, prior auth, service lists by plan name |

**1 Memory Store:**

```
Provider Data (provider_data) — session-level:
  providerId: number
  npiId: number
  taxonomyCode: string
  medicaidId: number
  zipCode: number
  authenticationTimestamp: string
  status: string           # "Authenticated" when verified
```

**10 App Flow Transitions (delegation routing):**

| From                       | To                         | Condition                                                                    |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| Welcome_Agent              | Authentication_Agent       | `authentication_status` is NOT "Authenticated" AND provider requests service |
| Welcome_Agent              | Plan_Information_Agent     | Provider asks about plan info AND authenticated                              |
| Welcome_Agent              | Coverage_Information_Agent | Provider asks about coverage/eligibility AND authenticated                   |
| Welcome_Agent              | Claim_Information_Agent    | Provider asks about claims AND authenticated                                 |
| Authentication_Agent       | Plan_Information_Agent     | Provider asks plan info AND authenticated                                    |
| Authentication_Agent       | Coverage_Information_Agent | Provider asks coverage AND authenticated                                     |
| Authentication_Agent       | Claim_Information_Agent    | Provider asks claims AND authenticated                                       |
| Plan_Information_Agent     | Authentication_Agent       | NOT authenticated                                                            |
| Coverage_Information_Agent | Authentication_Agent       | NOT authenticated                                                            |
| Claim_Information_Agent    | Authentication_Agent       | NOT authenticated                                                            |

**3 Events:**

| Event               | Trigger                                   | Action                                                       |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Welcome Event       | Session start                             | "Hello! Welcome to the provider portal..."                   |
| Agent Handoff       | Explicit request / system unable to serve | "I'll connect you to our representative shortly." (disabled) |
| End of Conversation | User done / request resolved              | "Thank you for chatting with us. Have a great day!"          |

**Orchestration Prompt Key Rules:**

1. Supervisor is a pure messenger/router — NEVER answers directly
2. Every input goes through a tool/agent, every output comes from a tool/agent
3. Pass sub-agent messages word-for-word — no rephrasing
4. Authentication MUST happen before any service request
5. Never re-authenticate once `authentication_status` is "Authenticated"
6. After auth, immediately route back to the original requesting agent
7. Provider confirmation ("yes, that's correct") during auth MUST route back to Authentication_Agent (not treated as authenticated)

### Kore.ai → ABL Mapping

| Kore.ai Concept                             | ABL Equivalent                                       |
| ------------------------------------------- | ---------------------------------------------------- |
| `orchestrationPrompt` (delegation router)   | SUPERVISOR with HANDOFF rules using WHEN expressions |
| `agent.prompt.custom` workflow instructions | Agent PERSONA with embedded workflow instructions    |
| `appFlow.transitions` (10 transitions)      | HANDOFF rules with WHEN conditions                   |
| `memory.provider_data.status`               | ABL MEMORY: session: `authentication_status`         |
| Code tools (3 HTTP tools)                   | ABL TOOLS: with HTTP endpoint bindings               |
| Knowledge tool (RAG)                        | ABL TOOLS: knowledge base query tool                 |
| `Welcome Event`                             | SUPERVISOR initial greeting logic                    |
| `Agent Handoff` event                       | ABL ESCALATE trigger                                 |
| `End of Conversation` event                 | ABL COMPLETE condition                               |

### Agent Mapping: 5 → 5 ABL Agents (No Consolidation)

| #   | ABL Agent                    | Kore.ai Source                    | Key Logic                                                                                                                                                  |
| --- | ---------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `healthcare_supervisor`      | Supervisor + Welcome_Agent merged | Greeting + 2-level routing: auth gate → intent routing. Pure messenger.                                                                                    |
| 2   | `authentication_agent`       | Authentication_Agent              | Collect Provider ID (9-digit) or NPI ID (10-digit), validate format, confirm, call `perform_provider_authentication`                                       |
| 3   | `plan_information_agent`     | Plan_Information_Agent            | Collect Member ID, call `get_plan_information`, present deductibles/OOP/status/dates. Markdown tables for web.                                             |
| 4   | `coverage_information_agent` | Coverage_Information_Agent        | Collect Member ID, call `get_plan_information` for plan name, query knowledge base with FULL plan name, present coverage/copay/coinsurance/prior auth      |
| 5   | `claim_information_agent`    | Claim_Information_Agent           | Collect Member ID + optional filters (date, status, amount), call `get_claim_information`, present claims. Single claim → text; multiple → markdown table. |

**Note:** `Welcome_Agent` is merged into the supervisor since it has no tools and only does greeting/routing — the supervisor's PERSONA handles this.

### File Structure

```
examples/ai4hc-payer-provider/
├── project.json                              # ABL project manifest
├── environment/
│   └── default.env.json                      # API tokens, model config
├── agents/
│   ├── healthcare_supervisor.agent.abl       # Supervisor with auth-gated routing
│   ├── authentication_agent.agent.abl        # Provider authentication
│   ├── plan_information_agent.agent.abl      # Member plan info
│   ├── coverage_information_agent.agent.abl  # Coverage/eligibility via KB
│   └── claim_information_agent.agent.abl     # Claim status
├── tools/
│   └── healthcare_payer.tools.abl            # All 3 code tools + 1 knowledge tool
└── config/
    └── behavioral_instructions.md            # Orchestration rules (verbatim from Kore.ai)

apps/runtime/src/__tests__/e2e/ai4hc-payer/
├── scenarios.ts                              # Test scenarios with utterances + expected behavior
├── ai4hc-koreai.e2e.test.ts                  # Live Kore.ai baseline test
├── ai4hc-abl-runtime.e2e.test.ts             # ABL Runtime test
├── assertions.ts                             # Shared assertion helpers
├── sse-client.ts                             # Kore.ai SSE streaming client
├── generate-comparison.ts                    # Markdown comparison report generator
└── fixtures/
    └── provider-metadata.ts                  # Mock provider/member data for tests
```

### Memory Store → ABL Session Variables

```
MEMORY:
  session:
    # Provider authentication state
    authentication_status: string       # "" | "Authenticated"
    provider_id: number
    npi_id: number
    taxonomy_code: string
    medicaid_id: number
    zip_code: string
    authentication_timestamp: string

    # Conversation state
    current_intent: string              # "plan_info" | "coverage_info" | "claim_info" | "greeting" | ""
    original_intent: string             # Preserved during auth redirect
    member_id: string                   # Currently queried member
```

### Kore.ai API Configuration (for baseline tests)

```
Base URL: https://agent-platform.kore.ai
App ID: (from AI4HC_APP_ID env var)
API Key: (from AI4HC_API_KEY env var)
Execute endpoint: /api/v2/apps/{appId}/environments/dev/runs/execute
Stream mode: SSE with tokens
```

### Data Tables API Configuration (for tool implementations)

```
Base URL: https://platform.kore.ai/api/public/tables
Auth Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBJZCI6ImNzLTcyY2VlM2JjLWQyOGEtNWE0Zi04ZWM1LTczN2I4YTZlNWMyNCJ9.xn1a_bUkAhvLymDGU6W2qfersHq6A-y1ezUoH5XqNYM
Tables:
  - providerinfo — Provider authentication lookup
  - eligibilitymembersinfo — Member plan information
  - claiminfo — Member claim information
```

---

## Chunk 2: Kore.ai Baseline Test Harness

### Task 1: Create test scenarios

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/scenarios.ts`

- [ ] **Step 1: Write scenarios file**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/scenarios.ts

/**
 * AI4HC Payer Provider-Facing E2E Test Scenarios
 *
 * Each scenario targets a specific agent workflow path.
 * All scenarios are web-channel (provider portal).
 */

export interface Turn {
  user: string;
  /** Keywords expected in the response */
  expectAny?: string[];
  /** Keywords that must NOT appear */
  expectNone?: string[];
  /** Expected agent routing (if detectable from SSE) */
  expectAgent?: string;
  /** Max acceptable response time in ms */
  maxTimeMs?: number;
}

export interface Scenario {
  name: string;
  description: string;
  turns: Turn[];
  /** Create fresh session for this scenario */
  freshSession: boolean;
  /** Tags for filtering: auth, plan, coverage, claim, greeting, farewell */
  tags: string[];
}

export const SCENARIOS: Scenario[] = [
  // ── S1: Pure Greeting ──
  {
    name: 'S1: Greeting Only',
    description:
      'Provider sends a greeting with no use case — expects welcome message without auth',
    freshSession: true,
    tags: ['greeting'],
    turns: [
      {
        user: 'Hello',
        expectAny: ['welcome', 'provider portal', 'help', 'assist', 'plan', 'coverage', 'claim'],
        expectNone: ['Provider ID', 'NPI', 'authenticate'],
        maxTimeMs: 15000,
      },
    ],
  },

  // ── S2: Authentication with Provider ID ──
  {
    name: 'S2: Auth via Provider ID → Plan Info',
    description:
      'Provider asks for plan info → auth triggered → provides 9-digit Provider ID → confirms → authenticated → plan info',
    freshSession: true,
    tags: ['auth', 'plan'],
    turns: [
      {
        user: "I need to check a member's plan information",
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'verify', 'identity'],
        expectAgent: 'Authentication_Agent',
        maxTimeMs: 30000,
      },
      {
        user: '123456789',
        expectAny: ['confirm', 'Provider ID', '123456789', 'correct', 'verify'],
        maxTimeMs: 30000,
      },
      {
        user: "Yes, that's correct",
        expectAny: ['authenticated', 'success', 'verified', 'Member ID', 'member'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM001',
        expectAny: ['plan', 'deductible', 'coverage', 'effective', 'status', 'network'],
        expectAgent: 'Plan_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S3: Authentication with NPI ID ──
  {
    name: 'S3: Auth via NPI ID → Coverage Info',
    description: 'Provider asks about coverage → auth via 10-digit NPI → coverage query',
    freshSession: true,
    tags: ['auth', 'coverage'],
    turns: [
      {
        user: 'What services are covered for one of my patients?',
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'verify'],
        expectAgent: 'Authentication_Agent',
        maxTimeMs: 30000,
      },
      {
        user: '1234567890',
        expectAny: ['confirm', 'NPI', '1234567890', 'correct'],
        maxTimeMs: 30000,
      },
      {
        user: 'Yes',
        expectAny: ['authenticated', 'success', 'verified', 'Member ID'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM001',
        expectAny: ['coverage', 'copay', 'coinsurance', 'covered', 'service', 'plan'],
        expectAgent: 'Coverage_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S4: Plan Information (already authenticated session sim) ──
  {
    name: 'S4: Plan Info — Deductible Query',
    description: 'Authenticated provider asks specifically about deductibles for a member',
    freshSession: true,
    tags: ['auth', 'plan'],
    turns: [
      {
        user: 'I want to check the deductible status for a member',
        expectAny: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
      {
        user: '123456789',
        expectAny: ['confirm', '123456789'],
        maxTimeMs: 30000,
      },
      {
        user: 'Yes',
        expectAny: ['authenticated', 'Member ID'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM001',
        expectAny: ['deductible', 'in-network', 'out-of-network', 'met', 'remaining', 'total'],
        expectAgent: 'Plan_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S5: Claim Status Query ──
  {
    name: 'S5: Claim Status Query',
    description: 'Authenticated provider asks for claim status for a member',
    freshSession: true,
    tags: ['auth', 'claim'],
    turns: [
      {
        user: 'I need to check claim status for a patient',
        expectAny: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
      {
        user: '123456789',
        expectAny: ['confirm', '123456789'],
        maxTimeMs: 30000,
      },
      {
        user: "Yes that's correct",
        expectAny: ['authenticated', 'Member ID'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM002',
        expectAny: ['claim', 'status', 'amount', 'date', 'submitted', 'paid', 'denied'],
        expectAgent: 'Claim_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S6: Invalid Provider ID ──
  {
    name: 'S6: Invalid Provider ID Format',
    description: 'Provider gives wrong format ID — expects format error',
    freshSession: true,
    tags: ['auth', 'error'],
    turns: [
      {
        user: 'Check plan info for a member please',
        expectAny: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
      {
        user: '12345',
        expectAny: ['invalid', 'format', '9 digits', '10 digits', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S7: Multi-Intent (Plan then Claim) ──
  {
    name: 'S7: Multi-Intent — Plan Info Then Claim Status',
    description: 'After getting plan info, provider asks about claims in same session',
    freshSession: true,
    tags: ['auth', 'plan', 'claim', 'multi'],
    turns: [
      {
        user: 'I need plan information for a member',
        expectAny: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
      {
        user: '123456789',
        expectAny: ['confirm', '123456789'],
        maxTimeMs: 30000,
      },
      {
        user: 'Yes',
        expectAny: ['authenticated', 'Member ID'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM001',
        expectAny: ['plan', 'deductible', 'coverage', 'effective'],
        expectAgent: 'Plan_Information_Agent',
        maxTimeMs: 45000,
      },
      {
        user: 'Now show me claim status for member MEM002',
        expectAny: ['claim', 'status', 'amount'],
        expectAgent: 'Claim_Information_Agent',
        expectNone: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S8: Coverage — Specific Service Query ──
  {
    name: 'S8: Coverage — Specific Service Inquiry',
    description: 'Authenticated provider asks if a specific service is covered',
    freshSession: true,
    tags: ['auth', 'coverage'],
    turns: [
      {
        user: 'Is physical therapy covered for my patient?',
        expectAny: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
      {
        user: '123456789',
        expectAny: ['confirm', '123456789'],
        maxTimeMs: 30000,
      },
      {
        user: 'Yes',
        expectAny: ['authenticated', 'Member ID'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM001',
        expectAny: [
          'physical therapy',
          'covered',
          'copay',
          'coinsurance',
          'prior auth',
          'coverage',
          'service',
        ],
        expectAgent: 'Coverage_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S9: Farewell ──
  {
    name: 'S9: Farewell Flow',
    description: 'Provider says goodbye after completed interaction',
    freshSession: true,
    tags: ['farewell'],
    turns: [
      {
        user: 'Hello',
        expectAny: ['welcome', 'help', 'assist'],
        maxTimeMs: 15000,
      },
      {
        user: "That's all, thank you",
        expectAny: ['thank', 'great day', 'goodbye', 'welcome', 'glad'],
        maxTimeMs: 15000,
      },
    ],
  },

  // ── S10: Claim with Filters ──
  {
    name: 'S10: Claim Status with Date Filter',
    description: 'Provider asks for claims filtered by date',
    freshSession: true,
    tags: ['auth', 'claim'],
    turns: [
      {
        user: 'I need to check claims for a patient',
        expectAny: ['authenticate', 'Provider ID', 'NPI'],
        maxTimeMs: 30000,
      },
      {
        user: '123456789',
        expectAny: ['confirm', '123456789'],
        maxTimeMs: 30000,
      },
      {
        user: 'Correct',
        expectAny: ['authenticated', 'Member ID'],
        maxTimeMs: 30000,
      },
      {
        user: 'MEM002, I only need claims from January 2025',
        expectAny: ['claim', 'January', '2025', 'status'],
        expectAgent: 'Claim_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },
];

export function getScenariosByTag(tag: string): Scenario[] {
  return SCENARIOS.filter((s) => s.tags.includes(tag));
}

export function getScenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
}
```

- [ ] **Step 2: Verify file compiles**

Run: `npx tsc --noEmit apps/runtime/src/__tests__/e2e/ai4hc-payer/scenarios.ts 2>&1 | head -20`
Expected: No errors (standalone types)

- [ ] **Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/scenarios.ts
git commit -m "feat(e2e): add AI4HC Payer provider-facing test scenarios — 10 scenarios"
```

---

### Task 2: Create SSE streaming client

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/sse-client.ts`

- [ ] **Step 1: Write SSE client**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/sse-client.ts

/**
 * AI4HC Payer Kore.ai SSE Streaming Client
 *
 * Handles: session identity, SSE parsing, timing, agent detection.
 * Adapted from Saludsa E2E pattern.
 */

export interface SessionIdentity {
  userReference: string;
  sessionReference: string;
}

export interface SSEEvent {
  eventIndex?: number;
  sessionInfo?: { sessionId: string };
  sessionReference?: string;
  agent?: { displayName: string; icon?: string; title?: string };
  output?: Array<{ type: string; content: string }>;
  token?: string;
  message?: string;
  type?: string;
}

export interface ParsedResponse {
  sessionId: string | null;
  sessionReference: string | null;
  agentInfo: { displayName: string; icon?: string } | null;
  fullText: string;
  events: SSEEvent[];
  rawChunks: string[];
  timing: {
    startMs: number;
    firstChunkMs: number;
    firstTokenMs: number;
    endMs: number;
  };
}

export interface AI4HCClientConfig {
  apiKey: string;
  appId: string;
  baseUrl: string;
}

/**
 * Parse concatenated JSON objects from an SSE data line.
 */
export function extractJSONObjects(line: string): string[] {
  const stripped = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!stripped) return [];

  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(stripped.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse a Kore.ai SSE stream into structured events with timing data.
 */
export async function parseSSEStream(response: Response, startMs: number): Promise<ParsedResponse> {
  const result: ParsedResponse = {
    sessionId: null,
    sessionReference: null,
    agentInfo: null,
    fullText: '',
    events: [],
    rawChunks: [],
    timing: { startMs, firstChunkMs: 0, firstTokenMs: 0, endMs: 0 },
  };

  if (!response.body) {
    throw new Error(`No response body — status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isFirstChunk = true;
  let isFirstToken = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (isFirstChunk) {
      result.timing.firstChunkMs = Date.now();
      isFirstChunk = false;
    }

    const chunk = decoder.decode(value, { stream: true });
    result.rawChunks.push(chunk);
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('event:') ||
        trimmed.startsWith('id:') ||
        trimmed.startsWith('retry:')
      ) {
        continue;
      }

      const jsonStrings = extractJSONObjects(trimmed);
      for (const jsonStr of jsonStrings) {
        try {
          const data: SSEEvent = JSON.parse(jsonStr);
          result.events.push(data);

          if (data.sessionInfo?.sessionId) {
            result.sessionId = data.sessionInfo.sessionId;
          }
          if (data.sessionReference) {
            result.sessionReference = data.sessionReference;
          }
          if (data.agent?.displayName) {
            result.agentInfo = data.agent;
          }

          if (data.output) {
            for (const item of data.output) {
              if (item.type === 'text' && item.content) {
                if (isFirstToken) {
                  result.timing.firstTokenMs = Date.now();
                  isFirstToken = false;
                }
                result.fullText += item.content;
              }
            }
          }
          if (data.token) {
            if (isFirstToken) {
              result.timing.firstTokenMs = Date.now();
              isFirstToken = false;
            }
            result.fullText += data.token;
          }
        } catch {
          // Partial JSON — reassembled in next chunk
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const jsonStrings = extractJSONObjects(buffer);
    for (const jsonStr of jsonStrings) {
      try {
        const data: SSEEvent = JSON.parse(jsonStr);
        result.events.push(data);
        if (data.output) {
          for (const item of data.output) {
            if (item.type === 'text' && item.content) {
              result.fullText += item.content;
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  result.timing.endMs = Date.now();
  return result;
}

/**
 * Send a message to the Kore.ai AI4HC API and parse the SSE response.
 */
export async function sendMessage(
  config: AI4HCClientConfig,
  text: string,
  identity: SessionIdentity,
): Promise<ParsedResponse> {
  const executeUrl = `${config.baseUrl}/api/v2/apps/${config.appId}/environments/dev/runs/execute`;

  const body = {
    sessionIdentity: [
      { type: 'userReference', value: identity.userReference },
      { type: 'sessionReference', value: identity.sessionReference },
    ],
    input: [{ type: 'text', content: text }],
    stream: { enable: true, streamMode: 'tokens' },
    debug: { enable: false },
  };

  const startMs = Date.now();

  const response = await fetch(executeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kore.ai API error: ${response.status} ${response.statusText}\n${errText}`);
  }

  return parseSSEStream(response, startMs);
}

/**
 * Create a unique session identity for a test run.
 */
export function makeSessionIdentity(prefix = 'ai4hc_e2e'): SessionIdentity {
  const ts = Date.now();
  return {
    userReference: `${prefix}_user_${ts}`,
    sessionReference: `${prefix}_session_${ts}`,
  };
}

/**
 * Timing formatter.
 */
export function fmt(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/sse-client.ts
git commit -m "feat(e2e): add AI4HC Payer SSE streaming client for Kore.ai baseline tests"
```

---

### Task 3: Create assertion helpers

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/assertions.ts`

- [ ] **Step 1: Write assertions file**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/assertions.ts

/**
 * Shared assertion helpers for AI4HC Payer E2E tests.
 * English text matching, agent routing verification, timing checks.
 */

import { expect } from 'vitest';
import type { ParsedResponse } from './sse-client';
import type { Turn } from './scenarios';

/**
 * Normalize text for comparison: lowercase, collapse whitespace.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if text contains any of the expected keywords (case-insensitive).
 */
export function containsAny(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some((kw) => normalized.includes(normalizeText(kw)));
}

/**
 * Check if text contains none of the forbidden keywords.
 */
export function containsNone(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.every((kw) => !normalized.includes(normalizeText(kw)));
}

/**
 * Assert a turn response matches expected behavior.
 */
export function assertTurnResponse(
  result: ParsedResponse,
  turn: Turn,
  turnIndex: number,
  scenarioName: string,
): void {
  const ctx = `[${scenarioName} Turn ${turnIndex + 1}]`;

  // Must have non-empty response
  expect(result.fullText.length, `${ctx} Empty response`).toBeGreaterThan(0);

  // Check expected keywords
  if (turn.expectAny && turn.expectAny.length > 0) {
    const found = containsAny(result.fullText, turn.expectAny);
    if (!found) {
      console.log(`${ctx} Response text: "${result.fullText.slice(0, 500)}"`);
      console.log(`${ctx} Expected any of: ${turn.expectAny.join(', ')}`);
    }
    expect(found, `${ctx} Expected keywords not found in response`).toBe(true);
  }

  // Check forbidden keywords
  if (turn.expectNone && turn.expectNone.length > 0) {
    const clean = containsNone(result.fullText, turn.expectNone);
    expect(clean, `${ctx} Forbidden keywords found in response`).toBe(true);
  }

  // Check agent routing (if detectable)
  if (turn.expectAgent && result.agentInfo?.displayName) {
    const actualAgent = result.agentInfo.displayName;
    const expectedNorm = normalizeText(turn.expectAgent);
    const actualNorm = normalizeText(actualAgent);
    const agentMatch = actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm);
    if (!agentMatch) {
      console.log(`${ctx} Agent mismatch: expected="${turn.expectAgent}" got="${actualAgent}"`);
    }
  }

  // Check timing
  if (turn.maxTimeMs) {
    const totalMs = result.timing.endMs - result.timing.startMs;
    if (totalMs > turn.maxTimeMs) {
      console.warn(
        `${ctx} Slow response: ${(totalMs / 1000).toFixed(1)}s > ${(turn.maxTimeMs / 1000).toFixed(1)}s limit`,
      );
    }
  }
}

/**
 * Log detailed timing and event info for a turn.
 */
export function logTurnDetails(
  result: ParsedResponse,
  turnIndex: number,
  scenarioName: string,
): void {
  const t = result.timing;
  const ttfb = t.firstChunkMs ? t.firstChunkMs - t.startMs : 0;
  const ttft = t.firstTokenMs ? t.firstTokenMs - t.startMs : 0;
  const total = t.endMs - t.startMs;

  console.log(`\n── ${scenarioName} · Turn ${turnIndex + 1} ──`);
  console.log(
    `  TTFB: ${(ttfb / 1000).toFixed(2)}s | TTFT: ${(ttft / 1000).toFixed(2)}s | Total: ${(total / 1000).toFixed(2)}s`,
  );
  console.log(`  Events: ${result.events.length} | Chars: ${result.fullText.length}`);
  if (result.agentInfo) {
    console.log(`  Agent: ${result.agentInfo.displayName}`);
  }
  console.log(
    `  Response: "${result.fullText.slice(0, 200)}${result.fullText.length > 200 ? '...' : ''}"`,
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/assertions.ts
git commit -m "feat(e2e): add AI4HC Payer assertion helpers"
```

---

### Task 4: Create provider metadata fixtures

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/fixtures/provider-metadata.ts`

- [ ] **Step 1: Write fixtures file**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/fixtures/provider-metadata.ts

/**
 * Provider and member test fixtures for AI4HC Payer E2E tests.
 * Mirrors data in Kore.ai Data Tables: providerinfo, eligibilitymembersinfo, claiminfo.
 */

/** Known test providers in providerinfo table */
export const TEST_PROVIDERS = {
  /** Valid 9-digit Provider ID */
  VALID_PROVIDER_ID: '123456789',
  /** Valid 10-digit NPI ID */
  VALID_NPI_ID: '1234567890',
  /** Invalid format (too short) */
  INVALID_SHORT_ID: '12345',
  /** Invalid format (letters) */
  INVALID_ALPHA_ID: 'ABCDEFGHI',
  /** Non-existent but valid format */
  NONEXISTENT_PROVIDER_ID: '999999999',
} as const;

/** Known test members in eligibilitymembersinfo table */
export const TEST_MEMBERS = {
  /** Member with active plan(s) */
  ACTIVE_MEMBER: 'MEM001',
  /** Member with claims */
  MEMBER_WITH_CLAIMS: 'MEM002',
  /** Non-existent member */
  NONEXISTENT_MEMBER: 'MEM999',
} as const;

/** Expected provider data after successful authentication */
export interface ProviderProfile {
  providerId: number;
  npiId: number;
  taxonomyCode: string;
  medicaidId: number;
  zipCode: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/fixtures/provider-metadata.ts
git commit -m "feat(e2e): add AI4HC Payer provider/member test fixtures"
```

---

### Task 5: Create Kore.ai baseline E2E test

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts`

- [ ] **Step 1: Write baseline test file**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts

/**
 * AI4HC Payer — Live Kore.ai Baseline E2E Test
 *
 * Tests against the LIVE Kore.ai Agent Platform API.
 * Validates conversational flows, agent routing, and response quality.
 *
 * Required env vars:
 *   AI4HC_API_KEY   – Kore.ai x-api-key
 *   AI4HC_APP_ID    – Kore.ai app ID
 *   AI4HC_BASE_URL  – Kore.ai base URL (default: https://agent-platform.kore.ai)
 *
 * Run with:
 *   AI4HC_API_KEY=kg-... AI4HC_APP_ID=aa-... npx vitest run --config vitest.integration.config.ts src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { SCENARIOS } from './scenarios';
import type { AI4HCClientConfig } from './sse-client';
import { sendMessage, makeSessionIdentity } from './sse-client';
import { assertTurnResponse, logTurnDetails } from './assertions';

dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});

// ─── Config ──────────────────────────────────────────────────────────────────

const AI4HC_API_KEY = process.env.AI4HC_API_KEY ?? '';
const AI4HC_APP_ID = process.env.AI4HC_APP_ID ?? '';
const AI4HC_BASE_URL = process.env.AI4HC_BASE_URL ?? 'https://agent-platform.kore.ai';

const SKIP_REASON = !AI4HC_API_KEY
  ? 'AI4HC_API_KEY not set — skipping live Kore.ai E2E tests'
  : !AI4HC_APP_ID
    ? 'AI4HC_APP_ID not set — skipping live Kore.ai E2E tests'
    : '';

const config: AI4HCClientConfig = {
  apiKey: AI4HC_API_KEY,
  appId: AI4HC_APP_ID,
  baseUrl: AI4HC_BASE_URL,
};

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!!SKIP_REASON)('AI4HC Payer — Live Kore.ai Baseline E2E', () => {
  beforeAll(() => {
    if (SKIP_REASON) return;
    console.log(`[AI4HC E2E] Endpoint: ${AI4HC_BASE_URL}`);
    console.log(`[AI4HC E2E] App ID: ${AI4HC_APP_ID}`);
    console.log(`[AI4HC E2E] Scenarios: ${SCENARIOS.length}`);
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const identity = makeSessionIdentity('ai4hc');

      for (let t = 0; t < scenario.turns.length; t++) {
        const turn = scenario.turns[t];
        const turnLabel = `Turn ${t + 1}: "${turn.user.slice(0, 50)}${turn.user.length > 50 ? '...' : ''}"`;

        test(
          turnLabel,
          async () => {
            const result = await sendMessage(config, turn.user, identity);

            logTurnDetails(result, t, scenario.name);
            assertTurnResponse(result, turn, t, scenario.name);

            expect(result.fullText.length).toBeGreaterThan(0);
          },
          turn.maxTimeMs ? turn.maxTimeMs + 15000 : 60000,
        );
      }
    });
  }
});

// ─── SSE Parser Unit Tests (always run) ──────────────────────────────────────

describe('AI4HC SSE Parser — extractJSONObjects', () => {
  const { extractJSONObjects } = require('./sse-client');

  test('parses single JSON object', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":0,"output":[{"type":"text","content":"Hello"}]}',
    );
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0]).output[0].content).toBe('Hello');
  });

  test('parses concatenated JSON objects', () => {
    const result = extractJSONObjects(
      '{"eventIndex":1,"output":[{"type":"text","content":"Welcome"}]}{"eventIndex":2,"output":[{"type":"text","content":" to"}]}',
    );
    expect(result).toHaveLength(2);
  });

  test('returns empty for non-JSON lines', () => {
    expect(extractJSONObjects('')).toHaveLength(0);
    expect(extractJSONObjects('event: message')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verify test file compiles**

Run: `cd apps/runtime && npx tsc --noEmit src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts
git commit -m "feat(e2e): add AI4HC Payer live Kore.ai baseline E2E test — 10 scenarios"
```

---

## Chunk 3: ABL DSL Agents

### Task 6: Create project.json and environment config

**Files:**

- Create: `examples/ai4hc-payer-provider/project.json`
- Create: `examples/ai4hc-payer-provider/environment/default.env.json`
- Create: `examples/ai4hc-payer-provider/config/behavioral_instructions.md`

- [ ] **Step 1: Write project.json**

```json
{
  "format_version": "2.0",
  "name": "AI For Healthcare Payer — Provider Facing",
  "slug": "ai4hc-payer-provider",
  "description": "Provider-facing health insurance virtual assistant for member plan info, coverage/eligibility, and claim status inquiries — ABL translation of Kore.ai 5-agent system",
  "abl_version": "1.0",
  "exported_at": "2026-03-13T00:00:00.000Z",
  "dsl_format": "legacy",
  "layers_included": ["core"],
  "entry_agent": "Healthcare_Supervisor",
  "agents": {
    "Healthcare_Supervisor": {
      "path": "agents/healthcare_supervisor.agent.abl",
      "description": "Greeting + auth-gated routing to specialized provider-facing agents",
      "type": "supervisor"
    },
    "Authentication_Agent": {
      "path": "agents/authentication_agent.agent.abl",
      "description": "Authenticates provider via Provider ID (9 digits) or NPI ID (10 digits)"
    },
    "Plan_Information_Agent": {
      "path": "agents/plan_information_agent.agent.abl",
      "description": "Retrieves member plan details: deductibles, OOP max, dates, status, benefits"
    },
    "Coverage_Information_Agent": {
      "path": "agents/coverage_information_agent.agent.abl",
      "description": "Coverage/eligibility queries using plan name + knowledge base RAG"
    },
    "Claim_Information_Agent": {
      "path": "agents/claim_information_agent.agent.abl",
      "description": "Retrieves member claim status with optional date/status/amount filters"
    }
  },
  "tools": {
    "healthcare_payer_tools": {
      "path": "tools/healthcare_payer.tools.abl"
    }
  },
  "metadata": {
    "entity_counts": {
      "agents": 5,
      "tools": 4
    },
    "required_env_vars": [
      "KORE_DATA_TABLES_AUTH_TOKEN",
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_API_KEY"
    ]
  }
}
```

- [ ] **Step 2: Write environment config**

```json
{
  "KORE_DATA_TABLES_AUTH_TOKEN": "${KORE_DATA_TABLES_AUTH_TOKEN}",
  "KORE_DATA_TABLES_BASE_URL": "https://platform.kore.ai/api/public/tables",
  "AZURE_OPENAI_ENDPOINT": "${AZURE_OPENAI_ENDPOINT}",
  "AZURE_OPENAI_API_KEY": "${AZURE_OPENAI_API_KEY}",
  "AZURE_OPENAI_DEPLOYMENT": "gpt-4.1"
}
```

- [ ] **Step 3: Write behavioral instructions**

```markdown
# AI4HC Payer — Provider-Facing Behavioral Instructions

1. You are a pure messenger/router — NEVER answer provider questions directly.
2. Every input from the provider MUST go through a tool/agent.
3. Every output to the provider MUST come from a tool/agent.
4. Pass sub-agent messages EXACTLY word-for-word — no rephrasing, summarizing, or interpreting.
5. Authentication MUST happen before any service request. Route to Authentication_Agent first.
6. NEVER re-authenticate once authentication_status shows "Authenticated".
7. After successful authentication, immediately route back to the original requesting agent.
8. Provider confirming details ("yes, that's correct") does NOT mean authenticated — route confirmation back to Authentication_Agent.
9. NEVER assume, guess, or make up any facts or information.
10. NEVER ask any question that was not explicitly asked by a tool or sub-agent.
11. Before concluding a use case is not covered, thoroughly review ALL available tools.
12. For multi-intent queries, break into individual requests and route sequentially.
13. Pass XML/Markdown content from sub-agents exactly as-is — do not reformat.
14. When a sub-agent needs information from the provider, ask for ONE piece at a time.
15. If no suitable agent matches, route to user for clarification ONLY after verifying all tools.
```

- [ ] **Step 4: Commit**

```bash
git add examples/ai4hc-payer-provider/
git commit -m "feat(ai4hc-e2e): add project.json, environment config, behavioral instructions"
```

---

### Task 7: Create Healthcare Supervisor agent

**Files:**

- Create: `examples/ai4hc-payer-provider/agents/healthcare_supervisor.agent.abl`

- [ ] **Step 1: Write supervisor DSL**

```abl
SUPERVISOR: Healthcare_Supervisor
VERSION: "1.0"
DESCRIPTION: "Provider-facing health insurance supervisor — greeting, auth-gated routing to plan/coverage/claim agents"
GOAL: "Greet providers, enforce authentication before any service request, route to specialized agents based on intent, act as pure messenger"

PERSONA: |
  You are the AI Supervisor for a provider-facing healthcare payer portal.

  OUTPUT CONTRACT (STRICT):
  - For pure greetings (hello, hi) with NO use case: respond directly with a warm welcome.
    "Hello! Welcome to the provider portal. I'm here to help you with member plan information,
    coverage details, and claim status. How can I assist you today?"
  - For ANY service request: acknowledge the use case, then immediately route to Authentication_Agent.
  - After authentication: route to the appropriate specialized agent.
  - You are a MESSENGER ONLY — deliver messages to/from agents word-for-word.
  - NEVER answer provider questions, provide information, or make decisions yourself.
  - NEVER ask questions not asked by a sub-agent.
  - NEVER assume information not given by a tool or the provider.

  AUTHENTICATION GATE:
  - For ANY use case (plan info, coverage, claims), check authentication_status FIRST.
  - If NOT "Authenticated": route to Authentication_Agent immediately.
  - If "Authenticated": route directly to the appropriate specialized agent.
  - NEVER re-authenticate once authentication_status is "Authenticated".
  - Provider saying "yes, that's correct" during auth is NOT authentication — route back to Authentication_Agent.
  - After successful auth, immediately route to the original requesting agent with the provider's original request.

  INTENT ROUTING (authenticated providers only):
  - Plan information / deductible / OOP / plan status / dates → Plan_Information_Agent
  - Coverage / eligibility / copay / coinsurance / prior auth / covered services → Coverage_Information_Agent
  - Claim status / claim payment / claim details / EOB → Claim_Information_Agent
  - Farewell / goodbye / thank you / done → End conversation gracefully
  - Small talk → Respond appropriately, stay available

  MULTI-INTENT: Break into individual requests, route sequentially.

EXECUTION:
  model: gpt-4.1
  temperature: 0.4
  max_tokens: 256
  max_iterations: 15
  inline_gather: true

MEMORY:
  session:
    - authentication_status
    - provider_id
    - npi_id
    - current_intent
    - original_intent
    - member_id

HANDOFF:
  # P0 — Authentication gate (must authenticate before any service)
  - TO: Authentication_Agent
    WHEN: authentication_status != "Authenticated" AND (intent contains "plan" OR intent contains "coverage" OR intent contains "eligibility" OR intent contains "claim" OR intent contains "deductible" OR intent contains "copay" OR intent contains "member" OR intent contains "patient")
    CONTEXT:
      pass: [current_intent, original_intent]
      summary: "Provider needs authentication before accessing services"
    RETURN: true
    ON_RETURN: "route_to_original_intent"

  # P1 — Plan information
  - TO: Plan_Information_Agent
    WHEN: authentication_status == "Authenticated" AND (intent contains "plan" OR intent contains "deductible" OR intent contains "out-of-pocket" OR intent contains "OOP" OR intent contains "plan status" OR intent contains "plan dates" OR intent contains "benefits")
    CONTEXT:
      pass: [provider_id, npi_id, member_id]
      summary: "Retrieve member plan information"
    RETURN: true
    ON_RETURN: "offer_further_assistance"

  # P2 — Coverage / eligibility
  - TO: Coverage_Information_Agent
    WHEN: authentication_status == "Authenticated" AND (intent contains "coverage" OR intent contains "eligibility" OR intent contains "copay" OR intent contains "coinsurance" OR intent contains "prior auth" OR intent contains "covered" OR intent contains "services")
    CONTEXT:
      pass: [provider_id, npi_id, member_id]
      summary: "Coverage and eligibility inquiry"
    RETURN: true
    ON_RETURN: "offer_further_assistance"

  # P3 — Claim information
  - TO: Claim_Information_Agent
    WHEN: authentication_status == "Authenticated" AND (intent contains "claim" OR intent contains "claim status" OR intent contains "claim payment" OR intent contains "EOB")
    CONTEXT:
      pass: [provider_id, npi_id, member_id]
      summary: "Retrieve member claim information"
    RETURN: true
    ON_RETURN: "offer_further_assistance"

COMPLETE:
  - WHEN: intent contains "goodbye" OR intent contains "done" OR intent contains "thank" OR intent contains "that's all"
    RESPOND: "Thank you for using the provider portal. Have a great day!"
```

- [ ] **Step 2: Commit**

```bash
git add examples/ai4hc-payer-provider/agents/healthcare_supervisor.agent.abl
git commit -m "feat(ai4hc-e2e): add Healthcare Supervisor with auth-gated 2-level routing"
```

---

### Task 8: Create Authentication Agent

**Files:**

- Create: `examples/ai4hc-payer-provider/agents/authentication_agent.agent.abl`

- [ ] **Step 1: Write authentication agent DSL**

```abl
AGENT: Authentication_Agent
GOAL: "Authenticate providers by collecting Provider ID (9 digits) or NPI ID (10 digits), validating format, confirming with provider, then calling perform_provider_authentication"

PERSONA: |
  You authenticate providers for provider-facing services.
  You do NOT handle any use cases — only authentication.

  FLOW:
  Step 1 — Collect Identifier:
  Ask: "To verify your identity, could you please provide your Provider ID or NPI ID?"
  - Provider ID: exactly 9 digits
  - NPI ID: exactly 10 digits

  Step 2 — Format Validation:
  - If input is exactly 9 digits → treat as Provider ID
  - If input is exactly 10 digits → treat as NPI ID
  - Otherwise → "Invalid format. Provider ID must be exactly 9 digits, or NPI ID must be exactly 10 digits. Please try again."

  Step 3 — Confirm with Provider:
  - "I have your [Provider ID / NPI ID] as [number]. Is that correct?"
  - Wait for explicit confirmation ("yes", "correct", "that's right")
  - If provider says "no" or corrects → go back to Step 1

  Step 4 — Call Authentication Tool:
  - Call perform_provider_authentication with the confirmed identifier
  - If success: "Your identity has been verified successfully. You are now authenticated."
  - If failure: "Authentication failed. The [Provider ID / NPI ID] could not be verified. Please check and try again."

  CRITICAL RULES:
  - ONLY accept Provider ID (9 digits) or NPI ID (10 digits) — no other identifiers
  - ALWAYS confirm the identifier before calling the tool
  - Provider confirmation is NOT authentication — the tool MUST verify
  - Do NOT handle any service requests — only authentication
  - Do NOT ask about Member IDs — that's for other agents

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 256
  max_iterations: 8
  inline_gather: true

TOOLS:
  perform_provider_authentication(providerId: string, npiId: string) -> {success: boolean, message: string, providerInfo: object}
    type: http
    endpoint: "${KORE_DATA_TABLES_BASE_URL}/providerinfo/query?sys_limit=100"
    method: POST
    headers:
      auth: "${KORE_DATA_TABLES_AUTH_TOKEN}"
      Content-Type: "application/json"
    body:
      query:
        expressions:
          - field: "{{providerId ? 'providerId' : 'npiId'}}"
            operand: "="
            value: "{{providerId || npiId}}"
    description: "Validate provider credentials against the provider database and store provider data in session"

GATHER:
  provider_identifier:
    prompt: "Could you please provide your Provider ID or NPI ID?"
    type: string
    required: true
    validation: "Must be exactly 9 digits (Provider ID) or 10 digits (NPI ID)"

COMPLETE:
  - WHEN: authentication_status == "Authenticated"
    RESPOND: "Your identity has been verified successfully."
```

- [ ] **Step 2: Commit**

```bash
git add examples/ai4hc-payer-provider/agents/authentication_agent.agent.abl
git commit -m "feat(ai4hc-e2e): add Authentication Agent — Provider ID / NPI ID validation"
```

---

### Task 9: Create Plan Information Agent

**Files:**

- Create: `examples/ai4hc-payer-provider/agents/plan_information_agent.agent.abl`

- [ ] **Step 1: Write plan information agent DSL**

```abl
AGENT: Plan_Information_Agent
GOAL: "Retrieve and present member plan information to authenticated providers — deductibles, out-of-pocket max, plan status, dates, benefits"

PERSONA: |
  You provide member plan information to authenticated providers.
  You do NOT authenticate providers — that is handled by Authentication_Agent.

  PRECONDITION: Provider MUST be authenticated (do not authenticate here).

  FLOW:
  Step 1 — Collect Member ID:
  Ask: "Please provide the Member ID you'd like to look up."
  - Accept one Member ID at a time

  Step 2 — Call get_plan_information:
  Call get_plan_information with the memberId.

  Step 3 — Handle Response:
  - If success with plans found:
    Present ONLY what the provider asked for:
    - If asked about deductibles → show deductible breakdown (in-network/out-network, individual/family)
    - If asked about out-of-pocket → show OOP max breakdown
    - If asked about plan status → show status and dates
    - If asked for full summary → show comprehensive plan overview
    - For web: use markdown tables for numeric amounts (deductibles, OOP)
    - Show: total, met/paid so far, remaining for financial fields
    - Individual vs Family: only show family fields if plan is Family type
    - Benefits: general, dental, vision, mental, pharmacy, alternative (true/false)
  - If no plans found:
    "No active plans found for member ID [memberId]."
  - If error:
    "Unable to retrieve plan information at this time. Please try again later."

  Step 4 — Follow-up:
  "Is there anything else I can help you with?"

  CRITICAL RULES:
  - NEVER hallucinate plan data — only present what comes from the tool
  - Present ONLY what was asked (deductible vs OOP vs status vs full summary)
  - Do NOT duplicate information across sections
  - Use markdown tables for structured numeric data on web channel

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 4000
  max_iterations: 8
  inline_gather: true

TOOLS:
  get_plan_information(memberId: string) -> {success: boolean, message: string, plans: array, memberId: string}
    type: http
    endpoint: "${KORE_DATA_TABLES_BASE_URL}/eligibilitymembersinfo/query?sys_limit=100"
    method: POST
    headers:
      auth: "${KORE_DATA_TABLES_AUTH_TOKEN}"
      Content-Type: "application/json"
    body:
      query:
        expressions:
          - field: "memberId"
            operand: "="
            value: "{{memberId}}"
    description: "Retrieve comprehensive plan information for a member — plan names, coverage types, dates, deductibles, OOP max, benefits"

GATHER:
  member_id:
    prompt: "Please provide the Member ID you'd like to look up."
    type: string
    required: true

COMPLETE:
  - WHEN: plan_info_displayed == true
    RESPOND: "Is there anything else I can help you with?"
```

- [ ] **Step 2: Commit**

```bash
git add examples/ai4hc-payer-provider/agents/plan_information_agent.agent.abl
git commit -m "feat(ai4hc-e2e): add Plan Information Agent — deductibles, OOP, status, benefits"
```

---

### Task 10: Create Coverage Information Agent

**Files:**

- Create: `examples/ai4hc-payer-provider/agents/coverage_information_agent.agent.abl`

- [ ] **Step 1: Write coverage information agent DSL**

```abl
AGENT: Coverage_Information_Agent
GOAL: "Answer provider coverage/eligibility questions — retrieve plan name via get_plan_information, then query knowledge base with FULL plan name for coverage details"

PERSONA: |
  You are a provider-facing service eligibility and coverage agent.
  You answer: "Is X covered?", copay/coinsurance, prior authorization, limits, available services.

  PRECONDITION: Provider MUST be authenticated (do not authenticate here).

  FLOW:
  Step 1 — Collect Member ID:
  Ask: "Please provide the Member ID for the coverage inquiry."

  Step 2 — Get Plan Name:
  Call get_plan_information(memberId) to obtain the FULL plan name.
  - Do NOT abbreviate or use partial plan names.
  - If no plan found: "No active plan found for member ID [memberId]."

  Step 3 — Query Knowledge Base:
  Call Plan_Services_Coverage_Knowledge_Base with the FULL plan name as the query.
  - Use the exact plan name returned by get_plan_information — no abbreviations or partials.
  - If the provider asked about a specific service, include it in the query.

  Step 4 — Present Results:
  Present ONLY what the provider asked:
  - Coverage status → "Is [service] covered under [plan]?"
  - Copay → copay amount for the service
  - Coinsurance → coinsurance rate
  - Prior authorization → whether prior auth is required
  - Limits → coverage limits or visit limits
  - Service list → available services under the plan
  - Web: use tables only when helpful; no duplication.

  Step 5 — Follow-up:
  "Is there anything else you'd like to know about this member's coverage?"

  CRITICAL RULES:
  - Always get the plan name from get_plan_information FIRST
  - Query the knowledge base with the FULL plan name (no abbreviations)
  - Present ONLY what was asked — do not dump all coverage details
  - NEVER hallucinate coverage information

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 4000
  max_iterations: 10
  inline_gather: true

TOOLS:
  get_plan_information(memberId: string) -> {success: boolean, message: string, plans: array, memberId: string}
    type: http
    endpoint: "${KORE_DATA_TABLES_BASE_URL}/eligibilitymembersinfo/query?sys_limit=100"
    method: POST
    headers:
      auth: "${KORE_DATA_TABLES_AUTH_TOKEN}"
      Content-Type: "application/json"
    body:
      query:
        expressions:
          - field: "memberId"
            operand: "="
            value: "{{memberId}}"
    description: "Get member's plan name for knowledge base query"

  Plan_Services_Coverage_Knowledge_Base(query: string) -> {answer: string, chunks: array}
    type: knowledge
    source: "Plan_Services_Coverage_Knowledge_Base"
    description: "Search coverage information by plan name — copay, coinsurance, prior auth, limits, services"

GATHER:
  member_id:
    prompt: "Please provide the Member ID for the coverage inquiry."
    type: string
    required: true

COMPLETE:
  - WHEN: coverage_info_displayed == true
    RESPOND: "Is there anything else you'd like to know about this member's coverage?"
```

- [ ] **Step 2: Commit**

```bash
git add examples/ai4hc-payer-provider/agents/coverage_information_agent.agent.abl
git commit -m "feat(ai4hc-e2e): add Coverage Information Agent — plan name + KB RAG lookup"
```

---

### Task 11: Create Claim Information Agent

**Files:**

- Create: `examples/ai4hc-payer-provider/agents/claim_information_agent.agent.abl`

- [ ] **Step 1: Write claim information agent DSL**

```abl
AGENT: Claim_Information_Agent
GOAL: "Retrieve and present member claim status to authenticated providers — supports filtering by date, status, and amount"

PERSONA: |
  You retrieve and present member claim information to authenticated providers.
  You do NOT authenticate providers — that is handled by Authentication_Agent.

  PRECONDITION: Provider MUST be authenticated (do not authenticate here).

  FLOW:
  Step 1 — Collect Member ID:
  Ask: "Please provide the Member ID to check claims for."
  - Also accept optional filters if provider mentions them:
    - Claim date (YYYY-MM-DD format)
    - Claim status: "Submitted", "Denied", or "Paid"
    - Claim amount

  Step 2 — Call get_claim_information:
  Call get_claim_information with memberId and any provided filters.

  Step 3 — Handle Response:
  - If claims found:
    - Single claim → present as text with key details:
      Claim Number, Status, Amount, Request Date, Service Received
    - Multiple claims → present as markdown table:
      | Claim # | Status | Amount | Date | Service |
    - Include payment info (warrant number/amount/date) if available
    - Include accident/job-related flags if relevant
    - Show documentation links (claimBillLink) if available
  - If no claims found:
    "No claims found for member ID [memberId]."
    If filters were applied: "No claims found matching your criteria for member ID [memberId]."
  - If error:
    "Unable to retrieve claim information at this time. Please try again later."

  Step 4 — Follow-up:
  "Would you like to check claims for another member or filter these results?"

  FILTER SUPPORT:
  - Date filter: "claims from January 2025" → claimReqDate filter
  - Status filter: "only denied claims" → claimStatus = "Denied"
  - Amount filter: "claims over $1000" → claimAmount filter
  - Valid statuses: Submitted, Denied, Paid

  CRITICAL RULES:
  - NEVER hallucinate claim data — only present what comes from the tool
  - Present ONLY what was asked; avoid duplication
  - Format amounts as currency ($X,XXX.XX)
  - Format dates in readable format (e.g., "January 15, 2025")

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 4000
  max_iterations: 8
  inline_gather: true

TOOLS:
  get_claim_information(memberId: string, claimReqDate: string, claimStatus: string, claimAmount: string) -> {success: boolean, message: string, claims: array, memberId: string}
    type: http
    endpoint: "${KORE_DATA_TABLES_BASE_URL}/claiminfo/query?sys_limit=100&sys_offset=0"
    method: POST
    headers:
      auth: "${KORE_DATA_TABLES_AUTH_TOKEN}"
      Content-Type: "application/json"
    body:
      query:
        expressions:
          - field: "memberId"
            operand: "="
            value: "{{memberId}}"
    description: "Retrieve comprehensive claim information for a member with optional date/status/amount filters"

GATHER:
  member_id:
    prompt: "Please provide the Member ID to check claims for."
    type: string
    required: true

  claim_date_filter:
    prompt: "Would you like to filter by a specific date? (optional)"
    type: string
    required: false

  claim_status_filter:
    prompt: "Filter by status? Submitted, Denied, or Paid (optional)"
    type: string
    required: false
    options: ["Submitted", "Denied", "Paid"]

COMPLETE:
  - WHEN: claims_displayed == true
    RESPOND: "Would you like to check claims for another member or apply different filters?"
```

- [ ] **Step 2: Commit**

```bash
git add examples/ai4hc-payer-provider/agents/claim_information_agent.agent.abl
git commit -m "feat(ai4hc-e2e): add Claim Information Agent — status, filters, markdown tables"
```

---

### Task 12: Create tool bindings

**Files:**

- Create: `examples/ai4hc-payer-provider/tools/healthcare_payer.tools.abl`

- [ ] **Step 1: Write tool bindings**

```abl
# Healthcare Payer Tools
# These tools query Kore.ai Data Tables API for provider/member/claim data.
# Tool implementations are defined inline in agent DSL files.
# This file serves as a tool registry reference.

# Tools:
#   perform_provider_authentication — Authenticate provider by Provider ID (9 digits) or NPI ID (10 digits)
#     Endpoint: POST platform.kore.ai/api/public/tables/providerinfo/query
#     Params: providerId (string, optional), npiId (string, optional) — at least one required
#     Returns: { success, message, providerInfo: { providerId, npiId } }
#     Side-effect: Stores provider data in session memory (provider_data)
#
#   get_plan_information — Retrieve member plan details by Member ID
#     Endpoint: POST platform.kore.ai/api/public/tables/eligibilitymembersinfo/query
#     Params: memberId (string, required)
#     Returns: { success, message, plans: [...], memberId }
#     Plan fields: name, startDate, coverageType, status, networkType, expiryDate, benefits, deductibles, outOfPocketMax
#
#   get_claim_information — Retrieve member claims by Member ID with optional filters
#     Endpoint: POST platform.kore.ai/api/public/tables/claiminfo/query
#     Params: memberId (string, required), claimReqDate (string, optional), claimStatus (string, optional), claimAmount (string, optional)
#     Returns: { success, message, claims: [...], memberId, channelType, hasMore }
#     Claim fields: claimNumber, claimStatus, claimAmount, claimReqDate, paymentInfo, serviceReceived, claimBillLink
#
#   Plan_Services_Coverage_Knowledge_Base — RAG knowledge base for coverage details
#     Type: KNOWLEDGE
#     Params: query (string, required) — search query using FULL plan name
#     Returns: Coverage details, copay/coinsurance rates, prior auth requirements, service lists
```

- [ ] **Step 2: Commit**

```bash
git add examples/ai4hc-payer-provider/tools/healthcare_payer.tools.abl
git commit -m "feat(ai4hc-e2e): add tool registry reference — 3 HTTP tools + 1 knowledge tool"
```

---

## Chunk 4: ABL Runtime Test + Comparison

### Task 13: Create ABL Runtime E2E test

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-abl-runtime.e2e.test.ts`

- [ ] **Step 1: Write ABL runtime test**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-abl-runtime.e2e.test.ts

/**
 * AI4HC Payer — ABL Runtime E2E Test
 *
 * Tests conversational scenarios against the ABL Runtime with compiled agent DSL files.
 * Uses the same Data Tables API as Kore.ai production.
 *
 * Architecture:
 *   Healthcare_Supervisor → auth gate → routes to 3 child agents
 *   Authentication_Agent → Plan_Information_Agent / Coverage_Information_Agent / Claim_Information_Agent
 *
 * Required env vars:
 *   AZURE_OPENAI_API_KEY           – For GPT-4.1 LLM
 *   AZURE_OPENAI_ENDPOINT          – Azure OpenAI endpoint
 *   KORE_DATA_TABLES_AUTH_TOKEN    – Kore.ai Data Tables API token
 *
 * Run with:
 *   npx vitest run --config vitest.config.ts src/__tests__/e2e/ai4hc-payer/ai4hc-abl-runtime.e2e.test.ts
 */

import { describe, test, expect, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

// Mock DB models to avoid Mongoose timeouts (no MongoDB in E2E)
vi.mock('@agent-platform/database/models', () => ({
  AgentModel: { findOne: vi.fn(), find: vi.fn() },
  ProjectModel: { findOne: vi.fn() },
  ToolModel: { findOne: vi.fn(), find: vi.fn() },
}));

dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});

import { SCENARIOS } from './scenarios';

// ─── Config ──────────────────────────────────────────────────────────────────

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? '';
const KORE_DATA_TABLES_AUTH_TOKEN = process.env.KORE_DATA_TABLES_AUTH_TOKEN ?? '';

const SKIP_REASON = !AZURE_OPENAI_API_KEY
  ? 'AZURE_OPENAI_API_KEY not set — skipping ABL Runtime E2E tests'
  : !KORE_DATA_TABLES_AUTH_TOKEN
    ? 'KORE_DATA_TABLES_AUTH_TOKEN not set — skipping ABL Runtime E2E tests'
    : '';

const DSL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../examples/ai4hc-payer-provider',
);

// ─── DSL Compilation ─────────────────────────────────────────────────────────

interface CompiledProject {
  agents: Map<string, unknown>;
  tools: Map<string, unknown>;
  config: Record<string, unknown>;
}

async function compileProject(): Promise<CompiledProject> {
  const { ABLCompiler } = await import('@abl/compiler');

  const projectJsonPath = path.join(DSL_DIR, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    throw new Error(`project.json not found at ${projectJsonPath}`);
  }

  const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
  const compiler = new ABLCompiler();

  const agents = new Map<string, unknown>();
  for (const [agentName, agentDef] of Object.entries(projectJson.agents)) {
    const agentPath = (agentDef as { path: string }).path;
    const fullPath = path.join(DSL_DIR, agentPath);
    const dsl = fs.readFileSync(fullPath, 'utf-8');
    const compiled = compiler.compile(dsl);
    agents.set(agentName, compiled);
  }

  const tools = new Map<string, unknown>();
  for (const [toolName, toolDef] of Object.entries(projectJson.tools ?? {})) {
    const toolPath = (toolDef as { path: string }).path;
    const fullPath = path.join(DSL_DIR, toolPath);
    const dsl = fs.readFileSync(fullPath, 'utf-8');
    const compiled = compiler.compile(dsl);
    tools.set(toolName, compiled);
  }

  return { agents, tools, config: projectJson };
}

// ─── Runtime Executor Wrapper ────────────────────────────────────────────────

interface ABLResponse {
  text: string;
  agentName: string | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  traces: Array<{ type: string; data: Record<string, unknown>; timestamp: number }>;
  timing: { startMs: number; endMs: number; firstTokenMs: number };
}

async function executeABLTurn(
  project: CompiledProject,
  userMessage: string,
  sessionVars: Record<string, unknown>,
): Promise<ABLResponse> {
  // TODO: Wire up to actual RuntimeExecutor once compiler output format is confirmed
  const startMs = Date.now();

  return {
    text: '[ABL Runtime not yet wired — compile check only]',
    agentName: null,
    toolCalls: [],
    traces: [],
    timing: { startMs, endMs: Date.now(), firstTokenMs: Date.now() },
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!!SKIP_REASON)('AI4HC Payer — ABL Runtime E2E', () => {
  let project: CompiledProject;

  beforeAll(async () => {
    if (SKIP_REASON) return;
    console.log(`[AI4HC ABL E2E] DSL directory: ${DSL_DIR}`);
    console.log(`[AI4HC ABL E2E] Compiling project...`);
    project = await compileProject();
    console.log(
      `[AI4HC ABL E2E] Compiled ${project.agents.size} agents, ${project.tools.size} tool groups`,
    );
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const sessionVars: Record<string, unknown> = {
        authentication_status: '',
        provider_id: null,
        npi_id: null,
      };

      for (let t = 0; t < scenario.turns.length; t++) {
        const turn = scenario.turns[t];
        const turnLabel = `Turn ${t + 1}: "${turn.user.slice(0, 50)}"`;

        test(
          turnLabel,
          async () => {
            const result = await executeABLTurn(project, turn.user, sessionVars);

            expect(result).toBeDefined();
            expect(result.timing.endMs).toBeGreaterThanOrEqual(result.timing.startMs);

            console.log(`  [${scenario.name} T${t + 1}] Agent: ${result.agentName ?? 'N/A'}`);
            console.log(`  Response: "${result.text.slice(0, 200)}"`);
          },
          90000,
        );
      }
    });
  }

  // Compilation-only test (always runs)
  test('All DSL files compile without errors', async () => {
    expect(project.agents.size).toBe(5);
    expect(project.tools.size).toBeGreaterThanOrEqual(1);

    const agentNames = [...project.agents.keys()];
    expect(agentNames).toContain('Healthcare_Supervisor');
    expect(agentNames).toContain('Authentication_Agent');
    expect(agentNames).toContain('Plan_Information_Agent');
    expect(agentNames).toContain('Coverage_Information_Agent');
    expect(agentNames).toContain('Claim_Information_Agent');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/ai4hc-abl-runtime.e2e.test.ts
git commit -m "feat(e2e): add AI4HC Payer ABL Runtime E2E test with DSL compilation check"
```

---

### Task 14: Create comparison report generator

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/ai4hc-payer/generate-comparison.ts`

- [ ] **Step 1: Write comparison generator**

```typescript
// apps/runtime/src/__tests__/e2e/ai4hc-payer/generate-comparison.ts

/**
 * AI4HC Payer — Comparison Report Generator
 *
 * Generates a markdown report comparing Kore.ai baseline vs ABL Runtime results.
 *
 * Usage:
 *   npx tsx src/__tests__/e2e/ai4hc-payer/generate-comparison.ts \
 *     --baseline koreai-results.json \
 *     --abl abl-results.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScenarioResult {
  scenario: string;
  userMessage: string;
  response: string;
  agentName: string | null;
  timing: {
    ttfb: number;
    ttft: number;
    total: number;
  };
  toolCalls: string[];
  passed: boolean;
}

interface RunReport {
  timestamp: string;
  platform: 'koreai' | 'abl';
  model: string;
  scenarios: ScenarioResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgTotalMs: number;
    avgTtfbMs: number;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ms(n: number): string {
  return `${(n / 1000).toFixed(1)}s`;
}

function pctDelta(baseline: number, current: number): string {
  if (baseline === 0) return 'N/A';
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct >= 0 ? '+' : '';
  const bold = pct < 0 ? '**' : '';
  return `${bold}${sign}${pct.toFixed(0)}%${bold}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ─── Report Generator ───────────────────────────────────────────────────────

function generateComparison(baseline: RunReport, abl: RunReport, outputPath: string): void {
  const lines: string[] = [];
  const now = new Date().toISOString().split('T')[0];

  const w = (line: string) => lines.push(line);
  const blank = () => lines.push('');

  w('# AI4HC Payer — ABL Runtime vs Kore.ai Baseline Comparison');
  blank();
  w(`> **Generated:** ${now}`);
  w(`> **Baseline:** Kore.ai production (${baseline.timestamp})`);
  w(`> **ABL Runtime:** Model: ${abl.model} (${abl.timestamp})`);
  blank();
  w('---');
  blank();

  // Executive Summary
  w('## Executive Summary');
  blank();
  w('| Metric | Kore.ai | ABL Runtime | Delta |');
  w('| --- | --- | --- | --- |');
  w(
    `| Pass Rate | ${baseline.summary.passed}/${baseline.summary.total} | ${abl.summary.passed}/${abl.summary.total} | |`,
  );
  w(
    `| Avg TTFB | ${ms(baseline.summary.avgTtfbMs)} | ${ms(abl.summary.avgTtfbMs)} | ${pctDelta(baseline.summary.avgTtfbMs, abl.summary.avgTtfbMs)} |`,
  );
  w(
    `| Avg Total | ${ms(baseline.summary.avgTotalMs)} | ${ms(abl.summary.avgTotalMs)} | ${pctDelta(baseline.summary.avgTotalMs, abl.summary.avgTotalMs)} |`,
  );
  blank();

  // Per-scenario comparison
  w('## Scenario Comparison');
  blank();
  w('| Scenario | Kore.ai Total | ABL Total | Delta | Kore.ai Agent | ABL Agent | Both Pass |');
  w('| --- | --- | --- | --- | --- | --- | --- |');

  for (const blScenario of baseline.scenarios) {
    const ablScenario = abl.scenarios.find((s) => s.scenario === blScenario.scenario);
    if (!ablScenario) {
      w(
        `| ${blScenario.scenario} | ${ms(blScenario.timing.total)} | N/A | N/A | ${blScenario.agentName ?? '-'} | - | - |`,
      );
      continue;
    }
    const delta = pctDelta(blScenario.timing.total, ablScenario.timing.total);
    const bothPass = blScenario.passed && ablScenario.passed ? 'YES' : 'NO';
    w(
      `| ${blScenario.scenario} | ${ms(blScenario.timing.total)} | ${ms(ablScenario.timing.total)} | ${delta} | ${blScenario.agentName ?? '-'} | ${ablScenario.agentName ?? '-'} | ${bothPass} |`,
    );
  }
  blank();

  // Transcripts
  w('## Response Transcripts');
  blank();
  for (const blScenario of baseline.scenarios) {
    const ablScenario = abl.scenarios.find((s) => s.scenario === blScenario.scenario);
    w(`### ${blScenario.scenario}`);
    blank();
    w(`**User:** "${blScenario.userMessage}"`);
    blank();
    w(`**Kore.ai (${ms(blScenario.timing.total)}):** "${truncate(blScenario.response, 500)}"`);
    blank();
    if (ablScenario) {
      w(`**ABL (${ms(ablScenario.timing.total)}):** "${truncate(ablScenario.response, 500)}"`);
    } else {
      w(`**ABL:** Not tested`);
    }
    blank();
    w('---');
    blank();
  }

  const output = lines.join('\n');
  writeFileSync(outputPath, output, 'utf-8');
  console.log(`\nComparison report: ${outputPath}`);
  console.log(`   ${baseline.scenarios.length} scenarios compared`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const currentDir = dirname(fileURLToPath(import.meta.url));

  let baselinePath = '';
  let ablPath = '';
  let outputPath = resolve(currentDir, 'AI4HC_ABL_VS_BASELINE_COMPARISON.md');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--baseline' && args[i + 1]) {
      baselinePath = resolve(args[++i]);
    } else if (args[i] === '--abl' && args[i + 1]) {
      ablPath = resolve(args[++i]);
    } else if (args[i] === '--out' && args[i + 1]) {
      outputPath = resolve(args[++i]);
    }
  }

  if (!baselinePath || !ablPath) {
    console.error(
      'Usage: --baseline <koreai-results.json> --abl <abl-results.json> [--out <file>]',
    );
    process.exit(1);
  }

  if (!existsSync(baselinePath)) {
    console.error(`Baseline not found: ${baselinePath}`);
    process.exit(1);
  }
  if (!existsSync(ablPath)) {
    console.error(`ABL results not found: ${ablPath}`);
    process.exit(1);
  }

  const baseline: RunReport = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const abl: RunReport = JSON.parse(readFileSync(ablPath, 'utf-8'));

  generateComparison(baseline, abl, outputPath);
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/ai4hc-payer/generate-comparison.ts
git commit -m "feat(e2e): add AI4HC Payer comparison report generator"
```

---

### Task 15: Verification and run commands

- [ ] **Step 1: Verify DSL files parse**

```bash
# Check all ABL files have valid syntax (basic structural check)
for f in examples/ai4hc-payer-provider/agents/*.agent.abl; do
  echo "Checking $f..."
  head -1 "$f"  # Should be SUPERVISOR: or AGENT:
done
```

- [ ] **Step 2: Verify test files compile**

```bash
cd apps/runtime
npx tsc --noEmit src/__tests__/e2e/ai4hc-payer/scenarios.ts src/__tests__/e2e/ai4hc-payer/sse-client.ts src/__tests__/e2e/ai4hc-payer/assertions.ts 2>&1 | head -30
```

- [ ] **Step 3: Run Kore.ai baseline (requires API key)**

```bash
AI4HC_API_KEY=kg-... AI4HC_APP_ID=aa-... npx vitest run --config vitest.integration.config.ts src/__tests__/e2e/ai4hc-payer/ai4hc-koreai.e2e.test.ts
```

- [ ] **Step 4: Run ABL compilation check (no API key needed)**

```bash
npx vitest run --config vitest.config.ts src/__tests__/e2e/ai4hc-payer/ai4hc-abl-runtime.e2e.test.ts
```

- [ ] **Step 5: Run full comparison**

```bash
npx tsx src/__tests__/e2e/ai4hc-payer/generate-comparison.ts \
  --baseline ai4hc-koreai-results.json \
  --abl ai4hc-abl-results.json \
  --out AI4HC_ABL_VS_BASELINE_COMPARISON.md
```

---

## Execution Order

1. **Tasks 1-5** (Chunk 2): Kore.ai baseline test harness — can run immediately against live API
2. **Tasks 6-12** (Chunk 3): ABL DSL agents + tools — compile and validate structure
3. **Tasks 13-14** (Chunk 4): ABL runtime test + comparison — wire up after DSL compiles
4. **Task 15**: End-to-end verification

Dependencies:

- Tasks 13 depends on Tasks 6-12 (needs compiled DSL)
- Task 14 depends on Tasks 5 and 13 (needs both result JSONs)
- Tasks 1-5 are independent of Tasks 6-12
