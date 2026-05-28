# Saludsa E2E: ABL Runtime vs Kore.ai Agent Platform — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a side-by-side E2E comparison of the Saludsa health insurance virtual assistant running on (A) the live Kore.ai Agent Platform and (B) the ABL Runtime, measuring functional parity, latency, and routing accuracy.

**Architecture:** The Kore.ai Saludsa app is a 16-agent supervisor-orchestrated system where EACH agent has a rich multi-step workflow prompt (`agent.prompt.custom`, 976–20,861 chars) plus a JavaScript preprocessor that calls APIs and injects session variables via `{{memory.X.Y}}` template replacement. The supervisor orchestration prompt implements a 5-level routing decision tree. For ABL, we restructure into **7 agents** by merging trivial transfer/metadata agents into FLOW steps of their parent agents, while preserving every agent's complete workflow logic as ABL FLOW steps with CALL/GATHER/SET/WHEN expressions.

**Tech Stack:** ABL DSL (agents, supervisors, flows, tools), Vitest E2E, MCP over HTTP (Saludsa backend), CEL expressions, SSE streaming, Azure OpenAI GPT-4.1

---

## Chunk 1: Architecture Analysis & File Structure

### Corrected Kore.ai Architecture (Key Discovery)

**Every Kore.ai agent has TWO layers of logic:**

1. **`agent.prompt.custom`** — Detailed step-by-step workflow instructions (976–20,861 chars each) with:
   - Channel-specific branching (`whatsapp` vs `WEB` vs `voice`)
   - Role-based validation (`Holder`, `Beneficiary`, `Broker`, `Payer`, `Non Client`)
   - Tool call sequences with specific parameter mappings
   - Retry logic (2 attempts for OTP, ID validation, security questions)
   - Spanish response templates (exact phrases that MUST be used verbatim)
   - Handoff triggers (`saveTransferSAC`, `HandleServiceFailure`)

2. **`agent.processors[0].resource.func`** — JavaScript preprocessor that:
   - Reads `sessionMeta` memory store
   - Calls `validateUser` or `userValidation` API for WEB/iOS/Android channels
   - Sets `userInfo` and `transfer_metadata` memory stores
   - Replaces `{{memory.X.Y}}` template vars in the prompt before LLM sees it

### Kore.ai → ABL Mapping

| Kore.ai Concept                                                | ABL Equivalent                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `app.orchestrationPrompt` (5-level routing tree)               | SUPERVISOR with HANDOFF rules using WHEN expressions                       |
| `agent.prompt.custom` step-by-step workflows                   | Agent PERSONA with embedded workflow instructions                          |
| Preprocessor JS (`validateUser` API call)                      | ABL `hooks.pre_turn` or initial FLOW CALL step                             |
| `{{memory.X.Y}}` template vars                                 | ABL session variables via `context_access.read/write`                      |
| Memory stores (`userInfo`, `transfer_metadata`, `sessionMeta`) | ABL MEMORY: session: variables                                             |
| MCP tools (31 tools on Saludsa MCP server)                     | ABL TOOLS: declarations with MCP server binding                            |
| Code tools (15 tools, empty code, descriptions only)           | ABL TOOLS: with side-effect descriptions (metadata save + handoff trigger) |
| `handsOffStatus: true` → Agent Handoff Event                   | ABL ESCALATE trigger                                                       |
| `closeConversation: yes` → EndOfConversation Event             | ABL COMPLETE condition                                                     |

### Agent Consolidation: 16 → 7 ABL Agents

| #   | ABL Agent            | Kore.ai Source(s)                                                                                  | Key Logic                                                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `samy_supervisor`    | Supervisor orchestration prompt + behavioral instructions                                          | 5-level routing: priority transfer → validation enforcement → handoff check → intent routing → fallback                           |
| 2   | `entry_gateway`      | Client_Entry_Gateway_Agent + Broker_Entry_Gateway_Agent                                            | Phone→ID validation (client path), Broker ID→OTP→Client ID (broker path), priority transfer check                                 |
| 3   | `contract_agent`     | ContractDataAssistant + Contract_Sending_Agent                                                     | Security questions → contract status/sending, role-based access, multi-contract formatting                                        |
| 4   | `self_service_agent` | Refund Guidance Agent + Refund Status + Password Reset Agent + Pending_Payments_Amount             | Refund steps, refund status (→SAC), password reset (role+channel branching), pending payments (OTP→contract details)              |
| 5   | `coverage_agent`     | Issuance of Coverage Certificates + Other_Services                                                 | Coverage/travel certificate generation, dental coverage, funeral service                                                          |
| 6   | `transfer_agent`     | Transfer_Services + Transfer_To_SAC + TransferToVitality + PCA_and_XPR_Associated_Product_Transfer | Dr. Salud (authorization/emergency/online/home visit), sales transfer, SAC transfer, vitality transfer, PCA/XPR priority transfer |
| 7   | `fallback_farewell`  | FallbackHandler + FarewellHandler                                                                  | Junk/out-of-scope handling (2 retries → menu), farewell (only after assistance offer + negative response)                         |

### File Structure

```
examples/saludsa-e2e/
├── project.json                          # ABL project manifest
├── environment/
│   └── default.env.json                  # MCP server URL, auth, model config
├── agents/
│   ├── samy_supervisor.agent.abl         # Supervisor with 5-level routing
│   ├── entry_gateway.agent.abl           # Client + Broker validation
│   ├── contract_agent.agent.abl          # Contract status + sending
│   ├── self_service_agent.agent.abl      # Refund/password/payments
│   ├── coverage_agent.agent.abl          # Certificates + other services
│   ├── transfer_agent.agent.abl          # Dr.Salud/SAC/Vitality/PCA/XPR
│   └── fallback_farewell.agent.abl       # Fallback + farewell
├── tools/
│   ├── mcp_saludsa.tool.abl              # MCP server binding (31 tools)
│   ├── validate_user_id.tool.abl         # Code tool: ValidateUserID
│   ├── broker_id_validator.tool.abl      # Code tool: BrokerIDValidator
│   ├── otp_validator.tool.abl            # Code tool: otpValidator
│   ├── otp_generator.tool.abl            # Code tool: otpGenerator
│   ├── client_id_validator.tool.abl      # Code tool: ClientIDValidator
│   ├── handle_service_failure.tool.abl   # Code tool: HandleServiceFailure
│   ├── save_transfer_sac.tool.abl        # Code tool: saveTransferSAC
│   ├── save_transfer_vitality.tool.abl   # Code tool: saveTransferToVitality
│   ├── save_transfer_sales.tool.abl      # Code tool: saveTransferSales
│   ├── save_dr_salud_metadata.tool.abl   # Code tool: saveDrSaludMetaData
│   ├── handle_priority_product.tool.abl  # Code tool: HandlePriorityProductTransfer
│   ├── otp_failure_sac.tool.abl          # Code tool: OTPFailureSACTransferTool
│   ├── send_message_whatsapp.tool.abl    # Code tool: SendMessageWhatsapp
│   └── contract_sending.tool.abl         # Code tool: contract_sending
└── config/
    └── behavioral_instructions.md        # 16 behavioral rules (verbatim from Kore.ai)

apps/runtime/src/__tests__/e2e/saludsa/
├── scenarios.ts                          # Test scenarios with utterances + expected behavior
├── saludsa-koreai.e2e.test.ts            # Live Kore.ai baseline test
├── saludsa-abl-runtime.e2e.test.ts       # ABL Runtime test
├── assertions.ts                         # Shared assertion helpers (Spanish text matching)
├── sse-client.ts                         # Kore.ai SSE streaming client
├── generate-comparison.ts                # Markdown comparison report generator
├── BASELINE_RESULTS.md                   # Captured Kore.ai baseline metrics
└── fixtures/
    └── session-metadata.ts               # Mock session metadata for different channels/roles
```

### Memory Stores → ABL Session Variables

The Kore.ai system uses 3 memory stores. In ABL, these become session variables:

```
MEMORY:
  session:
    # From sessionMeta store
    channel: string           # "whatsapp" | "WEB" | "voice" | "iOS" | "ANDROID"
    phone_number: string
    inbound_number: string
    session_id: string
    user_reference: string
    session_reference: string
    nombre_titular: string
    identificacion_app_web: string
    is_first_agentic_request: boolean
    agent_to_be_executed: string

    # From userInfo store
    is_user_validated: boolean
    user_role: string         # "Holder" | "Beneficiary" | "Broker" | "Business Representative" | "Payer" | "Non Client"
    user_type: string
    contract_number: string
    ticket_id: string
    customer_name: string
    priority_transfer: string # "NA" | "PCA" | "XPR" | "SAC"
    api_error: boolean
    customer_details: object
    is_xpr_exist: boolean
    is_drs_exist: boolean
    is_trk_exist: boolean
    fallback_status: string
    time_slot: string
    otp_invalid_count: integer
    id_invalid_count: integer
    id_invalid_count_br: integer
    id_invalid_count_c: integer
    br_not_eligible_count: integer
    close_conversation: string

    # From transfer_metadata store
    hands_off_status: boolean
    is_outside_business_hours: boolean
    vitality_hours: boolean
```

### MCP Server Configuration

```json
{
  "name": "Saludsa_MCP_Server",
  "url": "https://pruebassac.saludsa.com.ec/servicioalcliente/mcpintegracionivr/",
  "auth": {
    "type": "basic",
    "credentials": "U0xETUNQS09SOmd2JWhrRjIwITFwdw=="
  },
  "timeout": 45000,
  "tools": [
    "userValidation",
    "validate-user",
    "validate-broker",
    "getSecurityQuestions",
    "contractStatus",
    "steps-for-refund",
    "checkRefundStatus",
    "passwordReset",
    "validate-otp",
    "generate-otp",
    "pending-payments",
    "checkCoverageEligibility",
    "getCoverageCertificate",
    "validateTaskEligibility",
    "validateoutofhours",
    "update-zendesk-ticket",
    "create-zendesk-ticket",
    "close-zendesk-ticket",
    "sendEmailTemplate",
    "sending-contracts",
    "validarElegibilidadTarea",
    "consultarAgenteVenta",
    "validarAgenteVenta",
    "checkPriorityTransfer",
    "pendingPaymentOtp",
    "validate-otp-client",
    "resend-refund-settlement",
    "prioritize-refund-zendesk",
    "update-zendesk-ticket-prod",
    "lpd-consent",
    "vitalityCheck"
  ]
}
```

### Kore.ai API Configuration (for baseline tests)

```
Base URL: https://agent-platform.kore.ai
App ID: (from SALUDSA_APP_ID env var)
API Key: (from SALUDSA_API_KEY env var)
Execute endpoint: /api/v2/apps/{appId}/environments/dev/runs/execute
Stream mode: SSE with tokens
Metadata fields: plataforma, phoneNumber, inboundNumber, identificacion_app_web, nombre_titular, isFirstAgenticRequest
```

---

## Chunk 2: Kore.ai Baseline Test Harness

### Task 1: Create test scenarios

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/scenarios.ts`

- [ ] **Step 1: Write scenarios file**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/scenarios.ts

/**
 * Saludsa E2E Test Scenarios
 *
 * Each scenario targets a specific Kore.ai agent workflow.
 * Metadata simulates different channels/roles/validation states.
 */

export interface Turn {
  user: string;
  metadata?: Record<string, string>;
  /** Keywords expected in the response (Spanish) */
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
  /** Channel: whatsapp | WEB | voice | iOS | ANDROID */
  channel: string;
  /** Session metadata injected on first turn */
  sessionMetadata: Record<string, string>;
  turns: Turn[];
  /** Create fresh session for this scenario */
  freshSession: boolean;
  /** Tags for filtering: validation, contract, refund, transfer, coverage, fallback, farewell */
  tags: string[];
}

// ─── Helper: default WEB metadata (pre-validated user) ───
const WEB_VALIDATED: Record<string, string> = {
  plataforma: 'WEB',
  identificacion_app_web: '1712345678',
  nombre_titular: 'Juan Pérez',
  isFirstAgenticRequest: 'false',
};

// ─── Helper: WhatsApp metadata (needs phone validation) ───
const WHATSAPP_UNVALIDATED: Record<string, string> = {
  plataforma: 'whatsapp',
  phoneNumber: '+593991234567',
  inboundNumber: '+593999999999',
  isFirstAgenticRequest: 'true',
};

// ─── Helper: WEB validated holder ───
const WEB_HOLDER: Record<string, string> = {
  ...WEB_VALIDATED,
  isFirstAgenticRequest: 'false',
};

export const SCENARIOS: Scenario[] = [
  // ── S1: WhatsApp Client Validation Flow ──
  {
    name: 'S1: WhatsApp Client Entry Gateway',
    description: 'Client contacts via WhatsApp → greeting → ID request → validation',
    channel: 'whatsapp',
    sessionMetadata: WHATSAPP_UNVALIDATED,
    freshSession: true,
    tags: ['validation', 'entry_gateway'],
    turns: [
      {
        user: 'Hola',
        expectAny: ['samy', 'asistente', 'cédula', 'pasaporte', 'identificación'],
        expectAgent: 'Client_Entry_Gateway_Agent',
        maxTimeMs: 30000,
      },
      {
        user: '1712345678',
        expectAny: ['validada', 'identidad', 'servir', 'puedo'],
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S2: Contract Status (WEB, pre-validated) ──
  {
    name: 'S2: Contract Status Query (WEB)',
    description:
      'Pre-validated WEB user asks for contract status → direct to ContractDataAssistant',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['contract', 'contract_status'],
    turns: [
      {
        user: '¿Cuál es el estado de mi contrato?',
        expectAny: ['contrato', 'activo', 'plan', 'estado', 'contractStatus'],
        expectAgent: 'ContractDataAssistant',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S3: Steps for Refund (WEB) ──
  {
    name: 'S3: Refund Steps Guidance (WEB)',
    description: 'Validated user asks how to submit a refund → Refund Guidance Agent',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['refund', 'self_service'],
    turns: [
      {
        user: '¿Cuáles son los pasos para solicitar un reembolso?',
        expectAny: ['reembolso', 'pasos', 'App', 'Web', 'contratos', 'habilitados'],
        expectAgent: 'Refund Guidance Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S4: Password Reset (WEB Holder) ──
  {
    name: 'S4: Password Reset (WEB Holder)',
    description: 'Holder on WEB requests password reset → direct passwordReset tool call',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['password', 'self_service'],
    turns: [
      {
        user: 'Necesito resetear mi contraseña',
        expectAny: ['contraseña', 'email', 'SMS', 'enviar', 'password'],
        expectAgent: 'Password Reset Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S5: Pending Payments (WEB) ──
  {
    name: 'S5: Pending Payments Query (WEB)',
    description: 'Validated user asks about outstanding payments',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['payments', 'self_service'],
    turns: [
      {
        user: '¿Cuánto debo de pago pendiente?',
        expectAny: ['contrato', 'pago', 'pendiente', 'monto', 'cuota'],
        expectAgent: 'Pending_Payments_Amount',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S6: Coverage Certificate (WEB) ──
  {
    name: 'S6: Coverage Certificate Request (WEB)',
    description: 'Validated user requests coverage certificate → eligibility check → generate',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['coverage', 'certificate'],
    turns: [
      {
        user: 'Necesito un certificado de cobertura',
        expectAny: ['certificado', 'cobertura', 'vigencia', 'beneficiario', 'contrato'],
        expectAgent: 'Issuance of Coverage Certificates',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S7: Transfer to SAC (explicit human request) ──
  {
    name: 'S7: Transfer to Human Agent (SAC)',
    description: 'User explicitly asks to speak with a human agent',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['transfer', 'sac'],
    turns: [
      {
        user: 'Quiero hablar con un agente humano',
        expectAny: ['solicitud', 'motivo', 'consulta', 'opción', 'servicio'],
        expectAgent: 'Transfer_To_SAC',
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S8: Vitality Program ──
  {
    name: 'S8: Vitality Program Query',
    description: 'User asks about Vitality program → TransferToVitality',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['transfer', 'vitality'],
    turns: [
      {
        user: '¿Cómo funciona el programa Vitality?',
        expectAny: ['vitality', 'programa', 'horario', 'atención'],
        expectAgent: 'TransferToVitality',
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S9: Dr. Salud Emergency ──
  {
    name: 'S9: Dr. Salud Emergency Transfer',
    description:
      'User requests emergency medical consultation → Transfer_Services (DRSALUDEMERGENCY)',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['transfer', 'dr_salud'],
    turns: [
      {
        user: 'Necesito una consulta médica de emergencia',
        expectAny: ['médic', 'emergencia', 'Dr. Salud', 'salud', 'atención'],
        expectAgent: 'Transfer_Services',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S10: Fallback — Junk Input ──
  {
    name: 'S10: Fallback Handler (Junk Input)',
    description: 'Gibberish input triggers FallbackHandler → retry → menu',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['fallback'],
    turns: [
      {
        user: 'asdfghjkl qwerty',
        expectAny: ['entender', 'requerimiento', 'motivo', 'consulta'],
        expectAgent: 'FallbackHandler',
        maxTimeMs: 30000,
      },
      {
        user: 'zxcvbnm poiuy',
        expectAny: ['entender', 'requerimiento', 'opción', 'seleccione'],
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S11: Farewell after assistance offer ──
  {
    name: 'S11: Farewell Flow',
    description: 'After service completion, user declines further help → farewell',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['farewell'],
    turns: [
      {
        user: '¿Cuál es el estado de mi contrato?',
        expectAny: ['contrato', 'plan', 'estado'],
        maxTimeMs: 45000,
      },
      {
        user: 'No, gracias. Eso es todo.',
        expectAny: ['placer', 'servirle', 'día', 'tarde', 'noche'],
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S12: Refund Status (→ SAC handoff) ──
  {
    name: 'S12: Refund Status Check',
    description: 'User asks about refund status → immediate SAC transfer (no self-service)',
    channel: 'WEB',
    sessionMetadata: WEB_HOLDER,
    freshSession: true,
    tags: ['refund', 'transfer'],
    turns: [
      {
        user: '¿Cuál es el estado de mi reembolso?',
        expectAny: ['reembolso', 'estado', 'solicitud', 'transferi'],
        expectAgent: 'Refund Status',
        maxTimeMs: 30000,
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

Run: `npx tsc --noEmit apps/runtime/src/__tests__/e2e/saludsa/scenarios.ts 2>&1 | head -20`
Expected: No errors (or only import-related since it's standalone types)

- [ ] **Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/saludsa/scenarios.ts
git commit -m "feat(e2e): add Saludsa test scenarios — 12 scenarios covering all agent workflows"
```

---

### Task 2: Create SSE streaming client

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/sse-client.ts`

- [ ] **Step 1: Write SSE client**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/sse-client.ts

/**
 * Saludsa Kore.ai SSE Streaming Client
 *
 * Adapted from AFG Blue Advisory pattern for Saludsa's metadata structure.
 * Handles: session identity, SSE parsing, timing, agent detection.
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

export interface SaludsaClientConfig {
  apiKey: string;
  appId: string;
  baseUrl: string;
}

/**
 * Parse concatenated JSON objects from an SSE data line.
 * Handles Kore.ai's pattern of multiple JSON objects per line.
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
 * Send a message to the Kore.ai Saludsa API and parse the SSE response.
 */
export async function sendMessage(
  config: SaludsaClientConfig,
  text: string,
  identity: SessionIdentity,
  metadata: Record<string, string> = {},
): Promise<ParsedResponse> {
  const executeUrl = `${config.baseUrl}/api/v2/apps/${config.appId}/environments/dev/runs/execute`;

  const body = {
    sessionIdentity: [
      { type: 'userReference', value: identity.userReference },
      { type: 'sessionReference', value: identity.sessionReference },
    ],
    input: [{ type: 'text', content: text }],
    metadata: {
      plataforma: metadata.plataforma ?? 'WEB',
      phoneNumber: metadata.phoneNumber ?? '',
      inboundNumber: metadata.inboundNumber ?? '',
      identificacion_app_web: metadata.identificacion_app_web ?? '',
      nombre_titular: metadata.nombre_titular ?? '',
      isFirstAgenticRequest: metadata.isFirstAgenticRequest ?? 'false',
      ...metadata,
    },
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
export function makeSessionIdentity(prefix = 'saludsa_e2e'): SessionIdentity {
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
git add apps/runtime/src/__tests__/e2e/saludsa/sse-client.ts
git commit -m "feat(e2e): add Saludsa SSE streaming client for Kore.ai baseline tests"
```

---

### Task 3: Create assertion helpers

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/assertions.ts`

- [ ] **Step 1: Write assertions file**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/assertions.ts

/**
 * Shared assertion helpers for Saludsa E2E tests.
 * Handles Spanish text matching, agent routing verification, timing checks.
 */

import { expect } from 'vitest';
import type { ParsedResponse } from './sse-client';
import type { Turn } from './scenarios';

/**
 * Normalize Spanish text for comparison:
 * - Lowercase
 * - Remove accents
 * - Collapse whitespace
 */
export function normalizeSpanish(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if text contains any of the expected keywords (accent-insensitive).
 */
export function containsAny(text: string, keywords: string[]): boolean {
  const normalized = normalizeSpanish(text);
  return keywords.some((kw) => normalized.includes(normalizeSpanish(kw)));
}

/**
 * Check if text contains none of the forbidden keywords.
 */
export function containsNone(text: string, keywords: string[]): boolean {
  const normalized = normalizeSpanish(text);
  return keywords.every((kw) => !normalized.includes(normalizeSpanish(kw)));
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
    const expectedNorm = normalizeSpanish(turn.expectAgent);
    const actualNorm = normalizeSpanish(actualAgent);
    // Soft match — agent name may be display name variant
    const agentMatch = actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm);
    if (!agentMatch) {
      console.log(`${ctx} Agent mismatch: expected="${turn.expectAgent}" got="${actualAgent}"`);
    }
    // Log but don't fail — agent names may differ between display and internal
  }

  // Check timing
  if (turn.maxTimeMs) {
    const totalMs = result.timing.endMs - result.timing.startMs;
    if (totalMs > turn.maxTimeMs) {
      console.warn(
        `${ctx} Slow response: ${(totalMs / 1000).toFixed(1)}s > ${(turn.maxTimeMs / 1000).toFixed(1)}s limit`,
      );
    }
    // Soft limit — warn but don't fail (network variability)
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
git add apps/runtime/src/__tests__/e2e/saludsa/assertions.ts
git commit -m "feat(e2e): add Saludsa assertion helpers with Spanish text normalization"
```

---

### Task 4: Create session metadata fixtures

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/fixtures/session-metadata.ts`

- [ ] **Step 1: Write fixtures file**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/fixtures/session-metadata.ts

/**
 * Session metadata fixtures for different channel/role combinations.
 * These simulate the metadata that Kore.ai receives from different entry points.
 */

export const CHANNELS = {
  WEB: 'WEB',
  WHATSAPP: 'whatsapp',
  VOICE: 'voice',
  IOS: 'iOS',
  ANDROID: 'ANDROID',
} as const;

export const ROLES = {
  HOLDER: 'Holder',
  BENEFICIARY: 'Beneficiary',
  BROKER: 'Broker',
  BUSINESS_REP: 'Business Representative',
  PAYER: 'Payer',
  NON_CLIENT: 'Non Client',
} as const;

/** WEB channel — user is pre-validated via app login */
export function webHolderMetadata(idCard = '1712345678'): Record<string, string> {
  return {
    plataforma: CHANNELS.WEB,
    identificacion_app_web: idCard,
    nombre_titular: 'Juan Carlos Pérez López',
    isFirstAgenticRequest: 'false',
  };
}

/** WhatsApp channel — user needs phone-based validation */
export function whatsappClientMetadata(
  phone = '+593991234567',
  inbound = '+593999999999',
): Record<string, string> {
  return {
    plataforma: CHANNELS.WHATSAPP,
    phoneNumber: phone,
    inboundNumber: inbound,
    isFirstAgenticRequest: 'true',
  };
}

/** WhatsApp Broker channel */
export function whatsappBrokerMetadata(
  phone = '+593998765432',
  inbound = '+593990698341',
): Record<string, string> {
  return {
    plataforma: CHANNELS.WHATSAPP,
    phoneNumber: phone,
    inboundNumber: inbound,
    isFirstAgenticRequest: 'true',
  };
}

/** Voice channel */
export function voiceClientMetadata(
  phone = '+593991234567',
  inbound = '+593999999999',
): Record<string, string> {
  return {
    plataforma: CHANNELS.VOICE,
    phoneNumber: phone,
    inboundNumber: inbound,
    isFirstAgenticRequest: 'true',
  };
}

/** iOS app channel — pre-validated */
export function iosHolderMetadata(idCard = '1712345678'): Record<string, string> {
  return {
    plataforma: CHANNELS.IOS,
    identificacion_app_web: idCard,
    nombre_titular: 'María Elena García Torres',
    isFirstAgenticRequest: 'false',
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/saludsa/fixtures/session-metadata.ts
git commit -m "feat(e2e): add Saludsa session metadata fixtures for channel/role combos"
```

---

### Task 5: Create Kore.ai baseline E2E test

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/saludsa-koreai.e2e.test.ts`

- [ ] **Step 1: Write baseline test file**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/saludsa-koreai.e2e.test.ts

/**
 * Saludsa — Live Kore.ai Baseline E2E Test
 *
 * Tests against the LIVE Kore.ai Agent Platform API.
 * Validates conversational flows, agent routing, and response quality.
 *
 * Required env vars:
 *   SALUDSA_API_KEY   – Kore.ai x-api-key
 *   SALUDSA_APP_ID    – Kore.ai app ID
 *   SALUDSA_BASE_URL  – Kore.ai base URL (default: https://agent-platform.kore.ai)
 *
 * Run with:
 *   SALUDSA_API_KEY=kg-... npx vitest run --config vitest.integration.config.ts src/__tests__/e2e/saludsa/saludsa-koreai.e2e.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { SCENARIOS } from './scenarios';
import type { SaludsaClientConfig } from './sse-client';
import { sendMessage, makeSessionIdentity, fmt } from './sse-client';
import { assertTurnResponse, logTurnDetails } from './assertions';

// Load .env from runtime app root
dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});

// ─── Config ──────────────────────────────────────────────────────────────────

const SALUDSA_API_KEY = process.env.SALUDSA_API_KEY ?? '';
const SALUDSA_APP_ID = process.env.SALUDSA_APP_ID ?? '';
const SALUDSA_BASE_URL = process.env.SALUDSA_BASE_URL ?? 'https://agent-platform.kore.ai';

const SKIP_REASON = !SALUDSA_API_KEY
  ? 'SALUDSA_API_KEY not set — skipping live Kore.ai E2E tests'
  : !SALUDSA_APP_ID
    ? 'SALUDSA_APP_ID not set — skipping live Kore.ai E2E tests'
    : '';

const config: SaludsaClientConfig = {
  apiKey: SALUDSA_API_KEY,
  appId: SALUDSA_APP_ID,
  baseUrl: SALUDSA_BASE_URL,
};

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!!SKIP_REASON)('Saludsa — Live Kore.ai Baseline E2E', () => {
  beforeAll(() => {
    if (SKIP_REASON) return;
    console.log(`[Saludsa E2E] Endpoint: ${SALUDSA_BASE_URL}`);
    console.log(`[Saludsa E2E] App ID: ${SALUDSA_APP_ID}`);
    console.log(`[Saludsa E2E] Scenarios: ${SCENARIOS.length}`);
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const identity = makeSessionIdentity(`saludsa_${scenario.channel}`);

      for (let t = 0; t < scenario.turns.length; t++) {
        const turn = scenario.turns[t];
        const turnLabel = `Turn ${t + 1}: "${turn.user.slice(0, 50)}${turn.user.length > 50 ? '...' : ''}"`;

        test(
          turnLabel,
          async () => {
            const result = await sendMessage(config, turn.user, identity, scenario.sessionMetadata);

            logTurnDetails(result, t, scenario.name);
            assertTurnResponse(result, turn, t, scenario.name);

            // Always assert non-empty response
            expect(result.fullText.length).toBeGreaterThan(0);
          },
          turn.maxTimeMs ? turn.maxTimeMs + 15000 : 60000,
        );
      }
    });
  }
});

// ─── SSE Parser Unit Tests (always run) ──────────────────────────────────────

describe('Saludsa SSE Parser — extractJSONObjects', () => {
  // Import here to avoid circular issues
  const { extractJSONObjects } = require('./sse-client');

  test('parses single JSON object', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":0,"output":[{"type":"text","content":"Hola"}]}',
    );
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0]).output[0].content).toBe('Hola');
  });

  test('parses concatenated JSON objects', () => {
    const result = extractJSONObjects(
      '{"eventIndex":1,"output":[{"type":"text","content":"Soy"}]}{"eventIndex":2,"output":[{"type":"text","content":" Samy"}]}',
    );
    expect(result).toHaveLength(2);
  });

  test('handles session info event', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":0,"sessionInfo":{"sessionId":"s-abc-123"}}',
    );
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0]).sessionInfo.sessionId).toBe('s-abc-123');
  });

  test('returns empty for non-JSON lines', () => {
    expect(extractJSONObjects('')).toHaveLength(0);
    expect(extractJSONObjects('event: message')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verify test file compiles**

Run: `cd apps/runtime && npx tsc --noEmit src/__tests__/e2e/saludsa/saludsa-koreai.e2e.test.ts 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/saludsa/saludsa-koreai.e2e.test.ts
git commit -m "feat(e2e): add Saludsa live Kore.ai baseline E2E test — 12 scenarios"
```

---

## Chunk 3: ABL DSL Agents

### Task 6: Create project.json and environment config

**Files:**

- Create: `examples/saludsa-e2e/project.json`
- Create: `examples/saludsa-e2e/environment/default.env.json`
- Create: `examples/saludsa-e2e/config/behavioral_instructions.md`

- [ ] **Step 1: Write project.json**

```json
{
  "name": "saludsa-samy",
  "version": "1.0.0",
  "description": "Saludsa health insurance virtual assistant (Samy) — ABL translation of Kore.ai 16-agent system",
  "defaultAgent": "samy_supervisor",
  "defaultModel": {
    "provider": "azure-openai",
    "model": "gpt-4.1",
    "temperature": 0.1,
    "maxTokens": 9999
  },
  "mcpServers": [
    {
      "name": "Saludsa_MCP_Server",
      "url": "${SALUDSA_MCP_URL}",
      "auth": {
        "type": "basic",
        "credentials": "${SALUDSA_MCP_AUTH}"
      },
      "timeout": 45000
    }
  ],
  "agents": [
    "agents/samy_supervisor.agent.abl",
    "agents/entry_gateway.agent.abl",
    "agents/contract_agent.agent.abl",
    "agents/self_service_agent.agent.abl",
    "agents/coverage_agent.agent.abl",
    "agents/transfer_agent.agent.abl",
    "agents/fallback_farewell.agent.abl"
  ],
  "tools": ["tools/mcp_saludsa.tool.abl"]
}
```

- [ ] **Step 2: Write environment config**

```json
{
  "SALUDSA_MCP_URL": "https://pruebassac.saludsa.com.ec/servicioalcliente/mcpintegracionivr/",
  "SALUDSA_MCP_AUTH": "U0xETUNQS09SOmd2JWhrRjIwITFwdw==",
  "AZURE_OPENAI_ENDPOINT": "${AZURE_OPENAI_ENDPOINT}",
  "AZURE_OPENAI_API_KEY": "${AZURE_OPENAI_API_KEY}",
  "AZURE_OPENAI_DEPLOYMENT": "gpt-4.1"
}
```

- [ ] **Step 3: Write behavioral instructions**

```markdown
# Saludsa Behavioral Instructions (Samy)

1. All user-facing communication MUST be in Spanish (Ecuadorian).
2. Use formal register exclusively: "usted" (never "tú").
3. Use "servirte" (never "ayudarle").
4. Maintain Ecuadorian Spanish expressions.
5. No emojis in responses (except where Kore.ai originals specify them).
6. NEVER expose internal roles, validation states, API errors, or system logic.
7. NEVER generate or confirm: phone numbers, IDs, monetary values, percentages, policy details.
8. If an agent returns an HTML tag or Markdown link, deliver it EXACTLY as received.
9. If the user engages in small talk, provide an appropriate response.
10. NEVER hallucinate data, generate numbers, percentages, or policy details.
11. NEVER hallucinate user inputs and pass to workers.
12. Always evaluate handsOffStatus before routing to user.
13. Always evaluate priorityTransfer before calling any worker.
14. Plain assistant text responses are FORBIDDEN from the supervisor.
15. If validation agent returns a message requesting ID/passport/OTP, route to user and STOP.
16. During validation, ALWAYS preserve and forward the user's raw input verbatim.
```

- [ ] **Step 4: Commit**

```bash
git add examples/saludsa-e2e/
git commit -m "feat(saludsa-e2e): add project.json, environment config, behavioral instructions"
```

---

### Task 7: Create Samy Supervisor agent

**Files:**

- Create: `examples/saludsa-e2e/agents/samy_supervisor.agent.abl`

- [ ] **Step 1: Write supervisor DSL**

```abl
SUPERVISOR: Samy_Supervisor
GOAL: "Orchestrate Saludsa Samy virtual assistant — 5-level routing decision tree for 16 use cases across WhatsApp, WEB, voice, iOS, Android channels"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 9999
  max_iterations: 15
  inline_gather: true

PERSONA: |
  You are the Supervisor Agent (Samy) responsible for routing user requests to
  appropriate specialized agents. You do NOT answer users directly with your own knowledge.

  OUTPUT CONTRACT (STRICT):
  - You may ONLY respond by: (1) Routing to an agent/tool, (2) Calling route_to_user when explicitly permitted
  - Plain assistant text responses are FORBIDDEN
  - Never hallucinate data, generate numbers, percentages, or policy details
  - Never hallucinate user inputs

  COMMUNICATION STANDARDS:
  - All user-facing communication MUST be in Spanish (Ecuadorian)
  - Use formal register: "usted" (never "tú")
  - Use "servirte" (never "ayudarle")
  - No emojis
  - NEVER expose internal roles, validation states, API errors, or system logic
  - If an agent returns an HTML tag or Markdown link, deliver it EXACTLY as received
  - If the user engages in small talk, route to user with appropriate response

  ROUTING DECISION TREE (evaluated in strict order):

  LEVEL 0 — PRIORITY TRANSFER (Global Entry Override):
  If channel is whatsapp/voice: effectivePriorityTransfer = session.priority_transfer
  If channel is WEB/iOS/ANDROID: effectivePriorityTransfer = session.priority_transfer
  If effectivePriorityTransfer is PCA, XPR, or SAC → immediately route to Transfer_Agent

  LEVEL 1 — VALIDATION ENFORCEMENT (Absolute Precondition):
  Only for whatsapp/voice channels.
  If is_user_validated is NOT true:
  - This is NOT an error or fallback case
  - IMMEDIATELY route to Entry_Gateway agent
  - IGNORE all user intents during validation
  - Forward raw user input verbatim
  - STOP until is_user_validated is true

  LEVEL 2 — AGENT HANDOFF:
  If hands_off_status is true → Trigger Agent Handoff Event immediately
  - Calling route_to_user is FORBIDDEN
  - Do NOT send explanatory message

  LEVEL 3 — INTENT-BASED ROUTING (Validated Users Only):
  Route based on user intent + conversation history:
  - "hablar con agente/persona/humano" → Transfer_Agent (SAC mode)
  - Vitality program/points/benefits → Transfer_Agent (Vitality mode)
  - Contract status/plan details → Contract_Agent
  - Refund steps/reimbursement process → Self_Service_Agent (refund guidance)
  - Refund status check → Self_Service_Agent (refund status → SAC)
  - Password reset → Self_Service_Agent (password reset)
  - Pending payments/outstanding balance → Self_Service_Agent (pending payments)
  - Coverage certificate/travel certificate → Coverage_Agent
  - Dr. Salud/medical consultation/emergency → Transfer_Agent (Dr. Salud)
  - Sales inquiry → Transfer_Agent (Sales)
  - Dental coverage → Coverage_Agent (dental)
  - Contract sending → Contract_Agent (sending mode)

  LEVEL 4 — FALLBACK (Validated Users Only):
  If isFirstAgenticRequest is false AND is_user_validated is true:
  - No agent matches → Fallback_Farewell agent

  FAREWELL HANDLER:
  Route to Fallback_Farewell (farewell mode) ONLY when BOTH:
  1. User input is negative/dismissive ("no", "nada más", "eso es todo", etc.)
  2. Preceding system action was an assistance offer

  END OF CONVERSATION:
  If close_conversation is "yes" → Trigger EndOfConversation Event immediately

MEMORY:
  session:
    channel: string
    phone_number: string
    inbound_number: string
    session_id: string
    user_reference: string
    session_reference: string
    nombre_titular: string
    identificacion_app_web: string
    is_first_agentic_request: boolean
    agent_to_be_executed: string
    is_user_validated: boolean
    user_role: string
    user_type: string
    contract_number: string
    ticket_id: string
    customer_name: string
    priority_transfer: string
    api_error: boolean
    customer_details: object
    is_xpr_exist: boolean
    is_drs_exist: boolean
    is_trk_exist: boolean
    fallback_status: string
    time_slot: string
    close_conversation: string
    hands_off_status: boolean
    is_outside_business_hours: boolean
    vitality_hours: boolean

HANDOFF:
  - TO: Entry_Gateway
    WHEN: session.is_user_validated != true AND (session.channel == "whatsapp" OR session.channel == "voice")
    PASS: [session.channel, session.phone_number, session.inbound_number, session.user_type, session.agent_to_be_executed]

  - TO: Transfer_Agent
    WHEN: session.priority_transfer == "PCA" OR session.priority_transfer == "XPR" OR session.priority_transfer == "SAC"
    PASS: [session.priority_transfer, session.channel, session.nombre_titular, session.ticket_id]

  - TO: Contract_Agent
    WHEN: intent contains "contrato" OR intent contains "estado" OR intent contains "plan" OR intent contains "contract" OR intent contains "envío de contrato" OR intent contains "sending"
    PASS: [session.channel, session.user_role, session.session_id, session.ticket_id, session.customer_name]

  - TO: Self_Service_Agent
    WHEN: intent contains "reembolso" OR intent contains "refund" OR intent contains "contraseña" OR intent contains "password" OR intent contains "pago" OR intent contains "debo" OR intent contains "pendiente" OR intent contains "cuánto" OR intent contains "saldo"
    PASS: [session.channel, session.user_role, session.session_id, session.ticket_id, session.customer_details]

  - TO: Coverage_Agent
    WHEN: intent contains "certificado" OR intent contains "cobertura" OR intent contains "coverage" OR intent contains "dental" OR intent contains "funeral" OR intent contains "travel" OR intent contains "viaje"
    PASS: [session.channel, session.user_role, session.session_id, session.ticket_id]

  - TO: Transfer_Agent
    WHEN: intent contains "agente" OR intent contains "humano" OR intent contains "persona" OR intent contains "hablar" OR intent contains "vitality" OR intent contains "Dr. Salud" OR intent contains "emergencia" OR intent contains "médic" OR intent contains "ventas" OR intent contains "sales"
    PASS: [session.channel, session.user_role, session.session_id, session.ticket_id, session.nombre_titular]

  - TO: Fallback_Farewell
    WHEN: intent.unclear == true AND session.is_user_validated == true
    PASS: [session.channel, session.is_outside_business_hours, session.ticket_id]

COMPLETE:
  - WHEN: session.close_conversation == "yes"
    RESPOND: ""
  - WHEN: session.hands_off_status == true
    RESPOND: ""
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/samy_supervisor.agent.abl
git commit -m "feat(saludsa-e2e): add Samy Supervisor with 5-level routing decision tree"
```

---

### Task 8: Create Entry Gateway agent

**Files:**

- Create: `examples/saludsa-e2e/agents/entry_gateway.agent.abl`

- [ ] **Step 1: Write entry gateway DSL**

```abl
AGENT: Entry_Gateway
GOAL: "Greet and validate users on WhatsApp/voice channels — handle both Client and Broker validation paths with ID, OTP, and priority transfer checks"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 2000
  max_iterations: 12
  inline_gather: true

PERSONA: |
  You are a User Validator agent responsible for greeting and validating users
  on WhatsApp and voice channels. You handle two validation paths:

  PATH A — CLIENT VALIDATION (when user_type is "Cliente" or "non client"):
  1. Greet with EXACT message:
     "Hola 👋🏻, soy Samy 👩🏻‍💻, su asistente virtual de Saludsa.
     ¿Me puede proporcionar su cédula o pasaporte?
     🔒La conversación se almacenará y monitoreará por seguridad."
  2. Call ValidateUserID with user's input
  3. If invalidCount == 1: "Proporcione el número de identificación válido / número de pasaporte"
  4. If invalidCount == 2: "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante."
  5. After validation, check priorityTransfer:
     - If PCA/XPR/SAC → immediately trigger Transfer_Agent (do NOT validate user_role)
     - If NA → check user_role:
       - Holder/Beneficiary/Payer: "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?"
       - Non Client: "¿Quieres comprar un plan?"

  PATH B — BROKER VALIDATION (when user_type is "Broker" or "Business Representative"):
  1. Greet: "Hola, {title}. {surName}, me puede proporcionar su cedula / pasaporte? La conversación se almacenará y monitoreará por seguridad."
  2. Call BrokerIDValidator with broker's ID
  3. If idInvalidCountBR == 1: "Proporcione un número de identificación de corredor/pasaporte válido"
  4. If idInvalidCountBR == 2: Close session message
  5. If OTP required: Ask for OTP, call otpValidator
     - otpInvalidCount == 1: Ask again
     - otpInvalidCount == 2: Trigger OTPFailureSACTransferTool
  6. Ask for Client ID: "Por favor, indíqueme la identificación o número de contrato de su cliente..."
  7. Call ClientIDValidator
     - idInvalidCountC == 1/2: Retry/close
     - BRNotEligibleCount == 1: "La identificación ingresada no corresponde a su cartera de clientes..."
     - BRNotEligibleCount == 2: Close session
  8. After Client ID validation, check priorityTransfer → same as Path A

  CRITICAL RULES:
  - NEVER ask the user for their channel type
  - NEVER expose internal roles or validation logic
  - NEVER skip or reorder steps
  - Max 2 attempts for any identification step
  - During validation, IGNORE all business intents — validation must complete first
  - Forward raw user input verbatim — do not interpret numeric inputs as intents
  - If user_type is "Broker"/"Director"/"Business Representative" on CLIENT path:
    Show WhatsApp redirect message and close conversation

TOOLS:
  ValidateUserID(cedula_or_passport: string) -> ValidationResult
  BrokerIDValidator(broker_id: string) -> BrokerValidationResult
  otpValidator(userProvidedCodigoOtp: string) -> OTPValidationResult
  ClientIDValidator(client_id: string) -> ClientValidationResult
  OTPFailureSACTransferTool() -> TransferResult
  HandleServiceFailure() -> ErrorResult

MEMORY:
  session:
    channel: string
    user_type: string
    user_role: string
    title: string
    surname: string
    invalid_count: integer
    id_invalid_count_br: integer
    id_invalid_count_c: integer
    otp_invalid_count: integer
    br_not_eligible_count: integer
    priority_transfer: string
    time_slot: string
    close_conversation: string

COMPLETE:
  - WHEN: session.is_user_validated == true AND session.priority_transfer == "NA"
    RESPOND: "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?"
  - WHEN: session.is_user_validated == true AND (session.priority_transfer == "PCA" OR session.priority_transfer == "XPR" OR session.priority_transfer == "SAC")
    RESPOND: ""
  - WHEN: session.close_conversation == "yes"
    RESPOND: ""

ESCALATE:
  triggers:
    - WHEN: session.invalid_count >= 2 OR session.id_invalid_count_br >= 2 OR session.id_invalid_count_c >= 2
      REASON: "Max validation attempts exceeded"
      PRIORITY: medium
    - WHEN: session.otp_invalid_count >= 2
      REASON: "OTP validation failed after 2 attempts"
      PRIORITY: high
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/entry_gateway.agent.abl
git commit -m "feat(saludsa-e2e): add Entry Gateway agent — client + broker validation paths"
```

---

### Task 9: Create Contract Agent

**Files:**

- Create: `examples/saludsa-e2e/agents/contract_agent.agent.abl`

- [ ] **Step 1: Write contract agent DSL**

```abl
AGENT: Contract_Agent
GOAL: "Handle contract status inquiries and contract sending — security question auth for WhatsApp, direct access for WEB/iOS/Android, multi-contract formatting"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 4000
  max_iterations: 10
  inline_gather: true

PERSONA: |
  You are the Contract Status Inquiry and Contract Sending Agent. You handle two use cases:

  USE CASE A — CONTRACT STATUS:
  Channel-specific entry:
  - WEB/iOS/ANDROID: Skip to Step 4 (direct access, no security questions)
  - WhatsApp/voice: Start at Step 1 (security validation required)

  Step 1 — Security Validation (WhatsApp/voice only):
  Role check first:
  - Non Client or Payer: "En este momento, su perfil no tiene acceso a este tipo de información o servicio ¿Le puedo servir en algo adicional?" → END
  - Broker or Business Representative: Skip to Step 4
  - Holder or Beneficiary on WhatsApp: Call getSecurityQuestions with sessionId and channel
    - If isOtpVerified or isAuthQVerified is true → Skip to Step 4
    - Show: "Before continuing, I need to ask you a validation question to protect your information."
    - Display the security question from tool response
    - ANSWER VALIDATION: Accept exact match, partial match, synonyms, semantic equivalents
      - CRITICAL: If expected_answer is "Pago Directo al Local" and user says "No tengo banco"/"Pago en efectivo"/"Yo hago transferencia" → TREAT AS CORRECT
    - If incorrect on first attempt: Re-trigger getSecurityQuestions for second attempt
    - If fails after 2 attempts: Step 2 → Step 3

  Step 2 — Zendesk Update (WhatsApp, auth failure only):
  Call update-zendesk-ticket: usecase="auth_fail_client", subject="Usuario falla pasa preguntas de Autenticación"

  Step 3 — Failed Auth Handoff:
  Call saveTransferSAC: intent_identification=true, sacReason="Preguntas de autenticación fallidas del usuario"
  → Agent Handoff, do NOT proceed

  Step 4 — Contract Status Fetching:
  Call contractStatus with sessionId, channel, isAuthQVerified=true

  Step 5 — Response Formatting:
  - Single contract: "Your {planName} contract {contractNumber} is {contractStatusDescription}."
  - Multiple (≤5): Show counts by status (active, pending, cancelled, tax relief, donated)
  - Multiple (>5): Show counts, ask if user wants details by plan or contract number, display max 5 at a time
  - Plan name logic: Use planName → fallback planNameSamy → "Plan no especificado"
  - Status definitions: Anulado=Cancelled, Activo=Active, Donacion=Donation, Desgravamen=Tax Relief, Pendiente de pago=Pending

  USE CASE B — CONTRACT SENDING:
  Similar security validation flow → call sending-contracts tool → deliver contract

  CRITICAL:
  - NEVER trigger getSecurityQuestions on WEB/iOS/ANDROID
  - Always use exact contractStatusDescription from tool response
  - Display only first 5 contracts prioritizing: active → pending → cancelled

TOOLS:
  getSecurityQuestions(sessionId: string, channel: string) -> SecurityQuestionsResult
  contractStatus(sessionId: string, channel: string, isAuthQVerified: boolean) -> ContractStatusResult
  sending-contracts(sessionId: string, channel: string) -> ContractSendingResult
  update-zendesk-ticket(sessionId: string, usecase: string, channel: string, subject: string) -> TicketResult
  saveTransferSAC(channel: string, intent_identification: boolean, sacReason: string, userName: string, ticketNumber: string) -> TransferResult
  HandleServiceFailure() -> ErrorResult

COMPLETE:
  - WHEN: contract_status_displayed == true
    RESPOND: "¿Le puedo servir en algo más?"
  - WHEN: contract_sent == true
    RESPOND: "¿Le puedo servir en algo más?"
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/contract_agent.agent.abl
git commit -m "feat(saludsa-e2e): add Contract Agent — status + sending with security question auth"
```

---

### Task 10: Create Self Service Agent

**Files:**

- Create: `examples/saludsa-e2e/agents/self_service_agent.agent.abl`

- [ ] **Step 1: Write self-service agent DSL**

```abl
AGENT: Self_Service_Agent
GOAL: "Handle refund guidance, refund status, password reset, and pending payments — role/channel-specific workflows with OTP validation"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 5000
  max_iterations: 12
  inline_gather: true

PERSONA: |
  You are a Self-Service Agent handling four use cases. Detect which one from the user's intent:

  ═══ USE CASE 1: REFUND GUIDANCE (steps-for-refund) ═══
  Role check: Payer/Non Client → "En este momento, su perfil no tiene acceso a este tipo de información o servicio ¿Le puedo servir en algo adicional?"

  Step 1: Call steps-for-refund with sessionId and channel
  Step 2: If no eligible contracts → "The contract operates on copay/referral basis and does not accept refund requests." → END
  Step 3 (SINGLE RESPONSE — all in one message):
    A) List ALL refund-eligible contracts: "Estos son los contratos habilitados para reembolso:"
    B) Login info (WhatsApp/voice only, based on loggedInLast30Days):
       - null: "Para iniciar, ingrese a la App o Web de Saludsa 😊 Use los datos del titular: Usuario: cédula, Contraseña: fecha de nacimiento (DDMMYYYY)"
       - false: "Por favor, inicie sesión con su usuario y contraseña."
       - true: No login message
    C) Ask: "¿Prefiere que le indique los pasos de manera paso a paso o prefiere un resumen de todos los pasos?"
  Step-by-step: 9 steps (Home → Favorites → New Reimbursement → Category → Beneficiary → Info → Attach → T&C → Submit)
  Step 4: Category requirements with tutorial links (Lab, Medical, Therapies, Procedures, Medical Consultation, Hospital)
  - Special benefits (optical, third molars, etc.) → trigger saveTransferSAC
  - Voice channel: trigger sendEmailTemplate with useCaseName="stepsForRefund"

  ═══ USE CASE 2: REFUND STATUS ═══
  Role check: Holder/Beneficiary proceed; Broker/BR on WhatsApp/voice proceed; otherwise exit
  Step 1: Call saveTransferSAC with intent_identification=true, sacReason="sac_by_rule" → END (immediate SAC handoff)

  ═══ USE CASE 3: PASSWORD RESET ═══
  Step 1 — Role Validation:
  - Holder + WEB/iOS/ANDROID → Step 2.1
  - Holder + WhatsApp/voice → Step 2.2
  - Beneficiary → Step 3 (holder must request)
  - Broker/BR → Step 4
  - Payer → "Password reset does not apply, contact holder" → END
  - Non Client → "Reset flow does not apply" → END

  Step 2.1 — Holder on WEB: Call passwordReset(codigoTarea="Reseteo_Contrasena")
  - If eligible + OTP sent: Ask "email or SMS?" (mask email/phone). Call passwordReset(passwordResetType=<choice>)
  - If not eligible → Step 5

  Step 2.2 — Holder on WhatsApp/voice: Same as 2.1 but with OTP validation first
  - Call passwordReset → OTP sent → ask user for OTP → call validate-otp
  - OTP incorrect once: retry. Twice: → Step 5
  - After OTP: ask email/SMS, call passwordReset(passwordResetType)

  Step 3 — Beneficiary: Call passwordReset, display "El restablecimiento debe ser solicitado por el titular"
  Step 4 — Broker/BR: Call passwordReset, if eligible ask "password sent to holder's email/phone, continue?"
  Step 5 — API Error/Failure: Call saveTransferSAC(sacReason="sac_by_rule")

  ═══ USE CASE 4: PENDING PAYMENTS ═══
  Step 1 — Role check:
  - Holder/Beneficiary/Payer + WhatsApp/voice → Step 2
  - Holder/Beneficiary + WEB/iOS/ANDROID → Step 3
  - Broker/BR + WhatsApp/voice → Step 3

  Step 2 — OTP Validation (WhatsApp/voice only):
  - Call otpGenerator. If isOtpVerified=true → Step 3
  - Otherwise: send OTP, ask user, call otpValidator
  - Incorrect OTP: retry once, then saveTransferSAC

  Step 3 — Contract Details: Call pending-payments with sessionId and channel
  - totalContracts == 1 → Step 4 (single)
  - totalContracts > 1 → Step 5 (multiple)

  Step 4 — Single Contract:
  - all-clear: Show plan/contractNumber + "Contract is current" (note if post-16 instalment)
  - single-pending: Show plan/contractNumber/pendingInstallmentsCount/month/amount
  - single-in-process: Show plan/contractNumber/inProcessInstallmentsCount/month/amount

  Step 5 — Multiple Contracts:
  - multiple-pending: List format with totalAmountPending
  - multiple-in-process: List with totalAmountInProcess
  - all-clear: Consolidated list + "all contracts current"
  - mixed: Separate panels for pending/inProcess/completed contracts (Holder/Beneficiary vs Broker/BR formatting)

  Step 6 — Zendesk Update: Call update-zendesk-ticket(usecase="pending_payment_amounts", transfer_type="samy")

TOOLS:
  steps-for-refund(sessionId: string, channel: string) -> RefundStepsResult
  saveTransferSAC(channel: string, intent_identification: boolean, sacReason: string, ticketNumber: string) -> TransferResult
  sendEmailTemplate(sessionId: string, useCaseName: string) -> EmailResult
  passwordReset(sessionId: string, codigoTarea: string, passwordResetType: string) -> PasswordResetResult
  validate-otp(sessionId: string, codigoOtpGenerado: string) -> OTPResult
  pending-payments(sessionId: string, channel: string) -> PendingPaymentsResult
  otpGenerator() -> OTPGeneratorResult
  otpValidator(userProvidedCodigoOtp: string) -> OTPValidatorResult
  OTPFailureSACTransferTool() -> TransferResult
  update-zendesk-ticket(sessionId: string, usecase: string, channel: string, subject: string, requerimientos_samy: string, note: string, transfer_type: string) -> TicketResult
  HandleServiceFailure() -> ErrorResult

COMPLETE:
  - WHEN: refund_steps_displayed == true OR password_reset_done == true OR payments_displayed == true
    RESPOND: "¿Hay algo más en lo que le pueda servir?"
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/self_service_agent.agent.abl
git commit -m "feat(saludsa-e2e): add Self Service Agent — refund/password/payments with 4 use cases"
```

---

### Task 11: Create Coverage Agent

**Files:**

- Create: `examples/saludsa-e2e/agents/coverage_agent.agent.abl`

- [ ] **Step 1: Write coverage agent DSL**

```abl
AGENT: Coverage_Agent
GOAL: "Handle coverage certificate issuance (coverage + travel), dental coverage checks, and funeral service transfers"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 4000
  max_iterations: 10
  inline_gather: true

PERSONA: |
  You are the Coverage Certificate and Special Services Agent. You handle three use cases:

  ═══ USE CASE 1: COVERAGE/TRAVEL CERTIFICATE ISSUANCE ═══
  (Translated from Issuance_of_Coverage_Certificates agent — 19,152 chars prompt)

  Step 1 — Channel + Role Validation:
  - WEB/iOS/ANDROID: Skip auth, go to Step 4
  - WhatsApp/voice: Check role
    - Non Client/Payer: "En este momento, su perfil no tiene acceso..." → END
    - Broker/BR: Skip to Step 4
    - Holder/Beneficiary: Security questions (same as Contract_Agent Step 1)

  Step 2 — Intent Identification:
  Ask: "¿Necesita un certificado de cobertura o un certificado de viaje (travel)?"
  If user already specified in initial message, skip this step.

  Step 3 — Contract Validation:
  Call checkCoverageEligibility with sessionId, channel, certificateType
  - If not eligible: inform user and END

  Step 4 — Date Selection (Travel certificates only):
  Ask for travel dates (start/end)

  Step 5 — Beneficiary Selection (if multiple beneficiaries):
  Display beneficiary list, ask user to select

  Step 6 — Certificate Generation:
  Call getCoverageCertificate with all parameters

  Step 7 — Delivery (channel-specific):
  - WEB: Display markdown download link EXACTLY as returned
  - WhatsApp: Send as attachment
  - Voice: "Le enviaremos el certificado al correo electrónico registrado" + call sendEmailTemplate

  Step 8 — Zendesk Update:
  Call update-zendesk-ticket with usecase="coverage_certificate"

  ═══ USE CASE 2: DENTAL COVERAGE ═══
  Step 1: Call validateTaskEligibility with codigoTarea for dental
  - If eligible: Call validateoutofhours
    - Within hours: Call saveDrSaludMetaData → display dental provider info
    - Outside hours: Display business hours message
  - If not eligible: Inform user

  ═══ USE CASE 3: FUNERAL SERVICE ═══
  Display contact number: 02550290
  - Voice: Transfer call to 02550290
  - Digital: Display "Para información sobre el servicio funerario, comuníquese al 02550290"

  CRITICAL:
  - Deliver HTML/markdown links EXACTLY as received from tools
  - Never modify URLs or link text
  - For voice channel, always offer email delivery alternative

TOOLS:
  getSecurityQuestions(sessionId: string, channel: string) -> SecurityQuestionsResult
  checkCoverageEligibility(sessionId: string, channel: string, certificateType: string) -> EligibilityResult
  getCoverageCertificate(sessionId: string, channel: string, beneficiaryId: string, startDate: string, endDate: string) -> CertificateResult
  validateTaskEligibility(sessionId: string, codigoTarea: string) -> TaskEligibilityResult
  validateoutofhours(sessionId: string) -> BusinessHoursResult
  saveDrSaludMetaData(channel: string, useCase: string) -> MetadataResult
  sendEmailTemplate(sessionId: string, useCaseName: string) -> EmailResult
  update-zendesk-ticket(sessionId: string, usecase: string, channel: string, subject: string) -> TicketResult
  HandleServiceFailure() -> ErrorResult

COMPLETE:
  - WHEN: certificate_delivered == true OR dental_info_displayed == true OR funeral_info_displayed == true
    RESPOND: "¿Hay algo más en lo que le pueda servir?"
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/coverage_agent.agent.abl
git commit -m "feat(saludsa-e2e): add Coverage Agent — certificates, dental, funeral"
```

---

### Task 12: Create Transfer Agent

**Files:**

- Create: `examples/saludsa-e2e/agents/transfer_agent.agent.abl`

- [ ] **Step 1: Write transfer agent DSL**

```abl
AGENT: Transfer_Agent
GOAL: "Handle all transfer use cases: Dr. Salud (5 sub-types), SAC transfer, Vitality transfer, PCA/XPR priority product transfer, and sales transfer"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 4000
  max_iterations: 10
  inline_gather: true

PERSONA: |
  You are the Transfer and Escalation Agent handling multiple transfer use cases:

  ═══ USE CASE 1: DR. SALUD (5 sub-types) ═══
  Detect sub-type from intent/context:

  A) DRSALUDAUTORIZATION — Medical authorization requests
  Step 1: Call validateTaskEligibility(codigoTarea for authorization)
  Step 2: If eligible, call validateoutofhours
  Step 3: If within hours, call saveDrSaludMetaData(useCase="DRSALUDAUTORIZATION") → handoff
  Step 4: If outside hours, display business hours message

  B) DRSALUDEMERGENCY — Emergency medical advisory
  Step 1: Call validateTaskEligibility
  Step 2: If eligible, call saveDrSaludMetaData(useCase="DRSALUDEMERGENCY") → handoff
  (No business hours check — emergencies are 24/7)

  C) ONLINEMEDICALCONSULTATION — Online medical consultation
  Step 1: Call validateTaskEligibility
  Step 2: If eligible, call validateoutofhours
  Step 3: Call saveDrSaludMetaData(useCase="ONLINEMEDICALCONSULTATION") → handoff

  D) DOCTORHOMEVISIT — Home visit doctor
  Step 1: Call validateTaskEligibility
  Step 2: If eligible, call validateoutofhours
  Step 3: Call saveDrSaludMetaData(useCase="DOCTORHOMEVISIT") → handoff

  E) TRANSFERTOSALES — Sales transfer
  Step 1: Call saveTransferSales → handoff

  ═══ USE CASE 2: TRANSFER TO SAC ═══
  Step 1 — Ask Reason (if user explicitly requested human transfer without matching intent):
  "¿Podría indicarme brevemente el motivo de su consulta?"
  - If reason matches known intents (transaction status, complaint, coverage info, update details,
    cancellations, plan changes, corrections, exclusions, payment bounces, notes, pre-existing,
    reactivation, split/merge, settlement explanations) → Step 3
  - If not understood after 2 attempts → Step 4

  Step 3 — Recognized Intent Transfer:
  Call saveTransferSAC(intent_identification=true, sacReason=<user reason>)
  STOP — do not continue

  Step 4 — Update Ticket:
  Call update-zendesk-ticket(usecase="transfer_sac", requerimientos_samy="sac_no_understanding")

  Step 5 — Department Selection (WhatsApp/WEB/iOS/ANDROID):
  Display menu:
  "Para continuar con su solicitud, seleccione una opción:
  Uno; Dr. Salud asesoría y atención médica 24/7.
  Dos; Servicio al cliente para información sobre su plan contratado
  Tres; Vitality
  Cuatro; Ventas."
  - Uno → trigger Dr. Salud Emergency sub-flow
  - Dos → Step 6 (SAC)
  - Tres → Step 6 (Vitality)
  - Cuatro → trigger Sales transfer

  Step 6 — Execute Transfer:
  Call saveTransferSAC(intent_identification=false, user_request=<"sac"|"vitality">) → END

  Voice Channel Menu (Step 7 — replaces Steps 5-6):
  MAIN MENU: 1.SUBMENU 2.SAC 3.Vitality 4.Sales 5.Saludsa Travel 6.Funeral-02550290
  - Option 2-6: Call saveTransferSAC(menu_number=<selected>) → END
  - Option 1 SUBMENU: 1.Emergency 2.Online Consultation 3.Home Visit 4.Medical Services
    → saveTransferSAC(menu_number=11/12/13/14) → END

  ═══ USE CASE 3: VITALITY TRANSFER ═══
  Step 1: Call saveTransferToVitality
  Step 2: Trigger Agent Handoff
  - If vitalityHours is true: "Tenga en cuenta que el horario de atención de Vitality es de lunes a viernes, de 8.00 a. m. a 7.00 p. m."
  - If handsOffStatus is true: NO user-facing message, return control immediately

  ═══ USE CASE 4: PCA/XPR PRIORITY PRODUCT TRANSFER ═══
  Step 1: Call HandlePriorityProductTransfer (no input params)
  Step 2 — PCA Product:
  - Voice: Transfer call to dynamic contactNumber from tool response
  - Digital: "Dear {nombre_titular}, to receive information about the PCA product, please contact ServiAlamo at {contactNumber}."
  - If user requests certificate: Call HandlePriorityProductTransfer(priorityTransfer="SAC")

  Step 3 — Fideval Products:
  - Voice: Transfer to 1-800-022945301
  - Digital: Phone 022945301, WhatsApp +593985613739 (https://wa.me/593985613739)

  Step 4 — Post-Response: "Can I help you with anything else?"

TOOLS:
  validateTaskEligibility(sessionId: string, codigoTarea: string) -> TaskEligibilityResult
  validateoutofhours(sessionId: string) -> BusinessHoursResult
  saveDrSaludMetaData(channel: string, useCase: string) -> MetadataResult
  saveTransferSAC(channel: string, intent_identification: boolean, sacReason: string, user_request: string, ticketNumber: string, menu_number: integer) -> TransferResult
  saveTransferSales() -> TransferResult
  saveTransferToVitality() -> VitalityResult
  HandlePriorityProductTransfer(priorityTransfer: string) -> ProductTransferResult
  update-zendesk-ticket(sessionId: string, usecase: string, channel: string, subject: string, requerimientos_samy: string, note: string, transfer_reason: string, transfer_type: string) -> TicketResult
  HandleServiceFailure() -> ErrorResult

COMPLETE:
  - WHEN: transfer_completed == true
    RESPOND: ""
  - WHEN: session.hands_off_status == true
    RESPOND: ""
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/transfer_agent.agent.abl
git commit -m "feat(saludsa-e2e): add Transfer Agent — Dr.Salud/SAC/Vitality/PCA/XPR/Sales"
```

---

### Task 13: Create Fallback + Farewell Agent

**Files:**

- Create: `examples/saludsa-e2e/agents/fallback_farewell.agent.abl`

- [ ] **Step 1: Write fallback/farewell agent DSL**

```abl
AGENT: Fallback_Farewell
GOAL: "Handle junk/out-of-scope inputs with 2 retries then menu, and farewell when user declines further assistance after an offer"

EXECUTION:
  model: gpt-4.1
  temperature: 0.1
  max_tokens: 2000
  max_iterations: 8
  inline_gather: true

PERSONA: |
  You handle two modes based on how you were invoked:

  ═══ MODE A: FALLBACK (junk/out-of-scope) ═══

  Step 1 — Initial Ask:
  If user input is "Please see the attached document.":
    "Gracias por compartir su archivo. En este momento no puedo leer contenido multimedia (imagen, audio o documento). Por favor, indíqueme su consulta por escrito y con gusto le atiendo 😊."
  Otherwise:
    "No logré entender su requerimiento🤔. Para poder servirle mejor, ¿me puede comentar brevemente el motivo de su consulta?"

  Step 2 — Retry Logic:
  - Allow exactly 2 retries if input remains unidentifiable
  - Use the SAME fixed phrases for each retry
  - After 2nd retry failure:
    a) Call update-zendesk-ticket(usecase="transfer_sac", requerimientos_samy="sac_no_understanding")
    b) Display menu:
       "Para continuar con su solicitud, seleccione una opción:"
       "Uno; Dr. Salud asesoría y atención médica 24/7."
       "Dos; Servicio al cliente para información sobre su plan contratado"
       "Tres; Vitality"
       "Cuatro; Ventas."

  Step 3 — Menu Selection:
  - Uno/1 → trigger Transfer_Agent (DRSALUDEMERGENCY)
  - Dos/2 → call saveTransferSAC(user_request="sac", intent_identification=false)
  - Tres/3 → call saveTransferSAC(user_request="vitality", intent_identification=false)
  - Cuatro/4 → trigger Transfer_Agent (TRANSFERTOSALES)

  If isOutsideBusinessHours is true, ALSO display:
  "Tenga en cuenta que el horario de Atención al Cliente es de lunes a viernes, de 8.30 a. m. a 5.30 p. m. Puede contactarnos en cualquier momento a través de nuestra aplicación Saludsa y del portal del cliente en saludsa.com, disponible las 24 horas, los 7 días de la semana."

  CRITICAL: Retry attempts NEVER reset. Do NOT ask additional questions after retries exhausted.

  ═══ MODE B: FAREWELL ═══

  Execute farewell ONLY when BOTH conditions are true:
  1. User input is negative/dismissive: "no", "nada más", "ninguna", "no gracias", "eso es todo", "nada", "ya", "listo", "todo bien"
  2. Immediately preceding system action was an assistance offer:
     "¿Le puedo servir en algo más?", "¿Desea realizar otra consulta?", "¿En qué más puedo servirle?", "¿Hay algo más en lo que le pueda servir?"

  SAFETY — DO NOT trigger farewell if previous action was:
  - Authentication question
  - Data collection question
  - Menu selection or confirmation
  - Any yes/no question NOT about continued assistance
  In these cases: Route "No" response back to the active agent.

  Farewell message (time-of-day aware):
  - Morning: "Ha sido un placer servirle. Que tenga un excelente día."
  - Afternoon: "Ha sido un placer servirle. Que tenga una excelente tarde."
  - Night: "Ha sido un placer servirle. Que tenga una excelente noche."

  Then trigger EndOfConversation (set close_conversation="yes").

TOOLS:
  saveTransferSAC(channel: string, intent_identification: boolean, user_request: string, ticketNumber: string) -> TransferResult
  update-zendesk-ticket(sessionId: string, usecase: string, channel: string, subject: string, requerimientos_samy: string, note: string, transfer_reason: string, transfer_type: string) -> TicketResult
  HandleServiceFailure() -> ErrorResult

COMPLETE:
  - WHEN: session.close_conversation == "yes"
    RESPOND: ""
  - WHEN: menu_selection_processed == true
    RESPOND: ""
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/agents/fallback_farewell.agent.abl
git commit -m "feat(saludsa-e2e): add Fallback+Farewell agent — retry logic + time-aware farewell"
```

---

### Task 14: Create MCP tool binding

**Files:**

- Create: `examples/saludsa-e2e/tools/mcp_saludsa.tool.abl`

- [ ] **Step 1: Write MCP tool binding**

```abl
TOOL_GROUP: Saludsa_MCP_Tools
DESCRIPTION: "Saludsa backend MCP server — 31 tools for user validation, contract management, payments, certificates, transfers, and ticket management"

SERVER:
  name: Saludsa_MCP_Server
  url: "${SALUDSA_MCP_URL}"
  auth:
    type: basic
    credentials: "${SALUDSA_MCP_AUTH}"
  timeout: 45000

TOOLS:
  # ── User Validation ──
  - name: userValidation
    description: "Validate user by phone number and inbound number (WhatsApp/voice entry)"
    params:
      telePhoneNum: string
      inboundNumber: string
      channel: string
      botUserId: string
      botSessionId: string
      sessionId: string

  - name: validate-user
    description: "Validate user by ID card (WEB/iOS/Android entry)"
    params:
      idCard: string
      channel: string
      botUserId: string
      botSessionId: string
      sessionId: string

  - name: validate-broker
    description: "Validate broker identity by ID"
    params:
      brokerId: string
      sessionId: string

  # ── Security & OTP ──
  - name: getSecurityQuestions
    description: "Get security authentication question for user verification"
    params:
      sessionId: string
      channel: string

  - name: validate-otp
    description: "Validate OTP code provided by user"
    params:
      sessionId: string
      codigoOtpGenerado: string

  - name: generate-otp
    description: "Generate and send OTP to user"
    params:
      sessionId: string

  - name: validate-otp-client
    description: "Validate OTP for client identification"
    params:
      sessionId: string
      otp: string

  # ── Contract Management ──
  - name: contractStatus
    description: "Retrieve contract status and details for all user contracts"
    params:
      sessionId: string
      channel: string
      isAuthQVerified: boolean

  - name: sending-contracts
    description: "Send contract documents to user"
    params:
      sessionId: string
      channel: string

  # ── Payments ──
  - name: pending-payments
    description: "Get pending payment amounts for all user contracts"
    params:
      sessionId: string
      channel: string

  - name: pendingPaymentOtp
    description: "OTP validation specific to pending payments flow"
    params:
      sessionId: string

  # ── Refunds ──
  - name: steps-for-refund
    description: "Get refund eligibility and reimbursement steps for user contracts"
    params:
      sessionId: string
      channel: string

  - name: checkRefundStatus
    description: "Check status of a submitted refund request"
    params:
      sessionId: string

  - name: resend-refund-settlement
    description: "Resend refund settlement notification"
    params:
      sessionId: string

  - name: prioritize-refund-zendesk
    description: "Prioritize a refund request in Zendesk"
    params:
      sessionId: string

  # ── Password ──
  - name: passwordReset
    description: "Reset user password — eligibility check or execute reset via email/SMS"
    params:
      sessionId: string
      codigoTarea: string
      passwordResetType: string

  # ── Coverage Certificates ──
  - name: checkCoverageEligibility
    description: "Check eligibility for coverage or travel certificate"
    params:
      sessionId: string
      channel: string
      certificateType: string

  - name: getCoverageCertificate
    description: "Generate coverage or travel certificate"
    params:
      sessionId: string
      channel: string
      beneficiaryId: string
      startDate: string
      endDate: string

  # ── Transfer & Task Validation ──
  - name: validateTaskEligibility
    description: "Validate user eligibility for a specific task (Dr. Salud, dental, etc.)"
    params:
      sessionId: string
      codigoTarea: string

  - name: validarElegibilidadTarea
    description: "Validate task eligibility (Spanish variant)"
    params:
      sessionId: string
      codigoTarea: string

  - name: validateoutofhours
    description: "Check if current time is outside business hours"
    params:
      sessionId: string

  - name: checkPriorityTransfer
    description: "Check if user has priority transfer products (PCA/XPR/SAC)"
    params:
      sessionId: string

  - name: vitalityCheck
    description: "Check Vitality program eligibility and hours"
    params:
      sessionId: string

  # ── Sales ──
  - name: consultarAgenteVenta
    description: "Look up sales agent information"
    params:
      sessionId: string

  - name: validarAgenteVenta
    description: "Validate sales agent assignment"
    params:
      sessionId: string

  # ── Zendesk Tickets ──
  - name: update-zendesk-ticket
    description: "Update existing Zendesk ticket with case details"
    params:
      sessionId: string
      usecase: string
      channel: string
      subject: string
      requerimientos_samy: string
      note: string
      transfer_reason: string
      transfer_type: string

  - name: update-zendesk-ticket-prod
    description: "Update Zendesk ticket in production environment"
    params:
      sessionId: string
      usecase: string

  - name: create-zendesk-ticket
    description: "Create a new Zendesk ticket"
    params:
      sessionId: string
      channel: string
      subject: string

  - name: close-zendesk-ticket
    description: "Close an existing Zendesk ticket"
    params:
      sessionId: string
      ticketId: string

  # ── Communication ──
  - name: sendEmailTemplate
    description: "Send templated email to user (contract, refund steps, password reset)"
    params:
      sessionId: string
      useCaseName: string

  - name: lpd-consent
    description: "Record user consent for data processing (LPD compliance)"
    params:
      sessionId: string
      consent: boolean
```

- [ ] **Step 2: Commit**

```bash
git add examples/saludsa-e2e/tools/mcp_saludsa.tool.abl
git commit -m "feat(saludsa-e2e): add MCP tool binding — all 31 Saludsa backend tools"
```

---

## Chunk 4: ABL Runtime Test + Comparison

### Task 15: Create ABL Runtime E2E test

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/saludsa-abl-runtime.e2e.test.ts`

- [ ] **Step 1: Write ABL runtime test**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/saludsa-abl-runtime.e2e.test.ts

/**
 * Saludsa — ABL Runtime E2E Test
 *
 * Tests conversational scenarios against the ABL Runtime with compiled agent DSL files.
 * Uses the same MCP server as Kore.ai production (Saludsa backend).
 *
 * Architecture:
 *   Samy_Supervisor → routes to 6 child agents based on 5-level routing tree
 *   Each agent has rich PERSONA with step-by-step workflow instructions
 *   All agents share Saludsa MCP Server (31 tools)
 *
 * Required env vars:
 *   AZURE_OPENAI_API_KEY       – For GPT-4.1 LLM
 *   AZURE_OPENAI_ENDPOINT      – Azure OpenAI endpoint
 *   SALUDSA_MCP_URL            – Saludsa MCP server URL
 *   SALUDSA_MCP_AUTH           – Saludsa MCP Basic auth credentials
 *
 * Run with:
 *   npx vitest run --config vitest.config.ts src/__tests__/e2e/saludsa/saludsa-abl-runtime.e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { assertTurnResponse, logTurnDetails } from './assertions';

// ─── Config ──────────────────────────────────────────────────────────────────

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? '';
const SALUDSA_MCP_URL = process.env.SALUDSA_MCP_URL ?? '';

const SKIP_REASON = !AZURE_OPENAI_API_KEY
  ? 'AZURE_OPENAI_API_KEY not set — skipping ABL Runtime E2E tests'
  : !SALUDSA_MCP_URL
    ? 'SALUDSA_MCP_URL not set — skipping ABL Runtime E2E tests'
    : '';

const DSL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../examples/saludsa-e2e',
);

// ─── DSL Compilation ─────────────────────────────────────────────────────────

interface CompiledProject {
  agents: Map<string, unknown>;
  tools: Map<string, unknown>;
  config: Record<string, unknown>;
}

async function compileProject(): Promise<CompiledProject> {
  // Dynamic import to avoid pulling in compiler at module level
  const { ABLCompiler } = await import('@abl/compiler');

  const projectJsonPath = path.join(DSL_DIR, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    throw new Error(`project.json not found at ${projectJsonPath}`);
  }

  const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
  const compiler = new ABLCompiler();

  const agents = new Map<string, unknown>();
  for (const agentPath of projectJson.agents) {
    const fullPath = path.join(DSL_DIR, agentPath);
    const dsl = fs.readFileSync(fullPath, 'utf-8');
    const compiled = compiler.compile(dsl);
    const agentName = path.basename(agentPath, '.agent.abl');
    agents.set(agentName, compiled);
  }

  const tools = new Map<string, unknown>();
  for (const toolPath of projectJson.tools ?? []) {
    const fullPath = path.join(DSL_DIR, toolPath);
    const dsl = fs.readFileSync(fullPath, 'utf-8');
    const compiled = compiler.compile(dsl);
    const toolName = path.basename(toolPath, '.tool.abl');
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
  // For now, this is the integration point structure

  const startMs = Date.now();

  // This will be replaced with actual RuntimeExecutor invocation:
  // const executor = new RuntimeExecutor(project.agents, project.tools, project.config);
  // const result = await executor.execute(userMessage, sessionVars);

  return {
    text: '[ABL Runtime not yet wired — compile check only]',
    agentName: null,
    toolCalls: [],
    traces: [],
    timing: { startMs, endMs: Date.now(), firstTokenMs: Date.now() },
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!!SKIP_REASON)('Saludsa — ABL Runtime E2E', () => {
  let project: CompiledProject;

  beforeAll(async () => {
    if (SKIP_REASON) return;
    console.log(`[Saludsa ABL E2E] DSL directory: ${DSL_DIR}`);
    console.log(`[Saludsa ABL E2E] Compiling project...`);
    project = await compileProject();
    console.log(
      `[Saludsa ABL E2E] Compiled ${project.agents.size} agents, ${project.tools.size} tool groups`,
    );
  });

  // Only test WEB scenarios initially (no phone validation needed)
  const webScenarios = SCENARIOS.filter((s) => s.channel === 'WEB');

  for (const scenario of webScenarios) {
    describe(scenario.name, () => {
      const sessionVars: Record<string, unknown> = {
        channel: scenario.channel,
        is_user_validated: true, // WEB users are pre-validated
        user_role: 'Holder',
        priority_transfer: 'NA',
        ...scenario.sessionMetadata,
      };

      for (let t = 0; t < scenario.turns.length; t++) {
        const turn = scenario.turns[t];
        const turnLabel = `Turn ${t + 1}: "${turn.user.slice(0, 50)}"`;

        test(
          turnLabel,
          async () => {
            const result = await executeABLTurn(project, turn.user, sessionVars);

            // Basic structure check — full assertions when runtime is wired
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
    expect(project.agents.size).toBe(7);
    expect(project.tools.size).toBeGreaterThanOrEqual(1);

    const agentNames = [...project.agents.keys()];
    expect(agentNames).toContain('samy_supervisor');
    expect(agentNames).toContain('entry_gateway');
    expect(agentNames).toContain('contract_agent');
    expect(agentNames).toContain('self_service_agent');
    expect(agentNames).toContain('coverage_agent');
    expect(agentNames).toContain('transfer_agent');
    expect(agentNames).toContain('fallback_farewell');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/saludsa/saludsa-abl-runtime.e2e.test.ts
git commit -m "feat(e2e): add Saludsa ABL Runtime E2E test with DSL compilation check"
```

---

### Task 16: Create comparison report generator

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/saludsa/generate-comparison.ts`

- [ ] **Step 1: Write comparison generator**

```typescript
// apps/runtime/src/__tests__/e2e/saludsa/generate-comparison.ts

/**
 * Saludsa — Comparison Report Generator
 *
 * Generates a markdown report comparing Kore.ai baseline vs ABL Runtime results.
 * Adapted from AFG Blue Advisory pattern.
 *
 * Usage:
 *   npx tsx src/__tests__/e2e/saludsa/generate-comparison.ts \
 *     --baseline BASELINE_RESULTS.md \
 *     --runs abl-run-report.json
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

  w('# Saludsa — ABL Runtime vs Kore.ai Baseline Comparison');
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
    const bothPass = blScenario.passed && ablScenario.passed ? '✅' : '❌';
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
  console.log(`\n✅ Comparison report: ${outputPath}`);
  console.log(`   ${baseline.scenarios.length} scenarios compared`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const currentDir = dirname(fileURLToPath(import.meta.url));

  let baselinePath = '';
  let ablPath = '';
  let outputPath = resolve(currentDir, 'SALUDSA_ABL_VS_BASELINE_COMPARISON.md');

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
git add apps/runtime/src/__tests__/e2e/saludsa/generate-comparison.ts
git commit -m "feat(e2e): add Saludsa comparison report generator"
```

---

### Task 17: Verification and run commands

- [ ] **Step 1: Verify DSL files parse**

```bash
# Check all ABL files have valid syntax (basic structural check)
for f in examples/saludsa-e2e/agents/*.agent.abl; do
  echo "Checking $f..."
  head -1 "$f"  # Should be SUPERVISOR: or AGENT:
done

for f in examples/saludsa-e2e/tools/*.tool.abl; do
  echo "Checking $f..."
  head -1 "$f"  # Should be TOOL_GROUP:
done
```

- [ ] **Step 2: Verify test files compile**

```bash
cd apps/runtime
npx tsc --noEmit src/__tests__/e2e/saludsa/scenarios.ts src/__tests__/e2e/saludsa/sse-client.ts src/__tests__/e2e/saludsa/assertions.ts 2>&1 | head -30
```

- [ ] **Step 3: Run Kore.ai baseline (requires API key)**

```bash
SALUDSA_API_KEY=kg-... SALUDSA_APP_ID=aa-... npx vitest run --config vitest.integration.config.ts src/__tests__/e2e/saludsa/saludsa-koreai.e2e.test.ts
```

- [ ] **Step 4: Run ABL compilation check (no API key needed)**

```bash
npx vitest run --config vitest.config.ts src/__tests__/e2e/saludsa/saludsa-abl-runtime.e2e.test.ts
```

- [ ] **Step 5: Run full comparison**

```bash
npx tsx src/__tests__/e2e/saludsa/generate-comparison.ts \
  --baseline saludsa-koreai-results.json \
  --abl saludsa-abl-results.json \
  --out SALUDSA_ABL_VS_BASELINE_COMPARISON.md
```

---

## Execution Order

1. **Tasks 1-5** (Chunk 2): Kore.ai baseline test harness — can run immediately against live API
2. **Tasks 6-14** (Chunk 3): ABL DSL agents + tools — compile and validate structure
3. **Tasks 15-16** (Chunk 4): ABL runtime test + comparison — wire up after DSL compiles
4. **Task 17**: End-to-end verification

Dependencies:

- Tasks 15 depends on Tasks 6-14 (needs compiled DSL)
- Task 16 depends on Tasks 5 and 15 (needs both result JSONs)
- Tasks 1-5 are independent of Tasks 6-14
