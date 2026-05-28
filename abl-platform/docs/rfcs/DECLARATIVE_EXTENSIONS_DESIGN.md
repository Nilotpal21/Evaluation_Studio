# ABL Declarative Extensions Design

> **Date**: February 6, 2026
> **Status**: Proposal
> **Scope**: Comprehensive design for eliminating implicit logic, adding production-grade extensions, and enabling modular multi-tenant deployment
> **Inputs**: Kore.ai Saludsa production export analysis, implicit logic audit (189 findings), production pattern cataloging

## Table of Contents

1. [Motivation & Goals](#1-motivation--goals)
2. [Identified Gaps Summary](#2-identified-gaps-summary)
3. [Architecture: Modular Project Structure](#3-architecture-modular-project-structure)
4. [Extension: ENV (Environment Variables & Secrets)](#4-extension-env)
5. [Extension: CONNECTIONS (Reusable Service Configs)](#5-extension-connections)
6. [Extension: SERVICE (Declarative HTTP)](#6-extension-service)
7. [Extension: MAP (Lookup Tables)](#7-extension-map)
8. [Extension: Pipes (Transform Chains)](#8-extension-pipes)
9. [Extension: VALIDATE (Named Validators)](#9-extension-validate)
10. [Extension: TEMPLATE (Named Response Templates)](#10-extension-template)
11. [Extension: EVENTS (Schema-First Custom Events)](#11-extension-events)
12. [Extension: SWITCH (Multi-Branch Routing)](#12-extension-switch)
13. [Extension: COUNTER (Atomic Increment/Decrement)](#13-extension-counter)
14. [Extension: WAIT / INACTIVITY_TIMEOUT](#14-extension-wait--inactivity_timeout)
15. [Extension: EXECUTION (Per-Agent Configuration)](#15-extension-execution)
16. [Extension: MESSAGES (Localizable System Messages)](#16-extension-messages)
17. [Implicit Logic Remediation Plan](#17-implicit-logic-remediation-plan)
18. [Compile-Time Validation Framework](#18-compile-time-validation-framework)
19. [Multi-Tenant Isolation & Security](#19-multi-tenant-isolation--security)
20. [Circuit Breaking & Resilience](#20-circuit-breaking--resilience)
21. [Enterprise Authentication & Authorization](#21-enterprise-authentication--authorization)
22. [Enterprise Security & Key Management](#22-enterprise-security--key-management)
23. [Data Retention & Compliance](#23-data-retention--compliance)
24. [Parser/Compiler/Runtime Modularity](#24-parsercompilerruntime-modularity)
25. [Remaining Gaps & Future Work](#25-remaining-gaps--future-work)
26. [Implementation Phases](#26-implementation-phases)

---

## 1. Motivation & Goals

### Problem Statement

Analysis of a production Kore.ai export (Saludsa healthcare, Ecuador) against the ABL stack revealed:

- **189 implicit behaviors** hardcoded across parser, compiler, and runtime
- **14 capability gaps** blocking production parity with existing platforms
- **~40% of agent behavior** comes from hardcoded logic rather than user declarations
- **Zero non-English support** due to hardcoded keywords and messages
- **No modular file structure** — agents, config, and infrastructure mixed in one file
- **No compile-time validation** — errors discovered only at runtime

### Design Goals

1. **Declarative-first**: Every behavior that affects agent execution must originate from a user-authored declaration, not from hardcoded defaults
2. **Modular**: ABL projects split across focused files with a manifest
3. **Validated**: Errors caught at compile time with clear diagnostics
4. **Tenant-safe**: Every extension designed for multi-tenant isolation from day one
5. **Resource-bounded**: No extension can hold threads, leak memory, or create unbounded storage
6. **No inline code**: Replace 100% of Kore.ai's JavaScript code tools with declarative constructs
7. **Locale-neutral**: No English strings in the runtime; all messages come from the ABL spec

### Non-Goals

- General-purpose code execution (SCRIPT blocks with sandboxed JS/Python)
- GraphQL or gRPC protocol support (HTTP REST covers the production patterns)
- Real-time voice/streaming (separate design track)
- Knowledge/RAG integration (separate design track)

---

## 2. Identified Gaps Summary

### From Kore.ai Production Export Analysis

| Gap                             | Severity | Addressed By                                                   |
| ------------------------------- | -------- | -------------------------------------------------------------- |
| Channel-specific behavior       | Critical | EXECUTION block `channel` context + ON_INPUT conditions        |
| Pre/post processor hooks        | Critical | SERVICE + CONNECTIONS + flow step chaining                     |
| Per-agent model configuration   | Critical | [EXECUTION block](#15-extension-execution)                     |
| Environment variables & secrets | Critical | [ENV block](#4-extension-env)                                  |
| Inline code execution           | High     | SERVICE + MAP + Pipes + COUNTER + SWITCH (combined)            |
| Contact center / queue routing  | High     | MAP + SERVICE + SWITCH                                         |
| Events / lifecycle hooks        | High     | [EVENTS schema](#11-extension-events)                          |
| Voice / real-time config        | High     | EXECUTION block (partial); full voice is separate track        |
| User role/type awareness        | Medium   | ON_INPUT conditions on `userInfo.role`                         |
| Feature flags                   | Medium   | [Future: FEATURE_FLAGS block](#21-remaining-gaps--future-work) |
| Deployment packaging            | Medium   | [Project manifest](#3-architecture-modular-project-structure)  |
| Consent / compliance gating     | Medium   | Flow step with COLLECT + CALL pattern                          |
| Knowledge / RAG                 | Medium   | Future: KNOWLEDGE tool type                                    |
| Conversation summary            | Low      | EVENTS `session_complete` + auto-summary                       |

### From Enterprise Readiness Audit

| Gap                                       | Severity | Coverage             | Addressed By                                                                        |
| ----------------------------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------- |
| Circuit breaking (LLM providers)          | Critical | 25%                  | [Section 20: Circuit Breaking](#20-circuit-breaking--resilience)                    |
| Tenant isolation (RLS, per-tenant config) | Critical | 85% code, 40% design | [Section 19 expanded: RLS, Per-Tenant Config](#19-multi-tenant-isolation--security) |
| Enterprise security (key rotation, HSM)   | Critical | 60%                  | [Section 22: Key Management](#22-enterprise-security--key-management)               |
| Auth models (SSO, MFA, API scopes)        | High     | 75%                  | [Section 21: Enterprise Auth](#21-enterprise-authentication--authorization)         |
| Retention policies (enforcement, GDPR)    | High     | 20%                  | [Section 23: Data Retention](#23-data-retention--compliance)                        |
| Encryption at rest (session PII)          | High     | Partial              | [Section 22: Session Encryption](#22-enterprise-security--key-management)           |
| Audit log immutability                    | Medium   | Schema only          | [Section 23: Audit Verification](#23-data-retention--compliance)                    |
| Refresh token reuse detection             | Medium   | Not implemented      | [Section 21: Token Security](#21-enterprise-authentication--authorization)          |
| Service account provisioning              | Medium   | Not implemented      | [Section 21: Service Accounts](#21-enterprise-authentication--authorization)        |
| Compliance conflict resolution            | Medium   | Not addressed        | [Section 23: Plan vs. Compliance](#23-data-retention--compliance)                   |

### From Implicit Logic Audit (189 Findings)

| Category                                | Count             | Addressed By                                                                    |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Hardcoded defaults with no override     | 32                | [EXECUTION block](#15-extension-execution) + [MESSAGES](#16-extension-messages) |
| Magic strings controlling flow          | 11                | [Shared constants + IR config](#17-implicit-logic-remediation-plan)             |
| Inference rules (system decides)        | 6 systems         | EXECUTION block makes all configurable                                          |
| Hardcoded behavioral logic              | 6 systems         | [Compiler extension architecture](#20-parsercompilerruntime-modularity)         |
| English-only intent/correction matching | 42                | [MESSAGES](#16-extension-messages) + declarative DIGRESSIONS keywords           |
| Hardcoded error messages                | 9                 | [MESSAGES block](#16-extension-messages)                                        |
| Duplicate evaluation logic              | 2 implementations | [Unified evaluator](#17-implicit-logic-remediation-plan)                        |
| Domain-specific mock contamination      | 9 tools           | [Mock extraction](#17-implicit-logic-remediation-plan)                          |
| Auto-generated system prompts           | 2 layers          | EXECUTION `system_prompt_template`                                              |
| Auto-injected tools                     | 4 tools           | [Compile-time tool generation](#17-implicit-logic-remediation-plan)             |

---

## 3. Architecture: Modular Project Structure

### Project Manifest

Every ABL project has a YAML manifest at the root:

```yaml
# saludsa.abl.yaml
app:
  name: saludsa
  version: '1.2.0'
  description: 'Saludsa healthcare virtual assistant'
  default_locale: 'es-EC'

config:
  env: ./config/env.abl
  connections: ./config/connections.abl
  maps: ./config/maps.abl
  templates: ./config/templates.abl
  validators: ./config/validators.abl
  events: ./config/events.abl
  messages: ./config/messages.abl

agents:
  supervisor: ./agents/supervisor.abl
  agents:
    - ./agents/greeting.abl
    - ./agents/contract_assistant.abl
    - ./agents/other_services.abl
    - ./agents/farewell.abl
    - ./agents/vitality_transfer.abl
```

### Directory Layout

```
saludsa/
├── saludsa.abl.yaml              # Project manifest
├── config/
│   ├── env.abl                   # Environment variables & secrets
│   ├── connections.abl           # Named HTTP connections
│   ├── maps.abl                  # Lookup tables
│   ├── templates.abl             # Response templates
│   ├── validators.abl            # Named validation patterns
│   ├── events.abl                # Event schema definitions
│   └── messages.abl              # System message overrides
├── agents/
│   ├── supervisor.abl            # Supervisor agent
│   ├── greeting.abl              # Greeting & validation agent
│   ├── contract_assistant.abl    # Contract query agent
│   ├── other_services.abl        # Misc services agent
│   ├── farewell.abl              # Farewell handler
│   └── vitality_transfer.abl     # Vitality transfer agent
└── tests/
    ├── greeting.test.abl         # Test cases for greeting agent
    └── contract.test.abl         # Test cases for contract agent
```

### Compiler Resolution Order

```
1. Parse manifest → build file dependency graph
2. Parse config files (env, connections, maps, templates, validators, events, messages)
3. Build shared symbol table with all named definitions
4. Parse each agent file with symbol table in scope
5. Run validation passes (references, types, limits, flows, events, security)
6. Compile to IR (per-agent + app-level shared config)
7. Output: single IR bundle with all agents + shared config
```

### Single-File Mode

For simple agents or prototyping, everything can still live in one file. The manifest is optional — the compiler auto-detects single-file mode when given a `.abl` file directly.

```
# simple-agent.abl — everything inline, no manifest needed
ENV:
  API_URL:
    required: true

AGENT simple_bot:

GOAL: Answer user questions

TOOLS:
  lookup:
    type: service
    method: GET
    endpoint: "{{env.API_URL}}/search"
    query:
      q: "{{user_query}}"

FLOW:
  STEP ask:
    COLLECT: user_query
      PROMPT: "What would you like to know?"
    CALL: lookup(user_query)
    ON_SUCCESS:
      RESPOND: "{{result.answer}}"
    THEN: ask
```

---

## 4. Extension: ENV

Environment variables with secret protection and compile-time reference checking.

### Syntax

```
# config/env.abl

ENV:
  MCP_BASE_URL:
    description: "Saludsa MCP API base endpoint"
    required: true

  MCP_AUTH:
    description: "Basic auth credentials for MCP API"
    required: true
    secret: true

  CC_BASE_URL:
    description: "Contact center operations API"
    required: true

  CC_JWT_TOKEN:
    description: "JWT token for contact center API"
    secret: true

  CC_ACCOUNT_ID:
    description: "Contact center account identifier"

  CC_STREAM_ID:
    description: "Contact center stream identifier"

  APP_ENVIRONMENT:
    description: "Deployment environment"
    default: "production"
    enum: [development, staging, production]
```

### Semantics

| Property      | Required            | Description                                                            |
| ------------- | ------------------- | ---------------------------------------------------------------------- |
| `description` | No                  | Human-readable purpose                                                 |
| `required`    | No (default: false) | Compiler warns if not set; runtime fails on startup if missing         |
| `secret`      | No (default: false) | Value never appears in traces, logs, error messages, or debug tools    |
| `default`     | No                  | Fallback value when not set in environment                             |
| `enum`        | No                  | Allowed values; compiler validates defaults, runtime validates on load |

### Access Pattern

Referenced via `{{env.VARIABLE_NAME}}` in any interpolated context:

```
CONNECTION saludsa_mcp:
  base_url: "{{env.MCP_BASE_URL}}"
  auth:
    credentials: "{{env.MCP_AUTH}}"
```

### Runtime Behavior

- ENV values are loaded **once** at app startup from `process.env` or a config provider
- Values are **never** compiled into the IR — they remain references resolved at runtime
- `secret: true` values are stored in a separate protected map; trace/log serializers skip them
- Missing `required` variables cause a startup error with a clear message listing all missing vars

### Compile-Time Validation

```
[E100] ENV variable "MCP_BASE" referenced at connections.abl:2 is not defined
       Did you mean "MCP_BASE_URL"? Defined at env.abl:3

[E101] ENV variable "APP_ENVIRONMENT" default "prod" not in enum [development, staging, production]
       at env.abl:25

[W102] ENV variable "CC_STREAM_ID" is defined but never referenced in any file
```

---

## 5. Extension: CONNECTIONS

Named, reusable HTTP connection configurations. Eliminates the repetitive base URL + auth header setup found in every Kore.ai code tool.

### Syntax

```
# config/connections.abl

CONNECTION saludsa_mcp:
  base_url: "{{env.MCP_BASE_URL}}"
  auth:
    type: basic
    credentials: "{{env.MCP_AUTH}}"
  timeout: 10s
  retry:
    max_attempts: 2
    backoff: exponential
    delay: 1s
    on: [5xx, timeout]
  default_headers:
    Content-Type: "application/json"
    X-Request-Source: "abl-runtime"

CONNECTION contact_center:
  base_url: "{{env.CC_BASE_URL}}"
  auth:
    type: custom
    header: "auth"
    value: "{{env.CC_JWT_TOKEN}}"
  default_headers:
    Content-Type: "application/json"
    accountId: "{{env.CC_ACCOUNT_ID}}"
    IId: "{{env.CC_STREAM_ID}}"
  timeout: 15s

CONNECTION infobip_whatsapp:
  base_url: "https://l3wl15.api.infobip.com"
  auth:
    type: bearer
    token: "{{env.INFOBIP_API_KEY}}"
  timeout: 10s
```

### Auth Types

| Type      | Properties                                   | Header Generated                     |
| --------- | -------------------------------------------- | ------------------------------------ |
| `basic`   | `credentials` (base64 string or `user:pass`) | `Authorization: Basic <credentials>` |
| `bearer`  | `token`                                      | `Authorization: Bearer <token>`      |
| `api_key` | `header`, `value`                            | `<header>: <value>`                  |
| `custom`  | `header`, `value`                            | `<header>: <value>`                  |
| `none`    | —                                            | No auth header                       |

### Semantics

- `timeout` applies to every SERVICE call using this connection (overridable per-call)
- `retry` applies to every SERVICE call using this connection (overridable per-call)
- `retry.on` specifies which failures trigger retry: `5xx`, `4xx`, `timeout`, `network`
- `default_headers` are merged with per-call headers (per-call wins on conflict)

### Compile-Time Validation

```
[E110] CONNECTION "saludsa_mcp" auth type "basic" requires "credentials" property
       at connections.abl:4

[E111] CONNECTION "contact_center" timeout "0s" must be > 0
       at connections.abl:15

[E112] CONNECTION "infobip" retry.backoff "random" not in [exponential, linear, fixed]
       at connections.abl:25

[W113] CONNECTION "legacy_api" is defined but never referenced by any SERVICE tool
```

---

## 6. Extension: SERVICE

Comprehensive declarative HTTP integration replacing all inline code patterns from the Kore.ai export.

### Syntax (Full)

```
TOOLS:
  validate_user:
    type: service
    description: "Validate user identity against backend"
    connection: saludsa_mcp
    method: POST
    path: "/validateUser"
    headers:
      X-Correlation-Id: "{{session.id}}"
    body:
      idCard: "{{session.user_id}}"
      channel: "{{session.channel}}"
      botUserId: "{{session.user_reference}}"
      sessionId: "{{session.id}}"
    timeout: 15s                              # Overrides connection default
    retry:
      max_attempts: 3                         # Overrides connection default
      on: [5xx, timeout]
    cache:
      ttl: 5m
      key: "validate_{{session.user_id}}"
    response:
      success_when: "success == true"
      extract:
        role: "role"
        ticket_id: "ticketId"
        customer_name: "customerName"
        is_xpr: "isXPRExist"
        is_pca: "isPCAExist"
        priority_transfer: "priorityTransfer"
        needs_consent: "needs_consent"
      error_extract:
        error_message: "message"
        api_error: "apiError"
    on_success: continue
    on_failure: continue
    on_retry_exhausted: escalate
```

### SERVICE with GET + Query Parameters

```
TOOLS:
  check_business_hours:
    type: service
    connection: contact_center
    method: GET
    path: "/{{queue_id}}"
    query:
      format: "json"
      include_schedule: "true"
    response:
      success_when: "isHoursOfOperationValid == true"
      extract:
        is_open: "isHoursOfOperationValid"
        next_open: "nextAvailableTime"
```

### SERVICE with Dynamic Path

```
TOOLS:
  get_ticket:
    type: service
    connection: saludsa_mcp
    method: GET
    path: "/tickets/{{ticket_id}}"
    response:
      extract:
        status: "status"
        assignee: "assignee.name"
        updated_at: "updated_at"
```

### SERVICE with PATCH (Partial Update)

```
TOOLS:
  update_ticket:
    type: service
    connection: saludsa_mcp
    method: PATCH
    path: "/tickets/{{ticket_id}}"
    body:
      status: "{{new_status}}"
      note: "{{agent_note}}"
    response:
      success_when: "success == true"
```

### Response Mapping Details

| Property        | Required | Description                                                                      |
| --------------- | -------- | -------------------------------------------------------------------------------- |
| `success_when`  | No       | Condition on response body to determine success. Default: HTTP 2xx = success     |
| `extract`       | No       | Map of `context_variable: "response.json.path"`. Dot notation for nested fields. |
| `error_extract` | No       | Same as extract, but only populated on failure                                   |
| `raw_body`      | No       | Store full response body as a context variable (for complex responses)           |

### Cache Semantics

- `ttl`: Duration string (`30s`, `5m`, `1h`). Platform-enforced maximum.
- `key`: Template string for cache key. Must include a unique identifier (user ID, session ID, etc.)
- Cache is **tenant-namespaced** automatically: `{tenant_id}:{app_id}:{key}`
- Cache is **per-session** by default. Cross-session caching requires explicit `scope: app`
- Maximum cached response size enforced by platform config

### on_retry_exhausted

Terminal handler after all retries fail. Options:

- `continue` — proceed to ON_FAILURE branch with error context
- `escalate` — immediately escalate to human with service failure reason
- `respond: "message"` — send a fixed message and stop

### Compile-Time Validation

```
[E200] SERVICE "validate_user" references undefined CONNECTION "saludsa_mpc"
       Did you mean "saludsa_mcp"? Defined at connections.abl:1
       at agents/greeting.abl:8

[E201] SERVICE "validate_user" method "POST" requires "body" property
       at agents/greeting.abl:7

[E202] SERVICE "check_hours" path "/{{queue_id}}" references undefined variable "queue_id"
       at agents/contract.abl:25

[E203] SERVICE "validate_user" cache.ttl "2h" exceeds platform limit of 30m
       at agents/greeting.abl:20

[E204] SERVICE "validate_user" response.extract "is_xpr" maps to "isXPRExist" —
       field used in ON_INPUT at line 45 as number but extracted as untyped.
       Consider adding type annotation: is_xpr(boolean): "isXPRExist"

[W205] SERVICE "validate_user" has no response.error_extract — service failure details
       will not be available in ON_FAILURE branch
       at agents/greeting.abl:12

[W206] SERVICE "get_ticket" method "GET" has no retry configured and no ON_FAILURE handler
       at agents/contract.abl:30
```

---

## 7. Extension: MAP

Declarative lookup tables replacing conditional assignment chains.

### Syntax

```
# config/maps.abl

MAP queue_by_channel:
  "WEB": "Chat_Portal_Experience"
  "ANDROID": "Chat_App_Experience"
  "iOS": "Chat_App_Experience"
  "whatsapp": "WhatsappSAC"
  _default: "WhatsappSAC"

MAP queue_by_region:
  "sierra": "ChatVentasQuito"
  "costa": "ChatVentasGuayaquil"
  _default: "ChatVentasGuayaquil"

MAP farewell_by_slot:
  "mañana": "un excelente día"
  "tarde": "una excelente tarde"
  "noche": "una excelente noche"
  _default: "un excelente día"

MAP business_unit_by_queue:
  "ChatVentasQuito": "SALES"
  "ChatVentasGuayaquil": "SALES"
  "WhatsappSAC": "SAC"
  "WhatsAppVitality": "VITALITY"
  _default: "SAC"

MAP zendesk_usecase:
  "transfer_sac": "transfer_sac"
  "transfer_sales": "transfer_sales"
  "transfer_vitality": "transfer_vitality"
  "auth_fail": "auth_fail"
  "refund_status": "refund_status"
  _default: "general"
```

### Usage

In SET expressions:

```
SET: queue_name = MAP(queue_by_channel, session.channel)
SET: business_unit = MAP(business_unit_by_queue, queue_name)
```

In templates:

```
RESPOND: "Que tenga {{MAP(farewell_by_slot, userInfo.timeSlot)}}."
```

In SERVICE body:

```
TOOLS:
  update_ticket:
    type: service
    connection: saludsa_mcp
    method: POST
    path: "/updateZendeskTicket"
    body:
      usecase: "{{MAP(zendesk_usecase, current_action)}}"
      sessionId: "{{session.id}}"
```

### Semantics

- Keys are **case-sensitive** by default. Add `case_insensitive: true` for case-insensitive matching.
- `_default` is the fallback when no key matches. If omitted and no key matches, result is `null`.
- MAPs are **immutable** — compiled into the IR. Not modifiable at runtime.
- MAPs can be **chained**: `MAP(business_unit_by_queue, MAP(queue_by_channel, session.channel))`

### Compile-Time Validation

```
[E300] MAP "queue_by_chanel" referenced at agents/greeting.abl:42 is not defined
       Did you mean "queue_by_channel"? Defined at maps.abl:1

[W301] MAP "legacy_queues" is defined but never referenced

[W302] MAP "queue_by_region" has no _default case — lookups with unknown keys return null
       at maps.abl:8
```

---

## 8. Extension: Pipes

Chainable transform functions for template expressions. Replaces inline string/math/date operations.

### Syntax

```
{{expression | pipe1 | pipe2: arg | pipe3}}
```

### Built-in Pipes

#### String Pipes

| Pipe                | Input  | Output | Example                                       |
| ------------------- | ------ | ------ | --------------------------------------------- |
| `lowercase`         | string | string | `"WEB"` → `"web"`                             |
| `uppercase`         | string | string | `"sierra"` → `"SIERRA"`                       |
| `capitalize`        | string | string | `"sierra"` → `"Sierra"`                       |
| `trim`              | string | string | `" hello "` → `"hello"`                       |
| `replace: old: new` | string | string | `"hello" \| replace: "l": "r"` → `"herro"`    |
| `truncate: n`       | string | string | `"Hello World" \| truncate: 5` → `"Hello..."` |
| `mask: n`           | string | string | `"1234567890" \| mask: 4` → `"******7890"`    |
| `pad_left: n: char` | string | string | `"42" \| pad_left: 5: "0"` → `"00042"`        |
| `split: sep`        | string | array  | `"a,b,c" \| split: ","` → `["a","b","c"]`     |

#### Number Pipes

| Pipe          | Input  | Output | Example                        |
| ------------- | ------ | ------ | ------------------------------ |
| `add: n`      | number | number | `2 \| add: 1` → `3`            |
| `sub: n`      | number | number | `5 \| sub: 2` → `3`            |
| `multiply: n` | number | number | `3 \| multiply: 3` → `9`       |
| `divide: n`   | number | number | `10 \| divide: 3` → `3.33`     |
| `round: n`    | number | number | `3.14159 \| round: 2` → `3.14` |
| `min: n`      | number | number | `15 \| min: 10` → `10`         |
| `max: n`      | number | number | `3 \| max: 5` → `5`            |
| `abs`         | number | number | `-5 \| abs` → `5`              |

#### Date Pipes

| Pipe                     | Input       | Output | Example                                                           |
| ------------------------ | ----------- | ------ | ----------------------------------------------------------------- |
| `date: fmt`              | date/string | string | `"2026-02-06" \| date: "DD/MM/YYYY"` → `"06/02/2026"`             |
| `date_add: n: unit`      | date/string | date   | `"2026-02-06" \| date_add: 3: "days"` → `"2026-02-09"`            |
| `date_diff: other: unit` | date/string | number | Days/hours/minutes between dates                                  |
| `time_of_day`            | date/string | string | `"2026-02-06T14:30:00" \| time_of_day` → `"tarde"` (locale-aware) |

#### Array Pipes

| Pipe                | Input | Output | Example                              |
| ------------------- | ----- | ------ | ------------------------------------ |
| `count`             | array | number | `[a,b,c] \| count` → `3`             |
| `first`             | array | any    | `[a,b,c] \| first` → `a`             |
| `last`              | array | any    | `[a,b,c] \| last` → `c`              |
| `join: sep`         | array | string | `["a","b"] \| join: ", "` → `"a, b"` |
| `at: n`             | array | any    | `[a,b,c] \| at: 1` → `b`             |
| `slice: start: end` | array | array  | `[a,b,c,d] \| slice: 1: 3` → `[b,c]` |

#### General Pipes

| Pipe           | Input   | Output  | Example                            |
| -------------- | ------- | ------- | ---------------------------------- |
| `default: val` | any     | any     | `null \| default: "N/A"` → `"N/A"` |
| `json`         | any     | string  | `{a:1} \| json` → `'{"a":1}'`      |
| `type`         | any     | string  | `42 \| type` → `"number"`          |
| `exists`       | any     | boolean | `null \| exists` → `false`         |
| `not`          | boolean | boolean | `true \| not` → `false`            |
| `eq: val`      | any     | boolean | `"WEB" \| eq: "WEB"` → `true`      |

### Constraints

- **Max chain depth**: 10 pipes (compiler enforced)
- **Type checking**: Compiler validates pipe input/output type compatibility
- **No side effects**: Pipes are pure functions — no mutation, no I/O
- **Deterministic**: Same input always produces same output (no randomness)

### Compile-Time Validation

```
[E400] Pipe "add: 1" at agents/greeting.abl:32 expects number input,
       got string from "userInfo.role"

[E401] Unknown pipe "reverse" at agents/greeting.abl:45
       Available pipes: lowercase, uppercase, capitalize, trim, ...

[E402] Pipe chain exceeds max depth of 10 at agents/greeting.abl:50
       Chain: lowercase | trim | replace | split | first | lowercase | trim | default | ...

[E403] Pipe "date: fmt" at agents/greeting.abl:55 — format string "YYYY-MM-DD" has
       ambiguous separator. Use "YYYY/MM/DD" or "DD-MM-YYYY" for clarity.
```

---

## 9. Extension: VALIDATE

Named, reusable validation patterns with locale-aware error messages.

### Syntax

```
# config/validators.abl

VALIDATE ecuadorian_id:
  pattern: "^[0-9]{10}$"
  message: "El número de cédula debe tener 10 dígitos."

VALIDATE ecuadorian_passport:
  pattern: "^[A-Z]{1,2}[0-9]{6,7}$"
  message: "Formato de pasaporte inválido. Ejemplo: A1234567"

VALIDATE otp_code:
  pattern: "^[0-9]{6}$"
  message: "El código OTP debe ser de 6 dígitos."

VALIDATE phone_ec:
  pattern: "^\\+?593[0-9]{9}$"
  message: "Ingrese un número de teléfono ecuatoriano válido. Ejemplo: +593991234567"

VALIDATE email:
  pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
  message: "Formato de correo electrónico inválido."

VALIDATE positive_integer:
  pattern: "^[1-9][0-9]*$"
  message: "Debe ser un número entero positivo."

VALIDATE refund_envelope:
  pattern: "^NA-[0-9]{6}$"
  message: "El número de sobre debe tener formato NA-XXXXXX. Ejemplo: NA-123456"
```

### Usage in GATHER

```
GATHER:
  user_id:
    type: string
    required: true
    prompt: "Ingrese su número de cédula o pasaporte:"
    validate: ecuadorian_id | ecuadorian_passport
    max_attempts: 3
    on_exhausted: THEN transfer_to_sac

  otp:
    type: string
    required: true
    prompt: "Ingrese el código OTP enviado a su teléfono:"
    validate: otp_code
    max_attempts: 2
    on_exhausted: THEN otp_failure

  envelope_number:
    type: string
    prompt: "Ingrese el número de sobre de reembolso:"
    validate: refund_envelope
```

### Semantics

- `validate: a | b` means OR — the field passes if **either** validator matches
- `validate: a & b` means AND — the field must pass **both** validators
- `max_attempts` is per-field. Counter is automatic (no need for explicit COUNTER)
- `on_exhausted` fires after max_attempts failures

### Security: Regex Complexity Check

At compile time, every VALIDATE pattern is checked for ReDoS vulnerability:

```
[E500] VALIDATE "unsafe_pattern" at validators.abl:15 — regex has nested quantifiers "(a+)+"
       This pattern is vulnerable to ReDoS. Simplify to "a+"

[E501] VALIDATE "long_pattern" at validators.abl:20 — regex exceeds max length of 200 characters

[W502] VALIDATE "complex_pattern" at validators.abl:25 — regex has 8 groups (max recommended: 5)
```

At runtime, regex execution has a **100ms timeout** per evaluation.

---

## 10. Extension: TEMPLATE

Named response templates for consistent, maintainable messaging.

### Syntax

```
# config/templates.abl

TEMPLATE greeting_holder: |
  Hola {{userInfo.customerName | default: "estimado cliente"}}.
  Bienvenido a Saludsa. Soy Samy, su asistente virtual.
  ¿En qué le puedo ayudar?

TEMPLATE greeting_broker: |
  Hola {{userInfo.customerName | default: "estimado asesor"}}.
  Bienvenido al canal de asesores de Saludsa.

TEMPLATE contract_single: |
  Su contrato {{contract.planName | default: "Plan no especificado"}}
  ({{contract.contractNumber}}) se encuentra en estado: {{contract.status}}.

TEMPLATE contract_list: |
  Tiene {{contracts | count}} contratos:
  {{#each contracts}}
  {{add @index 1}}. {{planName}} ({{contractNumber}}): {{status}}
  {{/each}}

TEMPLATE contract_list_paged: |
  Mostrando contratos {{page_start}} a {{page_end}} de {{total}}:
  {{#each page_contracts}}
  {{add @index 1}}. {{planName}} ({{contractNumber}}): {{status}}
  {{/each}}
  {{#if has_more}}
  ¿Desea ver los siguientes contratos?
  {{/if}}

TEMPLATE farewell: |
  Ha sido un placer servirle. Que tenga {{MAP(farewell_by_slot, userInfo.timeSlot)}}.

TEMPLATE escalation_notice: |
  Lo transferiremos con un agente humano.
  Motivo: {{reason}}
  Prioridad: {{priority}}
  Su número de ticket es: {{userInfo.ticketId}}
```

### Usage

```
STEP show_contracts:
  ON_INPUT:
    IF contracts | count == 1:
      RESPOND: TEMPLATE(contract_single)
    ELSE IF contracts | count <= 5:
      RESPOND: TEMPLATE(contract_list)
    ELSE:
      SET: page_start = 1
      SET: page_end = 5
      SET: total = {{contracts | count}}
      SET: page_contracts = {{contracts | slice: 0: 5}}
      SET: has_more = true
      RESPOND: TEMPLATE(contract_list_paged)
```

### Semantics

- Templates are **pre-compiled** at compile time — no dynamic template loading
- Templates use the same `{{expression}}` interpolation as RESPOND
- Templates can reference MAPs, pipes, and context variables
- **Max output size**: Platform-enforced limit (e.g., 4KB) to prevent message flooding

### Compile-Time Validation

```
[E600] TEMPLATE "contract_single" references undefined variable "contract.planName"
       Variable "contract" is not in any GATHER, SET, or SERVICE response.extract
       at templates.abl:12

[E601] TEMPLATE "greeting" referenced at agents/greeting.abl:30 is not defined
       Available templates: greeting_holder, greeting_broker, ...

[W602] TEMPLATE "legacy_message" is defined but never referenced
```

---

## 11. Extension: EVENTS

Schema-first custom event definitions with bounded schema, retention, and compile-time conformance.

### Schema Definition

```
# config/events.abl

EVENTS:
  interaction_complete:
    description: "Emitted when a user conversation ends normally"
    fields:
      user_role:
        type: string
        required: true
        enum: [broker, director, business_rep, holder, beneficiary, non_client]
      resolution:
        type: string
        required: true
        enum: [resolved, escalated, abandoned, transferred]
      ticket_id:
        type: number
      agent_name:
        type: string
        required: true
      turn_count:
        type: number
        required: true
    retention: 90d
    index: [user_role, resolution]

  validation_failed:
    description: "Emitted on identity validation failure"
    fields:
      attempt_number:
        type: number
        required: true
        max: 10
      error_type:
        type: string
        required: true
        enum: [invalid_id, invalid_otp, invalid_passport, not_eligible, api_error]
      channel:
        type: string
    retention: 30d
    index: [error_type]

  service_degraded:
    description: "Emitted when a SERVICE call fails after all retries"
    fields:
      service_name:
        type: string
        required: true
      status_code:
        type: number
      error_message:
        type: string
      retry_count:
        type: number
    retention: 7d
    index: [service_name]

  transfer_initiated:
    description: "Emitted when user is transferred to queue"
    fields:
      queue_name:
        type: string
        required: true
      business_unit:
        type: string
        required: true
      reason:
        type: string
      is_priority:
        type: boolean
    retention: 90d
    index: [queue_name, business_unit]
```

### Usage in Agents (EMIT)

```
STEP complete_interaction:
  EMIT: interaction_complete
    user_role: "{{userInfo.role}}"
    resolution: "resolved"
    ticket_id: "{{userInfo.ticketId}}"
    agent_name: "contract_assistant"
    turn_count: "{{session.turn_count}}"
  RESPOND: TEMPLATE(farewell)
  THEN: COMPLETE
```

```
STEP handle_validation_failure:
  COUNTER: userInfo.invalidCount INCREMENT
  EMIT: validation_failed
    attempt_number: "{{userInfo.invalidCount}}"
    error_type: "invalid_id"
    channel: "{{session.channel}}"
  ON_INPUT:
    IF userInfo.invalidCount >= 2:
      THEN: transfer_to_sac
    ELSE:
      RESPOND: "Identificación no válida. Intente nuevamente."
      THEN: ask_id
```

### System Events (Auto-Emitted)

The runtime automatically emits events with a reserved `_system` prefix. Users cannot declare or EMIT `_system.*` events.

| Event                          | Auto-Emitted When                | Fields                                                              |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| `_system.session_started`      | New session created              | session_id, channel, tenant_id, agent_name, timestamp               |
| `_system.session_completed`    | Session ends                     | session_id, duration_ms, turn_count, completion_reason              |
| `_system.service_call`         | SERVICE tool executes            | service_name, method, status_code, duration_ms, cached, retry_count |
| `_system.handoff`              | Agent handoff                    | from_agent, to_agent, reason, context_keys                          |
| `_system.escalation`           | Escalation triggered             | reason, priority, agent_name, turn_count                            |
| `_system.timeout`              | WAIT or INACTIVITY_TIMEOUT fires | step_name, timeout_type, duration_ms                                |
| `_system.gather_complete`      | All GATHER fields collected      | agent_name, field_count, turn_count                                 |
| `_system.constraint_violation` | Constraint fails                 | constraint_name, phase, action_taken                                |

### Boundaries

| Limit                     | Default | Enforced By     |
| ------------------------- | ------- | --------------- |
| Max event types per app   | 50      | Compiler        |
| Max fields per event type | 20      | Compiler        |
| Max enum values per field | 50      | Compiler        |
| Max retention             | 365d    | Platform config |
| Max event payload size    | 4KB     | Runtime         |
| Max events per session    | 100     | Runtime         |

### Compile-Time Validation

```
[E700] EMIT "interaction_complete" at agents/contract.abl:95 missing required field "agent_name"
       Required fields: user_role, resolution, agent_name, turn_count

[E701] EMIT "interaction_complete" field "resolution" value "done" not in enum
       Allowed: resolved, escalated, abandoned, transferred
       at agents/contract.abl:97

[E702] EMIT "unknown_event" at agents/greeting.abl:42 references undefined event schema
       Defined events: interaction_complete, validation_failed, service_degraded, transfer_initiated

[E703] EMIT "validation_failed" field "attempt_number" expects number, got string expression
       at agents/greeting.abl:55

[E704] Event schema "audit_trail" at events.abl:80 exceeds max fields limit of 20 (has 23)

[E705] EMIT "_system.session_started" at agents/greeting.abl:10 — cannot emit system events
       System events (_system.*) are auto-emitted by the runtime

[W706] Event "service_degraded" is defined but never EMIT'd in any agent
```

---

## 12. Extension: SWITCH

Clean multi-branch routing without verbose IF chains. Compiles to ON_INPUT internally.

### Syntax

```
STEP route_by_priority:
  SWITCH: userInfo.priorityTransfer
    "SAC":
      THEN: transfer_to_sac
    "XPR":
      CALL: check_eligibility(userInfo.contractNumber)
      ON_SUCCESS: THEN xpr_eligible
      ON_FAILURE: THEN transfer_to_sac
    "PCA":
      CALL: check_eligibility(userInfo.contractNumber)
      ON_SUCCESS: THEN pca_eligible
      ON_FAILURE: THEN transfer_to_sac
    _default:
      THEN: main_flow
```

```
STEP route_by_channel:
  SWITCH: session.channel | lowercase
    "web":
      SET: queue_name = "Chat_Portal_Experience"
      THEN: prepare_transfer
    "android" | "ios":
      SET: queue_name = "Chat_App_Experience"
      THEN: prepare_transfer
    "whatsapp":
      SET: queue_name = "WhatsappSAC"
      THEN: validate_security
    _default:
      SET: queue_name = "WhatsappSAC"
      THEN: prepare_transfer
```

### Semantics

- `"android" | "ios"` means match either value (OR within a case)
- `_default` is required (compiler warning if omitted)
- SWITCH expression can include pipes: `session.channel | lowercase`
- Cases are evaluated **top-to-bottom**, first match wins
- Compiles to ON_INPUT chain internally — **no new runtime code needed**

### Compile-Time Validation

```
[E800] SWITCH at agents/greeting.abl:42 has duplicate case "WEB" (lines 43 and 47)

[W801] SWITCH at agents/greeting.abl:42 has no _default case — unmatched values will
       cause a runtime error

[E802] SWITCH at agents/greeting.abl:42 case "XPR" has CALL but no ON_FAILURE handler

[W803] SWITCH at agents/greeting.abl:42 — all cases lead to same step "prepare_transfer"
       Consider removing the SWITCH and going directly to prepare_transfer
```

---

## 13. Extension: COUNTER

Atomic increment/decrement with compile-time safety checks.

### Syntax

```
STEP handle_invalid_otp:
  COUNTER: userInfo.otpInvalidCount INCREMENT
  ON_INPUT:
    IF userInfo.otpInvalidCount >= 2:
      EMIT: validation_failed
        attempt_number: "{{userInfo.otpInvalidCount}}"
        error_type: "invalid_otp"
        channel: "{{session.channel}}"
      CALL: update_zendesk(session.id, "auth_fail")
      THEN: transfer_to_sac
    ELSE:
      RESPOND: "Código OTP incorrecto. Intente nuevamente."
      THEN: ask_otp
```

### Operations

```
COUNTER: variable INCREMENT           # +1
COUNTER: variable DECREMENT           # -1
COUNTER: variable RESET               # back to 0
COUNTER: variable INCREMENT BY 5      # +5
```

### Semantics

- Counter variable is auto-initialized to `0` if not set
- COUNTER is atomic — no race conditions in concurrent access
- COUNTER operates on session-scoped variables only

### Compile-Time Validation

```
[W900] COUNTER "userInfo.otpInvalidCount" at agents/greeting.abl:42 increments
       but is never checked in a condition. Missing max-attempt guard?

[E901] COUNTER "userInfo.invalidCount" INCREMENT BY -1 — use DECREMENT instead

[W902] COUNTER "retryCount" at agents/contract.abl:30 is incremented but never RESET.
       If the user re-enters this flow, the counter will carry over from previous attempts.
```

---

## 14. Extension: WAIT / INACTIVITY_TIMEOUT

Timer-based delays and step-level inactivity handling. **Never holds server threads.**

### WAIT Syntax

```
STEP notify_and_check:
  RESPOND: "Verificando su información, un momento..."
  WAIT: 2s
  CALL: check_status(ticket_id)
  ON_SUCCESS: THEN show_result
```

### INACTIVITY_TIMEOUT Syntax

```
STEP waiting_for_otp:
  COLLECT: otp_code
    PROMPT: "Ingrese el código OTP enviado a su teléfono:"
    validate: otp_code
  INACTIVITY_TIMEOUT:
    2m:
      RESPOND: "¿Sigue ahí? El código OTP expirará pronto."
    5m:
      EMIT: interaction_complete
        resolution: "abandoned"
        agent_name: "greeting"
        user_role: "{{userInfo.role}}"
        turn_count: "{{session.turn_count}}"
      RESPOND: "Su sesión ha expirado por inactividad. Hasta pronto."
      THEN: COMPLETE
```

### Runtime Architecture (No Thread Holding)

```
User message arrives
  → Runtime processes steps
  → Hits WAIT: 2s or INACTIVITY_TIMEOUT
  → Saves full session state to persistent store:
      {
        session_id, tenant_id, agent_name, current_step,
        context, gather_progress, flow_state,
        resume_at: now + duration,
        timeout_type: "wait" | "inactivity"
      }
  → Releases all in-memory resources
  → Returns immediately (no open connection)

Timer service (separate lightweight process):
  → Polls for resume_at <= now (or uses scheduled queue like SQS/Cloud Tasks)
  → Rehydrates session from store
  → For WAIT: continues to next step
  → For INACTIVITY_TIMEOUT: executes timeout branch
  → Sends response via channel adapter (WebSocket, WhatsApp API, etc.)

If user sends message before timeout:
  → Normal message handling rehydrates session
  → Cancels pending timer
  → Continues from saved step
```

### Platform Limits

| Limit                         | Default | Enforced By     |
| ----------------------------- | ------- | --------------- |
| Max WAIT duration             | 5m      | Compiler        |
| Max INACTIVITY_TIMEOUT        | 30m     | Compiler        |
| Max pending timers per tenant | 10,000  | Runtime         |
| Max session age               | 2h      | Platform config |
| Timer resolution              | 1s      | Timer service   |

### Compile-Time Validation

```
[E1000] WAIT "45m" at agents/greeting.abl:50 exceeds platform max of 5m

[E1001] INACTIVITY_TIMEOUT "3h" at agents/greeting.abl:55 exceeds platform max of 30m

[E1002] INACTIVITY_TIMEOUT thresholds must be in ascending order.
        Found 5m before 2m at agents/greeting.abl:57-60

[W1003] Step "waiting_for_otp" has COLLECT but no INACTIVITY_TIMEOUT.
        Users may abandon the session without cleanup.
```

---

## 15. Extension: EXECUTION

Per-agent configuration block replacing all hardcoded defaults from the implicit logic audit.

### Syntax

```
AGENT contract_assistant:

EXECUTION:
  model: "claude-sonnet-4-5-20250929"
  temperature: 0.3
  max_tokens: 4096
  tool_timeout: 15s
  llm_timeout: 30s
  session_idle_timeout: 30m
  max_reasoning_iterations: 15
  max_flow_iterations: 200
  voice_latency_target: 600ms
  fallback_model: "claude-haiku-4-5-20251001"
  gather_strategy: hybrid
  gather_confidence_threshold: 0.85

GOAL: Retrieve and display contract information
...
```

### All Configurable Properties

| Property                      | Type         | Default                                 | Was Hardcoded At           |
| ----------------------------- | ------------ | --------------------------------------- | -------------------------- |
| `model`                       | string       | Platform default                        | `runtime-executor.ts:353`  |
| `temperature`                 | number (0-2) | 1.0                                     | Not configurable at all    |
| `max_tokens`                  | number       | 2048                                    | `runtime-executor.ts:372`  |
| `tool_timeout`                | duration     | 30s                                     | `compiler.ts:100`          |
| `llm_timeout`                 | duration     | 30s                                     | `compiler.ts:101`          |
| `session_idle_timeout`        | duration     | 30m                                     | `compiler.ts:102`          |
| `max_reasoning_iterations`    | number       | 10                                      | `reasoning-executor.ts:88` |
| `max_flow_iterations`         | number       | 100                                     | `flow-executor.ts:119`     |
| `voice_latency_target`        | duration     | 500ms (scripted) / 1s (reasoning)       | `compiler.ts:103-104`      |
| `fallback_model`              | string       | none                                    | Not configurable at all    |
| `gather_strategy`             | enum         | pattern (scripted) / hybrid (reasoning) | `compiler.ts:229`          |
| `gather_confidence_threshold` | number (0-1) | 0.9                                     | `gather-executor.ts:191`   |
| `entry_point`                 | string       | First step                              | `compiler.ts:609`          |

### Supervisor-Specific Properties

```
SUPERVISOR my_supervisor:

EXECUTION:
  model: "claude-sonnet-4-5-20250929"
  confidence_threshold: 0.7
  can_respond_directly: false
  default_agent: "fallback_handler"
  intent_categories: [greeting, farewell, escalation, booking, support]
```

| Property               | Type         | Default                          | Was Hardcoded At            |
| ---------------------- | ------------ | -------------------------------- | --------------------------- |
| `confidence_threshold` | number (0-1) | 0.5                              | `compiler.ts:168`           |
| `can_respond_directly` | boolean      | false                            | `supervisor-parser.ts:1190` |
| `default_agent`        | string       | "Fallback_Handler"               | `compiler.ts:164`           |
| `intent_categories`    | string[]     | [greeting, farewell, escalation] | `compiler.ts:695-697`       |

### Compile-Time Validation

```
[E1100] EXECUTION temperature 2.5 at agents/greeting.abl:5 exceeds max of 2.0

[E1101] EXECUTION model "gpt-4" is not a recognized model identifier
        Available: claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001, claude-opus-4-6

[E1102] EXECUTION max_reasoning_iterations 0 must be > 0
        at agents/greeting.abl:10

[W1103] EXECUTION fallback_model is same as model ("claude-sonnet-4-5-20250929")
        Fallback will not provide degraded service on primary failure

[E1104] SUPERVISOR default_agent "fallback" at agents/supervisor.abl:8 does not match
        any declared agent. Available: greeting, contract_assistant, farewell
```

---

## 16. Extension: MESSAGES

Localizable system messages replacing all hardcoded English strings.

### Syntax

```
# config/messages.abl

MESSAGES:
  error_default: "Lo sentimos, ocurrió un error. Por favor intente de nuevo."
  constraint_blocked: "No podemos proceder con esa solicitud."
  gather_prompt: "Por favor proporcione: {{fields}}"
  gather_retry: "No pude entender su respuesta. {{original_prompt}}"
  escalation_notice: TEMPLATE(escalation_notice)
  conversation_complete: "Esta conversación ha finalizado. ¡Hasta pronto!"
  invalid_handoff: "Error interno de enrutamiento. Un momento por favor."
  self_handoff: "Error interno de enrutamiento."
  tool_fallback_description: "Ejecutar la herramienta {{tool_name}}"
  session_expired: "Su sesión ha expirado por inactividad."
  service_unavailable: "El servicio no está disponible en este momento. Intente más tarde."
```

### Messages Replaced

| Message Key                 | Replaces Hardcoded String              | Was At                       |
| --------------------------- | -------------------------------------- | ---------------------------- |
| `error_default`             | "An error occurred. Please try again." | `compiler.ts:413`            |
| `constraint_blocked`        | "I cannot proceed with that request."  | `constraint-executor.ts:251` |
| `gather_prompt`             | "Please provide: {{fields}}"           | `runtime-executor.ts:2003`   |
| `escalation_notice`         | "Escalated to Human Agent..."          | `runtime-executor.ts:3594`   |
| `conversation_complete`     | "This conversation has been completed" | `runtime-executor.ts:785`    |
| `invalid_handoff`           | "Invalid handoff target: '{{target}}'" | `runtime-executor.ts:3181`   |
| `self_handoff`              | "Cannot hand off to yourself"          | `runtime-executor.ts:3189`   |
| `tool_fallback_description` | "Execute the {{toolName}} tool"        | `runtime-executor.ts:4177`   |

### Semantics

- If MESSAGES block is absent, English defaults are used (backward compatible)
- MESSAGES can reference TEMPLATEs via `TEMPLATE(name)`
- Templates within messages have access to the same context as the agent
- MESSAGES are compiled into the IR per-app — not per-agent

---

## 17. Implicit Logic Remediation Plan

### 17.1 Extract Mock Tools from Runtime

**Current**: 9 hardcoded mock tools in `runtime-executor.ts:171-315` (hotel/flight/medical domain data in production path)

**Action**:

1. Move to `apps/platform/src/services/mock-tools.ts`
2. Load only when `config.enableMocks === true` or `NODE_ENV === 'test'`
3. Remove `hotels` and `results` empty-array failure check (`runtime-executor.ts:1544-1547`)
4. Replace with generic `_error` flag check, or better: use SERVICE `response.success_when`

### 17.2 Shared Constants Module

**Current**: Magic strings scattered across compiler and runtime

**Action**: Create `packages/compiler/src/platform/constants.ts`:

```typescript
// Terminal step names
export const TERMINAL_STEP = 'COMPLETE';

// Phase names
export const ALWAYS_PHASE = 'always';

// Internal context keys
export const CONTEXT_SUMMARY_KEY = '_summary';
export const CONTEXT_STORED_PREFIX = '_stored_';
export const CONTEXT_ERROR_KEY = '_error';
export const CONTEXT_CORRECTION_KEY = '_correction';

// Terminal action types
export const TERMINAL_ACTIONS = ['complete', 'escalate', 'handoff', 'block'] as const;

// Actions requiring user response
export const RESPONSE_ACTIONS = ['respond', 'collect', 'complete', 'escalate', 'block'] as const;

// Auto-injected tool names
export const SYSTEM_TOOLS = {
  HANDOFF: '__handoff__',
  DELEGATE: '__delegate__',
  COMPLETE: '__complete__',
  ESCALATE: '__escalate__',
} as const;
```

### 17.3 Unify Condition Evaluator

**Current**: `packages/compiler/src/platform/constructs/evaluator.ts` and `apps/platform/src/services/runtime-executor.ts` both implement condition evaluation with inconsistent rules.

**Action**:

1. Consolidate into `packages/compiler/src/platform/constructs/evaluator.ts`
2. Runtime imports from compiler package
3. Fix inconsistency: undefined variables in constraints currently **silently pass** — this should be configurable (`strict_mode: true` → undefined = error)
4. Document all coercion rules explicitly
5. Add comprehensive test suite for edge cases

### 17.4 Move Auto-Injected Tools to Compile Phase

**Current**: `__handoff__`, `__delegate__`, `__complete__`, `__escalate__` created at runtime (`runtime-executor.ts:4243-4326`)

**Action**:

1. Generate these tools during compilation
2. Include them in the IR output with descriptions from MESSAGES
3. Runtime reads tools from IR instead of generating them
4. Users can see and customize tool descriptions in the IR

### 17.5 Externalize Intent Keywords

**Current**: 37 English keywords hardcoded in `runtime-executor.ts:2678-2684`

**Action**:

1. Default keywords move to a `default-intents.ts` config file
2. DIGRESSIONS in ABL can override with `keywords:` property
3. If no keywords specified, use defaults from config
4. Defaults are loadable per-locale (future: `default-intents-es.ts`)

### 17.6 Externalize Correction Patterns

**Current**: 5 English regex patterns hardcoded in `runtime-executor.ts:1896-1902`, including domain-specific terms ("guests", "rooms", "nights")

**Action**:

1. Default patterns move to `default-corrections.ts` config file
2. GATHER `correction_patterns:` property allows override
3. Remove domain-specific terms from default patterns
4. Defaults are loadable per-locale

### 17.7 Remove Field Name Heuristics

**Current**: `runtime-executor.ts:2059-2084` infers field types from name substrings ("destination" → string, "checkin" → date)

**Action**:

1. Delete lines 2059-2084 entirely
2. Field types come exclusively from GATHER declarations in the IR
3. Entity extraction uses declared types, not name guessing

### 17.8 Fix Guardrail Default Mismatch

**Current**: Parser defaults guardrail action to `'warn'` (`agent-based-parser.ts:2330`) but compiler maps `'warn'` to `'respond'` action (`compiler.ts:292-304`). These are inconsistent.

**Action**:

1. Parser default: `'warn'` — this is the user's declared intent
2. Compiler: `'warn'` should map to a `'warn'` action type (not silently become `'respond'`)
3. Add `'warn'` as a distinct action type in the IR with behavior: log + continue (vs `'respond'`: message + continue, `'block'`: message + stop)

---

## 18. Compile-Time Validation Framework

### Validation Passes

The compiler runs 7 validation passes after parsing and before IR generation:

```
Pass 1: Reference Validation
  → All MAP, TEMPLATE, VALIDATE, CONNECTION, ENV, EVENT references resolve
  → Fuzzy matching for "did you mean?" suggestions

Pass 2: Type Validation
  → Pipe input/output type compatibility
  → MAP key type matches SWITCH/SET expression type
  → EMIT field types match event schema
  → GATHER field types match VALIDATE pattern expectations

Pass 3: Limit Validation
  → WAIT / INACTIVITY_TIMEOUT within platform limits
  → SERVICE cache TTL within limits
  → Pipe chain depth within limits
  → Event field count within limits
  → VALIDATE regex complexity within limits

Pass 4: Flow Validation
  → Unreachable step detection
  → Cycle detection without user input
  → Missing COMPLETE reachability from entry point
  → CALL without ON_FAILURE handler (warning)
  → COLLECT without INACTIVITY_TIMEOUT (warning)

Pass 5: Event Schema Validation
  → All EMIT statements conform to declared schema
  → Required fields present
  → Enum values valid
  → No EMIT of _system.* events

Pass 6: Security Validation
  → SERVICE endpoints match allowed domain patterns
  → VALIDATE regex ReDoS check
  → ENV secret variables not used in RESPOND or TEMPLATE output
  → No hardcoded credentials in CONNECTION auth

Pass 7: Consistency Validation
  → EXECUTION model is recognized
  → SUPERVISOR default_agent exists in agents list
  → HANDOFF targets exist as declared agents
  → DELEGATE targets exist as declared agents
  → SWITCH cases are unique (no duplicates)
  → MAP keys are unique
  → TEMPLATE names are unique
```

### Error Severity Levels

| Level       | Code Range | Behavior                                  |
| ----------- | ---------- | ----------------------------------------- |
| **Error**   | E001-E999  | Compilation fails. Must be fixed.         |
| **Warning** | W001-W999  | Compilation succeeds. Should be reviewed. |
| **Info**    | I001-I999  | Compilation succeeds. Informational.      |

### Error Message Format

```
[E201] SERVICE "validate_user" method "POST" requires "body" property
       at agents/greeting.abl:7:3

       5 |   validate_user:
       6 |     type: service
       7 |     method: POST
         |     ^^^^^^^
       8 |     path: "/validateUser"

       Help: POST, PUT, and PATCH methods require a body. Add:
         body:
           field: "{{value}}"
```

---

## 19. Multi-Tenant Isolation & Security

### Per-Extension Isolation

| Extension        | Isolation Concern               | Mitigation                                                                                             |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **ENV**          | Secret leaking across tenants   | Values loaded per-deployment, never in IR. Secrets in protected map, excluded from traces/logs/errors. |
| **CONNECTIONS**  | Cross-tenant credential sharing | Compiled per-app IR. No shared mutable state. Credentials resolved from tenant-scoped ENV.             |
| **SERVICE**      | SSRF (calling internal APIs)    | Platform config defines URL allowlist per tenant. Compiler validates. Runtime double-checks.           |
| **SERVICE**      | Response bombing                | Max response body size per call (platform config, e.g., 1MB).                                          |
| **SERVICE**      | Concurrent call flooding        | Max concurrent calls per session and per tenant.                                                       |
| **MAP**          | Cross-tenant data leakage       | Compiled into per-app IR. Immutable at runtime. No shared state.                                       |
| **TEMPLATE**     | Template injection              | Pre-compiled at compile time. No dynamic template loading. Max output size enforced.                   |
| **VALIDATE**     | ReDoS                           | Regex complexity checked at compile time. Runtime 100ms timeout per evaluation.                        |
| **Pipes**        | Infinite computation            | Max chain depth (10). Runtime expression eval timeout (50ms).                                          |
| **CACHE**        | Cache poisoning                 | Keys auto-namespaced: `{tenant_id}:{app_id}:{user_key}`. Per-tenant size limits.                       |
| **WAIT/TIMEOUT** | Timer resource exhaustion       | Per-tenant pending timer limit. Platform max duration. Session eviction (no thread holding).           |
| **EVENTS**       | Schema explosion                | Max 50 event types per app. Max 20 fields per type. Retention enforced.                                |
| **COUNTER**      | Unbounded state growth          | Session-scoped only. Max value configurable. Compiler warns if no conditional guard.                   |

### Platform Security Config (Per Tenant)

```yaml
# platform-config.yaml (not ABL — platform admin)
tenant_security:
  allowed_service_domains:
    - '*.saludsa.com.ec'
    - '*.zendesk.com'
    - '*.infobip.com'
  blocked_service_domains:
    - '169.254.*' # Cloud metadata
    - '10.*' # Internal network
    - 'localhost'
    - '127.0.0.1'
    - '*.internal'

  limits:
    max_service_timeout_ms: 30000
    max_response_body_bytes: 1048576 # 1MB
    max_concurrent_service_calls: 10
    max_cache_entries_per_session: 100
    max_cache_entry_bytes: 102400 # 100KB
    max_pending_timers: 10000
    max_wait_ms: 300000 # 5 minutes
    max_inactivity_timeout_ms: 1800000 # 30 minutes
    max_session_age_ms: 7200000 # 2 hours
    max_events_per_session: 100
    max_event_payload_bytes: 4096 # 4KB
    regex_timeout_ms: 100
    pipe_eval_timeout_ms: 50
    max_pipe_chain_depth: 10
    max_template_output_bytes: 4096 # 4KB
    max_event_types_per_app: 50
    max_event_fields_per_type: 20
```

### Row-Level Security (RLS)

All database queries MUST be scoped to the tenant boundary. This applies at three levels:

**Level 1: PostgreSQL RLS Policies (Control Plane)**

```sql
-- Enable RLS on all tenant-scoped tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_configs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their organization's data
CREATE POLICY org_isolation ON projects
  USING (org_id = current_setting('app.current_org_id')::text);

CREATE POLICY org_isolation ON agents
  USING (project_id IN (
    SELECT id FROM projects WHERE org_id = current_setting('app.current_org_id')::text
  ));

-- Set tenant context on every request
SET LOCAL app.current_org_id = '<org_id>';
```

**Level 2: Middleware Enforcement (Application Layer)**

```typescript
// Every route handler receives tenant context via middleware chain:
// 1. authenticate() → extracts user from JWT/API key
// 2. tenantContext() → resolves org_id, sets Prisma middleware
// 3. rateLimiter() → per-tenant rate limiting
// 4. resourceGuard() → cross-tenant access prevention

// Prisma middleware for automatic tenant scoping
prisma.$use(async (params, next) => {
  const tenantId = AsyncLocalStorage.getStore()?.tenantId;
  if (!tenantId) throw new Error('No tenant context');

  // Inject WHERE clause for all queries
  if (params.action === 'findMany' || params.action === 'findFirst') {
    params.args.where = { ...params.args.where, orgId: tenantId };
  }
  // Inject orgId for all creates
  if (params.action === 'create') {
    params.args.data = { ...params.args.data, orgId: tenantId };
  }
  return next(params);
});
```

**Level 3: MongoDB Sharding (Data Plane)**

```typescript
// Sessions and messages sharded by orgId
// All queries MUST include orgId in filter
const sessions = await SessionModel.find({
  orgId: tenantId, // REQUIRED — queries without this are rejected
  projectId,
});

// Shard key: { orgId: 1, projectId: 1 }
// Guarantees queries hit single shard for a tenant
```

### Per-Tenant Configuration Overrides

Tenants can override platform defaults based on their plan:

```typescript
interface TenantConfig {
  tenantId: string;
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';

  // Override platform defaults
  limits: {
    maxConcurrentSessions: number; // FREE: 5, ENTERPRISE: unlimited
    maxServiceTimeoutMs: number; // FREE: 10000, ENTERPRISE: 60000
    maxResponseBodyBytes: number; // FREE: 512KB, ENTERPRISE: 10MB
    maxConcurrentServiceCalls: number; // FREE: 3, ENTERPRISE: 50
    maxPendingTimers: number; // FREE: 100, ENTERPRISE: 100000
    maxAgentsPerProject: number; // FREE: 3, ENTERPRISE: unlimited
    maxEventTypesPerApp: number; // FREE: 10, ENTERPRISE: 200
  };

  // Security overrides
  security: {
    allowedServiceDomains: string[]; // Tenant-specific allowlist
    requireMtls: boolean; // ENTERPRISE only
    ipAllowlist?: string[]; // ENTERPRISE only
    requireMfa: boolean; // BUSINESS+ only
  };

  // Feature flags per plan
  features: {
    customModels: boolean; // BUSINESS+ only
    ssoEnabled: boolean; // BUSINESS+ only
    auditLogExport: boolean; // ENTERPRISE only
    dataResidency: boolean; // ENTERPRISE only
    dedicatedInfra: boolean; // ENTERPRISE only
  };
}

// Default configs per plan
const PLAN_DEFAULTS: Record<Plan, TenantConfig['limits']> = {
  FREE: {
    maxConcurrentSessions: 5,
    maxServiceTimeoutMs: 10000,
    maxResponseBodyBytes: 524288,
    maxConcurrentServiceCalls: 3,
    maxPendingTimers: 100,
    maxAgentsPerProject: 3,
    maxEventTypesPerApp: 10,
  },
  TEAM: {
    /* ... */
  },
  BUSINESS: {
    /* ... */
  },
  ENTERPRISE: {
    maxConcurrentSessions: -1, // unlimited
    maxServiceTimeoutMs: 60000,
    maxResponseBodyBytes: 10485760,
    maxConcurrentServiceCalls: 50,
    maxPendingTimers: 100000,
    maxAgentsPerProject: -1,
    maxEventTypesPerApp: 200,
  },
};
```

### Audit Trail for Access Checks

Every permission check emits an audit event:

```typescript
interface AccessAuditEvent {
  timestamp: Date;
  tenantId: string;
  actorId: string;
  actorType: 'user' | 'apikey' | 'system';
  action: string; // 'read' | 'write' | 'delete' | 'admin'
  resourceType: string; // 'project' | 'agent' | 'session' | 'credential'
  resourceId: string;
  result: 'allowed' | 'denied';
  reason?: string; // 'insufficient_role' | 'cross_tenant' | 'rate_limited'
  ip: string;
  userAgent: string;
}

// Audit sink: append-only, immutable
// Chain hashing: each entry includes SHA-256 of previous entry
// Storage: PostgreSQL for recent (90 days), S3 for archive
// Tamper detection: periodic verification of hash chain integrity
```

---

## 20. Circuit Breaking & Resilience

### Current State Assessment

| Component            | Circuit Breaker                  | Status       |
| -------------------- | -------------------------------- | ------------ |
| ServiceNode executor | Full (closed → open → half-open) | Implemented  |
| LLM providers        | None                             | **GAP**      |
| Store adapters       | None                             | **GAP**      |
| Timer service        | None                             | **GAP**      |
| Event emitters       | None                             | Low priority |

### Circuit Breaker Architecture

#### State Machine

```
                 ┌──────────────────────────┐
                 │                          │
     success     │      CLOSED              │  failure_count >= threshold
    ┌────────────│  (normal operation)       │──────────────────┐
    │            │  Track: success/failure   │                  │
    │            │  Window: sliding 60s      │                  ▼
    │            └──────────────────────────┘         ┌─────────────────┐
    │                       ▲                         │                 │
    │                       │                         │     OPEN        │
    │              probe    │ success                  │  (fast-fail)    │
    │              succeeds │                         │  Duration: 30s  │
    │                       │                         │  Return: fallback│
    │            ┌──────────┴─────────────┐          └────────┬────────┘
    │            │                        │                   │
    └───────────▶│     HALF-OPEN          │                   │
                 │  (probe mode)          │◀──────────────────┘
                 │  Allow 1 request       │    timeout expires
                 │  If fails → OPEN       │
                 └────────────────────────┘
```

#### Configuration (per SERVICE / per LLM provider)

```yaml
# In CONNECTIONS block or EXECUTION block
CONNECTIONS:
  saludsa_api:
    base_url: 'https://api.saludsa.com.ec'
    circuit_breaker:
      failure_threshold: 5 # Failures before opening
      success_threshold: 3 # Successes in half-open before closing
      timeout_ms: 30000 # Time in open state before probing
      window_ms: 60000 # Sliding window for failure counting
      monitor_timeouts: true # Count timeouts as failures
      fallback: 'cached' # "cached" | "default" | "error" | "degrade"

EXECUTION:
  model:
    provider: 'azure_openai'
    circuit_breaker:
      failure_threshold: 3
      timeout_ms: 60000
      fallback: 'downgrade' # Try next model tier
      fallback_model: 'gpt-4o-mini' # Specific fallback model
```

#### LLM Provider Circuit Breaker

```typescript
interface LLMCircuitBreaker {
  // Per-provider state (shared across sessions for same tenant)
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastStateChange: number;

  // Configuration
  config: {
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
    windowMs: number;
    monitorTimeouts: boolean;
  };

  // Fallback strategy
  fallback: LLMFallbackStrategy;
}

type LLMFallbackStrategy =
  | { type: 'downgrade'; targetTier: 'fast' | 'balanced' }
  | { type: 'alternate_provider'; provider: string; model: string }
  | { type: 'cached_response' } // Return last known good response pattern
  | { type: 'error'; message: string };

// Implementation in UnifiedLLMProvider
class ResilientLLMProvider {
  private breakers: Map<string, LLMCircuitBreaker> = new Map();

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const key = `${request.tenantId}:${request.provider}:${request.model}`;
    const breaker = this.getOrCreateBreaker(key, request.circuitConfig);

    if (breaker.state === 'open') {
      if (Date.now() - breaker.lastStateChange > breaker.config.timeoutMs) {
        breaker.state = 'half-open';
        breaker.successCount = 0;
      } else {
        return this.executeFallback(breaker.fallback, request);
      }
    }

    try {
      const response = await this.provider.complete(request);
      this.recordSuccess(breaker);
      return response;
    } catch (error) {
      this.recordFailure(breaker, error);
      if (breaker.state === 'open') {
        return this.executeFallback(breaker.fallback, request);
      }
      throw error;
    }
  }
}
```

#### Persistent Circuit Breaker State

Circuit breaker state must survive server restarts and be shared across instances:

```typescript
// Store in Redis for cross-instance sharing
interface CircuitBreakerStore {
  // Key: cb:{tenantId}:{resourceType}:{resourceId}
  getState(key: string): Promise<CircuitBreakerState>;
  setState(key: string, state: CircuitBreakerState, ttlMs: number): Promise<void>;

  // Atomic failure counting (prevents race conditions)
  incrementFailure(key: string, windowMs: number): Promise<number>;
  incrementSuccess(key: string): Promise<number>;
  resetCounters(key: string): Promise<void>;
}

// Redis implementation
class RedisCircuitBreakerStore implements CircuitBreakerStore {
  async incrementFailure(key: string, windowMs: number): Promise<number> {
    const failKey = `${key}:failures`;
    const pipe = this.redis.pipeline();
    pipe.incr(failKey);
    pipe.pexpire(failKey, windowMs);
    const results = await pipe.exec();
    return results[0][1] as number;
  }
}
```

#### Circuit Breaker Observability

```typescript
// Events emitted for monitoring
type CircuitBreakerEvent =
  | { type: 'circuit_opened'; resource: string; failureCount: number; tenantId: string }
  | { type: 'circuit_closed'; resource: string; tenantId: string }
  | { type: 'circuit_half_open'; resource: string; tenantId: string }
  | { type: 'fallback_executed'; resource: string; strategy: string; tenantId: string }
  | { type: 'probe_success'; resource: string; tenantId: string }
  | { type: 'probe_failure'; resource: string; tenantId: string };

// Dashboard metrics
// - Circuit state per service/provider per tenant
// - Fallback execution rate
// - Mean time in open state
// - Failure rate trending
```

---

## 21. Enterprise Authentication & Authorization

### Current State Assessment

| Feature                        | Status            | Gap                     |
| ------------------------------ | ----------------- | ----------------------- |
| Google OAuth                   | Implemented       | Only SSO provider       |
| JWT with refresh tokens        | Implemented       | No reuse detection      |
| Device Auth Flow (RFC 8628)    | Implemented       | CLI only                |
| API Key authentication         | Schema defined    | No scope enforcement    |
| RBAC (4 roles, 17 permissions) | Middleware exists | Not wired to all routes |
| Enterprise LLM Auth (7 types)  | Implemented       | No token refresh retry  |

### SSO / SAML / OIDC Integration

```typescript
// Multi-provider SSO configuration per tenant
interface SSOConfig {
  tenantId: string;
  provider: 'saml' | 'oidc' | 'azure_ad' | 'okta' | 'google_workspace';
  enabled: boolean;

  // SAML 2.0
  saml?: {
    entityId: string;
    ssoUrl: string;
    sloUrl?: string; // Single Logout
    certificate: string; // IdP X.509 cert (encrypted at rest)
    signRequests: boolean;
    nameIdFormat: 'email' | 'persistent' | 'transient';
    attributeMapping: {
      email: string; // e.g., 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
      name: string;
      groups?: string; // For automatic role mapping
    };
  };

  // OIDC
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string; // Encrypted at rest (AES-256-GCM)
    scopes: string[]; // ['openid', 'profile', 'email', 'groups']
    discoveryUrl?: string; // /.well-known/openid-configuration
    tokenEndpoint?: string;
    userInfoEndpoint?: string;
    jwksUri?: string;
  };

  // Enforcement
  enforcement: {
    requireSso: boolean; // Block password/OAuth login
    autoProvision: boolean; // Create user on first SSO login
    groupRoleMapping: Record<string, Role>; // AD group → ABL role
    defaultRole: Role;
    sessionMaxAge: number; // Force re-auth after N seconds
    allowedDomains: string[]; // Email domain restrictions
  };
}
```

### Multi-Factor Authentication (MFA)

```typescript
interface MFAConfig {
  tenantId: string;
  required: boolean; // Enforced for all users
  requiredForRoles: Role[]; // e.g., ['OWNER', 'ADMIN']
  allowedMethods: MFAMethod[];
  gracePeriodDays: number; // Days before enforcement
}

type MFAMethod =
  | { type: 'totp'; issuer: string } // Authenticator app
  | { type: 'webauthn' } // Hardware key / passkey
  | { type: 'sms'; provider: string } // SMS (backup only)
  | { type: 'recovery_codes'; count: number };

// MFA enrollment flow
// 1. User enables MFA → generate TOTP secret or WebAuthn challenge
// 2. User verifies with code/key
// 3. Generate recovery codes (encrypted, stored once)
// 4. On login: JWT issued only after MFA challenge passes
// 5. Recovery codes: single-use, hashed (bcrypt), max 10
```

### Refresh Token Security

```typescript
interface RefreshTokenPolicy {
  // Rotation: every refresh issues new token pair
  rotateOnRefresh: true;

  // Reuse detection: if old token is used again, revoke entire family
  reuseDetection: {
    enabled: true;
    action: 'revoke_family'; // Revoke all tokens in family
    alertOnReuse: true; // Emit security event
  };

  // Token family tracking
  // Each login creates a "family" of tokens
  // If a token is reused (replay attack), all family tokens are invalidated
  familyTracking: {
    maxFamilySize: 50; // Max rotations before forced re-login
    maxConcurrentFamilies: 5; // Max active sessions per user
  };

  // Absolute expiry (cannot be extended by refresh)
  absoluteLifetime: '7d'; // Force re-login after 7 days
  slidingLifetime: '24h'; // Refresh token valid for 24h from last use
}
```

### API Key Scope Enforcement

```typescript
// Scopes follow resource:action pattern
type ApiScope =
  | 'agents:read'
  | 'agents:write'
  | 'agents:deploy'
  | 'sessions:read'
  | 'sessions:write'
  | 'sessions:delete'
  | 'projects:read'
  | 'projects:write'
  | 'credentials:read'
  | 'credentials:write'
  | 'analytics:read'
  | 'audit:read'
  | 'admin:*';

// Scope enforcement middleware
function requireScope(...requiredScopes: ApiScope[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.authType === 'apikey') {
      const hasScope = requiredScopes.every(
        (scope) => req.apiKey.scopes.includes(scope) || req.apiKey.scopes.includes('admin:*'),
      );
      if (!hasScope) {
        auditLog('apikey.scope_denied', {
          keyId: req.apiKey.id,
          required: requiredScopes,
          actual: req.apiKey.scopes,
        });
        return res.status(403).json({
          error: 'Insufficient scope',
          required: requiredScopes,
        });
      }
    }
    next();
  };
}

// Usage on routes
router.get('/agents', requireScope('agents:read'), listAgents);
router.post('/agents/:id/deploy', requireScope('agents:deploy'), deployAgent);
router.delete('/sessions/:id', requireScope('sessions:delete'), deleteSession);
```

### Service Account Provisioning

```typescript
// Machine-to-machine authentication for CI/CD, monitoring, integrations
interface ServiceAccount {
  id: string;
  tenantId: string;
  name: string; // 'ci-deploy-bot', 'monitoring-agent'
  type: 'ci_cd' | 'monitoring' | 'integration' | 'custom';
  credentials: {
    clientId: string;
    clientSecretHash: string; // SHA-256
    grantType: 'client_credentials'; // OAuth 2.0 client credentials flow
  };
  scopes: ApiScope[];
  ipAllowlist?: string[]; // Optional IP restriction
  rateLimitOverride?: number; // Custom rate limit
  expiresAt?: Date; // Optional expiry for temporary access
  createdBy: string;
  lastUsedAt?: Date;
}
```

---

## 22. Enterprise Security & Key Management

### Current State Assessment

| Feature                                 | Status      | Gap                    |
| --------------------------------------- | ----------- | ---------------------- |
| AES-256-GCM encryption                  | Implemented | No key rotation        |
| PBKDF2 key derivation (100K iterations) | Implemented | No HSM integration     |
| Per-user encryption keys                | Implemented | No master key rotation |
| PII detection (email, phone, SSN, CC)   | Implemented | Not wired to pipeline  |
| Secret masking in traces                | Partial     | ENV secrets only       |

### Key Rotation Architecture

```typescript
// Three layers of key rotation:
// 1. Master key rotation (platform-level)
// 2. Tenant key rotation (per-organization)
// 3. Credential key rotation (per-credential)

interface KeyRotationPolicy {
  // Master encryption key
  masterKey: {
    rotationIntervalDays: 90;
    algorithm: 'AES-256-GCM';
    source: 'env' | 'aws_kms' | 'azure_keyvault' | 'hashicorp_vault';
    // During rotation, both old and new keys are active for decryption
    // New encryptions use new key
    // Background job re-encrypts existing data with new key
    gracePeriodDays: 7;
  };

  // Per-tenant data encryption key (DEK)
  tenantKey: {
    derivation: 'PBKDF2-SHA512';
    iterations: 100000;
    rotationIntervalDays: 180;
    // Encrypted with master key (envelope encryption)
    // Rotation: generate new DEK, re-encrypt all tenant data
  };

  // API key rotation
  apiKey: {
    maxAgeDays: 365;
    warningDays: 30; // Warn before expiry
    forceRotationOnCompromise: true;
    // Rotation: issue new key, old key valid for gracePeriod
    gracePeriodHours: 24;
  };

  // LLM credential rotation
  llmCredential: {
    // Depends on provider policy
    checkIntervalHours: 24;
    alertOnExpiry: true;
    // OAuth tokens: auto-refresh before expiry
    oauthRefreshBufferSeconds: 300;
  };
}
```

#### Envelope Encryption

```
┌──────────────────────────────────────────────┐
│                KEY HIERARCHY                   │
│                                                │
│  ┌──────────────┐                              │
│  │  Master Key   │ ← HSM / KMS / ENV          │
│  │  (KEK)       │                              │
│  └──────┬───────┘                              │
│         │ encrypts                             │
│         ▼                                      │
│  ┌──────────────┐                              │
│  │  Tenant DEK   │ ← Per-org, derived via      │
│  │  (Data Key)  │   PBKDF2(master, orgId,salt) │
│  └──────┬───────┘                              │
│         │ encrypts                             │
│         ▼                                      │
│  ┌──────────────────────────────────────┐     │
│  │  LLM Credentials                     │     │
│  │  API Keys                             │     │
│  │  SSO Secrets                          │     │
│  │  Session PII (if HIPAA/PCI)           │     │
│  │  Webhook Secrets                      │     │
│  └──────────────────────────────────────┘     │
└──────────────────────────────────────────────┘
```

#### Key Rotation Procedure

```typescript
class KeyRotationService {
  // Step 1: Generate new master key version
  async rotateMasterKey(): Promise<void> {
    const newKeyVersion = await this.kms.generateKey('AES-256-GCM');

    // Step 2: Mark new key as active, old key as decrypt-only
    await this.db.keyVersions.create({
      version: newKeyVersion.id,
      status: 'active',
      createdAt: new Date(),
    });
    await this.db.keyVersions.update({
      where: { status: 'active', version: { not: newKeyVersion.id } },
      data: { status: 'decrypt_only' },
    });

    // Step 3: Background job re-encrypts all DEKs with new master
    await this.queue.enqueue('re-encrypt-deks', {
      newKeyVersion: newKeyVersion.id,
      batchSize: 100,
    });

    // Step 4: After grace period, delete old key version
    await this.scheduler.schedule(
      'delete-old-key',
      { version: newKeyVersion.id },
      { delay: `${this.policy.masterKey.gracePeriodDays}d` },
    );
  }

  // Step 5: Re-encrypt data in batches (non-blocking)
  async reEncryptBatch(oldVersion: string, newVersion: string, offset: number): Promise<void> {
    const credentials = await this.db.llmCredentials.findMany({
      where: { keyVersion: oldVersion },
      skip: offset,
      take: 100,
    });

    for (const cred of credentials) {
      const plaintext = await this.decrypt(cred.encryptedData, oldVersion);
      const newCiphertext = await this.encrypt(plaintext, newVersion);
      await this.db.llmCredentials.update({
        where: { id: cred.id },
        data: { encryptedData: newCiphertext, keyVersion: newVersion },
      });
    }
  }
}
```

### HSM Integration

```typescript
// Hardware Security Module abstraction
interface HSMProvider {
  type: 'aws_kms' | 'azure_keyvault' | 'hashicorp_vault' | 'local';

  // Key operations — private key never leaves HSM
  generateKey(algorithm: string): Promise<{ keyId: string }>;
  encrypt(keyId: string, plaintext: Buffer): Promise<Buffer>;
  decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer>;
  rotateKey(keyId: string): Promise<{ newKeyId: string }>;
  destroyKey(keyId: string): Promise<void>;

  // Audit
  getKeyMetadata(keyId: string): Promise<KeyMetadata>;
  listKeyVersions(keyId: string): Promise<KeyVersion[]>;
}

// AWS KMS implementation
class AWSKMSProvider implements HSMProvider {
  async encrypt(keyId: string, plaintext: Buffer): Promise<Buffer> {
    const result = await this.kms.encrypt({
      KeyId: keyId,
      Plaintext: plaintext,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    });
    return Buffer.from(result.CiphertextBlob!);
  }
}

// Local fallback (development/testing only)
class LocalHSMProvider implements HSMProvider {
  // Uses Node.js crypto — NOT for production
  // Logs warning on initialization
}
```

### Encryption at Rest for Session Data

```typescript
// Sessions may contain PII (customer data collected during conversation)
// HIPAA/PCI environments require field-level encryption

interface SessionEncryptionPolicy {
  // Which fields to encrypt
  encryptedFields: string[]; // ['context.customer_name', 'context.ssn', 'context.email']

  // Detection: auto-detect PII using PII detector
  autoDetect: boolean;
  autoDetectPatterns: PIIPattern[]; // email, phone, ssn, credit_card, custom regex

  // Encryption scope
  scope: 'field_level' | 'full_context' | 'none';

  // Key: tenant DEK (via envelope encryption)
  // Encrypted fields stored as: { __encrypted: true, iv: '...', data: '...' }
}

// In PrismaConversationStore / MongoDB session store:
class EncryptedSessionStore {
  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const policy = await this.getTenantEncryptionPolicy(message.tenantId);

    if (policy.scope === 'field_level') {
      message.content = await this.encryptPIIFields(message.content, policy);
    } else if (policy.scope === 'full_context') {
      message.content = await this.encryptFull(message.content, policy);
    }

    await this.store.save(sessionId, message);
  }

  // Decrypt on read (transparent to caller)
  async getMessages(sessionId: string): Promise<Message[]> {
    const messages = await this.store.getMessages(sessionId);
    return Promise.all(messages.map((m) => this.decryptMessage(m)));
  }
}
```

### Secret Masking in Traces & Logs

```typescript
// All secrets MUST be masked before they reach any sink (logs, traces, events, API responses)

interface SecretMaskingConfig {
  // Patterns to detect and mask
  patterns: {
    envSecrets: true; // Values from ENV with secret: true
    apiKeys: true; // API key values in headers
    bearerTokens: true; // Authorization: Bearer ...
    connectionCredentials: true; // Auth blocks in CONNECTIONS
    piiPatterns: PIIPattern[]; // Email, phone, SSN, CC
  };

  // Masking strategy
  strategy: 'redact' | 'hash' | 'partial';
  // 'redact': Replace with '***REDACTED***'
  // 'hash': Replace with SHA-256 hash (allows correlation without revealing value)
  // 'partial': Show first/last N chars (e.g., 'sk-...7x9f')

  // Where masking is applied
  sinks: ('traces' | 'logs' | 'events' | 'api_responses' | 'error_messages')[];
}

// Implementation: masking interceptor in trace pipeline
class TraceMaskingInterceptor {
  mask(event: TraceEvent): TraceEvent {
    const masked = structuredClone(event);
    // Walk all string values in event.data
    // Apply pattern matching and replacement
    // Return masked copy (never mutate original)
    return this.walkAndMask(masked);
  }
}
```

---

## 23. Data Retention & Compliance

### Current State Assessment

| Feature                        | Status                     | Gap                      |
| ------------------------------ | -------------------------- | ------------------------ |
| Session TTL declared in schema | Schema exists              | No enforcement mechanism |
| Retention cleanup method       | In PrismaConversationStore | Not scheduled/automated  |
| Audit log retention            | Not defined                | No archival strategy     |
| GDPR deletion                  | Not implemented            | No right-to-be-forgotten |
| Trace data retention           | Not defined                | Grows indefinitely       |
| LLM usage records              | ClickHouse TTL (2 years)   | No per-tenant override   |

### Retention Policy Architecture

```typescript
interface RetentionPolicy {
  tenantId: string;
  plan: Plan;

  // Per-data-type retention
  sessions: {
    activeRetentionDays: number; // Keep in hot storage (MongoDB)
    archiveRetentionDays: number; // Keep in cold storage (S3)
    totalRetentionDays: number; // Hard delete after this
    // FREE: 7/0/7, TEAM: 30/60/90, BUSINESS: 90/180/365, ENTERPRISE: custom
  };

  messages: {
    retentionDays: number; // Follows session retention
    piiRetentionDays: number; // PII fields deleted earlier (GDPR)
  };

  traces: {
    hotRetentionDays: number; // MongoDB (full detail)
    analyticsRetentionDays: number; // ClickHouse (aggregated)
    // FREE: 7/30, TEAM: 30/90, BUSINESS: 90/365, ENTERPRISE: custom
  };

  auditLogs: {
    retentionDays: number; // MINIMUM 365 for SOC 2
    archiveStorage: 's3' | 'glacier';
    immutable: true; // Cannot be deleted, even by admin
  };

  llmUsage: {
    detailedRetentionDays: number; // Per-call records
    aggregateRetentionDays: number; // Monthly summaries
    // Detailed: 90 days, Aggregate: forever (billing)
  };

  events: {
    retentionDays: number; // Custom events (from EVENTS block)
    // Follows per-event-type retention declared in ABL
  };
}
```

### Retention Enforcement Mechanism

```typescript
// Scheduled job runs daily per tenant
class RetentionEnforcer {
  // Phase 1: Identify data for deletion/archival
  async planRetention(tenantId: string): Promise<RetentionPlan> {
    const policy = await this.getPolicy(tenantId);
    const now = new Date();

    return {
      sessionsToArchive: await this.findSessionsOlderThan(
        tenantId,
        subDays(now, policy.sessions.activeRetentionDays),
      ),
      sessionsToDelete: await this.findArchivedSessionsOlderThan(
        tenantId,
        subDays(now, policy.sessions.totalRetentionDays),
      ),
      tracesToPurge: await this.findTracesOlderThan(
        tenantId,
        subDays(now, policy.traces.hotRetentionDays),
      ),
      piiFieldsToScrub: await this.findMessagesWithPIIOlderThan(
        tenantId,
        subDays(now, policy.messages.piiRetentionDays),
      ),
    };
  }

  // Phase 2: Execute retention (with audit trail)
  async executeRetention(plan: RetentionPlan): Promise<RetentionReport> {
    const report: RetentionReport = { archived: 0, deleted: 0, scrubbed: 0 };

    // Archive sessions to cold storage BEFORE deletion
    for (const session of plan.sessionsToArchive) {
      await this.archiveToS3(session);
      await this.markArchived(session.id);
      report.archived++;
    }

    // Hard delete expired archived sessions
    for (const session of plan.sessionsToDelete) {
      await this.hardDelete(session.id);
      report.deleted++;
    }

    // Scrub PII from messages (replace with tombstone, keep structure)
    for (const message of plan.piiFieldsToScrub) {
      await this.scrubPII(message.id, message.piiFields);
      report.scrubbed++;
    }

    // Emit audit event
    await this.auditLog('retention.executed', {
      tenantId: plan.tenantId,
      ...report,
    });

    return report;
  }
}
```

### GDPR Right-to-be-Forgotten

```typescript
interface DeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string; // User or admin
  subjectId: string; // User whose data should be deleted
  scope: 'all_data' | 'sessions_only' | 'pii_only';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  slaDeadline: Date; // GDPR: 30 days from request
}

class GDPRDeletionService {
  // SLA: Complete within 30 days of request
  async processDeletionRequest(request: DeletionRequest): Promise<void> {
    // 1. Enumerate all data for subject
    const dataMap = await this.enumerateSubjectData(request.subjectId, request.tenantId);

    // 2. Delete/anonymize based on scope
    if (request.scope === 'all_data') {
      // Sessions, messages, traces, events, context data
      await this.deleteSessionData(dataMap.sessions);
      await this.deleteMessageData(dataMap.messages);
      await this.anonymizeTraces(dataMap.traces);
      await this.deleteEventData(dataMap.events);
      // Anonymize audit logs (cannot delete — compliance)
      await this.anonymizeAuditEntries(dataMap.auditEntries);
    } else if (request.scope === 'pii_only') {
      // Replace PII fields with anonymized values
      await this.scrubAllPII(dataMap);
    }

    // 3. Verify deletion (sampling check)
    const verified = await this.verifyDeletion(request.subjectId, request.tenantId);
    if (!verified) {
      await this.alertAdmins('deletion_verification_failed', request);
      throw new Error('Deletion verification failed');
    }

    // 4. Update request status
    await this.updateRequestStatus(request.id, 'completed');

    // 5. Emit compliance event
    await this.emitComplianceEvent('gdpr.deletion_completed', {
      requestId: request.id,
      subjectId: '[REDACTED]', // Don't log the subject in the event itself
      dataCategories: Object.keys(dataMap),
    });
  }
}
```

### Archival Before Deletion

```typescript
// All data is archived to cold storage before hard deletion
// Archives are encrypted with tenant DEK and stored in S3/GCS

interface ArchivePolicy {
  storage: {
    provider: 's3' | 'gcs' | 'azure_blob';
    bucket: string;
    prefix: '{tenantId}/archives/{year}/{month}/';
    encryption: 'sse-kms'; // Server-side encryption
    storageClass: 'GLACIER_IR'; // Immediate retrieval, low cost
  };

  format: {
    type: 'jsonl.gz'; // Compressed JSON lines
    maxFileSize: '256MB';
    includeMetadata: true;
  };

  // Restore capability
  restore: {
    maxRestoreTimeMinutes: 5; // GLACIER_IR: <5 min
    restoreRetentionDays: 7; // Keep restored copy for 7 days
    requireApproval: true; // Admin approval for restore
  };
}
```

### Audit Log Immutability Verification

```typescript
// Audit logs use blockchain-style hash chaining
// Each entry includes SHA-256 of previous entry
// Periodic verification ensures no tampering

class AuditLogVerifier {
  // Run daily: verify hash chain integrity
  async verifyChain(tenantId: string, startDate: Date, endDate: Date): Promise<VerificationResult> {
    const entries = await this.getAuditEntries(tenantId, startDate, endDate);
    let previousHash = entries[0]?.previousHash || 'GENESIS';

    for (const entry of entries) {
      // Verify this entry's previousHash matches actual previous entry's hash
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          brokenAt: entry.id,
          expectedHash: previousHash,
          actualHash: entry.previousHash,
        };
      }
      // Verify entry hash matches computed hash
      const computed = this.computeHash(entry);
      if (computed !== entry.hash) {
        return {
          valid: false,
          tamperedEntry: entry.id,
          expectedHash: computed,
          actualHash: entry.hash,
        };
      }
      previousHash = entry.hash;
    }

    return { valid: true, entriesVerified: entries.length };
  }

  private computeHash(entry: AuditEntry): string {
    const payload = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      actorId: entry.actorId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      metadata: entry.metadata,
      previousHash: entry.previousHash,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
}
```

### Plan vs. Compliance Conflict Resolution

When a tenant's plan retention (e.g., FREE: 7 days) conflicts with compliance requirements (e.g., SOC 2: 365 days for audit logs):

```typescript
// Compliance ALWAYS wins over plan limits
function resolveRetention(
  planPolicy: RetentionPolicy,
  complianceReqs: ComplianceRequirement[],
): RetentionPolicy {
  const resolved = { ...planPolicy };

  for (const req of complianceReqs) {
    if (req.type === 'soc2') {
      resolved.auditLogs.retentionDays = Math.max(
        resolved.auditLogs.retentionDays,
        365, // SOC 2 minimum
      );
    }
    if (req.type === 'hipaa') {
      resolved.sessions.totalRetentionDays = Math.max(
        resolved.sessions.totalRetentionDays,
        2190, // HIPAA: 6 years
      );
      // Force field-level encryption for session data
      resolved.sessions.encryptionScope = 'field_level';
    }
    if (req.type === 'gdpr') {
      // GDPR: right to deletion, but cannot delete audit logs
      resolved.messages.piiRetentionDays = Math.min(
        resolved.messages.piiRetentionDays,
        resolved.messages.retentionDays, // PII deleted at or before general retention
      );
    }
    if (req.type === 'pci_dss') {
      // PCI: no raw card data storage
      resolved.messages.piiRetentionDays = 0; // Immediate scrub of payment data
      resolved.sessions.encryptionScope = 'field_level';
    }
  }

  return resolved;
}
```

---

## 24. Parser/Compiler/Runtime Modularity

### Extension Plugin Architecture

Each extension is a self-contained module that registers with the core pipeline:

```typescript
// Extension interface
interface ABLExtension {
  name: string;

  // Parser phase: register new tokens and grammar rules
  tokens?: TokenDefinition[];
  parserRules?: (parser: ABLParser) => void;

  // Symbol phase: register named definitions into symbol table
  registerSymbols?: (ast: ParsedAST, symbols: SymbolTable) => void;

  // Validation phase: run static checks
  validate?: (ast: ParsedAST, symbols: SymbolTable, diagnostics: DiagnosticCollector) => void;

  // Compilation phase: transform AST nodes to IR
  compile?: (ast: ParsedAST, symbols: SymbolTable, ir: IRBuilder) => void;

  // Runtime phase: register executors
  executor?: (config: RuntimeConfig) => StepExecutor;
}
```

### File Structure

```
packages/core/src/parser/
  ├── agent-based-parser.ts          # Core agent parsing
  ├── supervisor-parser.ts           # Core supervisor parsing
  ├── expression-parser.ts           # Core expression parsing
  ├── lexer.ts                       # Core lexer
  ├── manifest-parser.ts             # NEW: Project manifest (YAML)
  └── extensions/
      ├── env-parser.ts              # ENV block
      ├── connection-parser.ts       # CONNECTION block
      ├── service-parser.ts          # SERVICE tool type
      ├── map-parser.ts              # MAP block
      ├── pipe-parser.ts             # Pipe expressions
      ├── validate-parser.ts         # VALIDATE block
      ├── template-parser.ts         # TEMPLATE block
      ├── event-schema-parser.ts     # EVENTS schema
      ├── switch-parser.ts           # SWITCH step
      ├── counter-parser.ts          # COUNTER operation
      ├── wait-parser.ts             # WAIT / INACTIVITY_TIMEOUT
      ├── execution-parser.ts        # EXECUTION block
      └── messages-parser.ts         # MESSAGES block

packages/compiler/src/platform/
  ├── ir/
  │   ├── compiler.ts                # Core compilation orchestrator
  │   ├── schema.ts                  # Core IR types
  │   └── extensions/
  │       ├── env-compiler.ts
  │       ├── connection-compiler.ts
  │       ├── service-compiler.ts
  │       ├── map-compiler.ts
  │       ├── pipe-compiler.ts
  │       ├── template-compiler.ts
  │       ├── event-compiler.ts
  │       ├── execution-compiler.ts
  │       └── messages-compiler.ts
  ├── validators/                    # NEW: Validation passes
  │   ├── reference-validator.ts     # Pass 1: Undefined references
  │   ├── type-validator.ts          # Pass 2: Type compatibility
  │   ├── limit-validator.ts         # Pass 3: Platform limits
  │   ├── flow-validator.ts          # Pass 4: Step reachability
  │   ├── event-validator.ts         # Pass 5: EMIT conformance
  │   ├── security-validator.ts      # Pass 6: SSRF, ReDoS, secrets
  │   └── consistency-validator.ts   # Pass 7: Cross-reference consistency
  ├── constants.ts                   # NEW: Shared constants (replaces magic strings)
  └── constructs/
      └── executors/
          ├── flow-executor.ts       # Core flow execution
          ├── gather-executor.ts     # Core gather execution
          ├── service-executor.ts    # NEW: HTTP call execution
          ├── map-executor.ts        # NEW: MAP lookup
          ├── pipe-executor.ts       # NEW: Pipe evaluation
          ├── timer-executor.ts      # NEW: WAIT/INACTIVITY (evict+resume)
          ├── counter-executor.ts    # NEW: COUNTER operations
          └── event-executor.ts      # NEW: EMIT with schema validation

apps/platform/src/services/
  ├── runtime-executor.ts            # Core runtime (slimmed down)
  ├── session-store.ts               # NEW: Persistent session store
  ├── timer-service.ts               # NEW: Scheduled resume service
  ├── env-loader.ts                  # NEW: ENV resolution
  ├── mock-tools.ts                  # MOVED: Mock tools (test-only)
  └── extensions/
      ├── service-runtime.ts         # HTTP execution with tenant isolation
      ├── cache-runtime.ts           # Tenant-namespaced caching
      └── event-runtime.ts           # Event emission and storage
```

---

## 25. Remaining Gaps & Future Work

These are gaps identified in this session that are **not addressed** by the extensions above and need separate design tracks:

### 25.1 Voice / Real-Time Support

- Voice Activity Detection (VAD)
- Filler messages during processing
- Streaming response delivery
- Voice persona configuration
- Real-time WebSocket integration
- **Separate design document recommended**

### 25.2 Knowledge / RAG Integration

- Knowledge base tool type
- Document ingestion pipeline
- Retrieval-augmented generation
- Citation and source tracking
- **Separate design document recommended**

### 25.3 Feature Flags

- Enable/disable individual tools per deployment
- Enable/disable agents per deployment
- A/B testing between flow variants
- Gradual rollout support
- **Proposed syntax**:

```
FEATURE_FLAGS:
  new_validation_flow:
    enabled: true
    rollout: 50%
  legacy_queue_routing:
    enabled: false
```

### 25.4 Conversation Summary

- Auto-generated summary at session end
- Summary passed to handoff context
- Summary included in escalation events
- Needs LLM call — cost consideration
- **Could be a built-in TEMPLATE + EMIT pattern**

### 25.5 Consent / Compliance Gating

- GDPR/LPD consent tracking
- Consent required before data collection
- Consent revocation handling
- Data retention policy per consent type
- **Could be a flow pattern with SERVICE + COUNTER, but may warrant first-class support**

### 25.6 Multi-Locale Support

- Per-locale MESSAGES, TEMPLATES, VALIDATE patterns
- Locale detection from user input
- Locale fallback hierarchy (es-EC → es → default)
- **Builds on MESSAGES and TEMPLATE extensions; needs locale context variable**

### 25.7 Webhook Inbound (External Event Triggers)

- Receive callbacks from external services
- Resume suspended sessions on external events
- Payment confirmation callbacks
- Third-party auth callbacks
- **Separate design document recommended**

---

## 26. Implementation Phases

### Phase 1: Foundation (P0, ~5 days)

**Goal**: Enable per-agent configuration and eliminate domain contamination.

| Task                                          | Files                             | Effort |
| --------------------------------------------- | --------------------------------- | ------ |
| EXECUTION block (parser + compiler + runtime) | Parser, compiler, schema, runtime | 2d     |
| Extract mock tools, replace magic strings     | Runtime, new constants.ts         | 1d     |
| Unify condition evaluator                     | Compiler evaluator, runtime       | 1d     |
| Move auto-injected tools to compile phase     | Compiler, runtime                 | 1d     |

**Tests**: ~60 new tests

### Phase 2: Service Integration (P0, ~5 days)

**Goal**: Replace all inline code with declarative HTTP.

| Task                                                                    | Files                                                       | Effort |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| ENV block                                                               | Parser ext, compiler ext, env-loader                        | 1d     |
| CONNECTIONS block (with circuit breaker config)                         | Parser ext, compiler ext, schema                            | 1d     |
| SERVICE tool type (full: methods, query, auth, response mapping, retry) | Parser ext, compiler ext, service-executor, service-runtime | 2d     |
| CACHE directive on SERVICE                                              | Cache-runtime, schema                                       | 1d     |

**Tests**: ~50 new tests

### Phase 3: Data & Control Extensions (P0, ~4 days)

**Goal**: Eliminate remaining code patterns with declarative constructs.

| Task                       | Files                                  | Effort |
| -------------------------- | -------------------------------------- | ------ |
| MAP (lookup tables)        | Parser ext, compiler ext, map-executor | 1d     |
| Pipes (transform chains)   | Pipe-parser, pipe-executor             | 1.5d   |
| COUNTER (atomic increment) | Parser ext, counter-executor           | 0.5d   |
| SWITCH (multi-branch)      | Parser ext, compiles to ON_INPUT       | 1d     |

**Tests**: ~40 new tests

### Phase 4: Messaging & Events (P1, ~4 days)

**Goal**: Externalize all messages, enable analytics.

| Task                                                | Files                                                              | Effort |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| MESSAGES block                                      | Parser ext, compiler ext, replace hardcoded strings                | 1d     |
| TEMPLATE block                                      | Parser ext, compiler ext                                           | 1d     |
| EVENTS schema + EMIT                                | Event-schema-parser, event-compiler, event-executor, event-runtime | 1.5d   |
| Externalize intent keywords and correction patterns | Config files, runtime                                              | 0.5d   |

**Tests**: ~40 new tests

### Phase 5: Modular Projects & Validation (P1, ~4 days)

**Goal**: Multi-file projects with comprehensive error checking.

| Task                                               | Files                             | Effort |
| -------------------------------------------------- | --------------------------------- | ------ |
| Project manifest parser                            | manifest-parser.ts                | 0.5d   |
| Multi-file compilation pipeline                    | Compiler orchestrator             | 1d     |
| 7 validation passes                                | validators/ directory (7 files)   | 2d     |
| VALIDATE block (named validators with ReDoS check) | Parser ext, compiler ext, runtime | 0.5d   |

**Tests**: ~60 new tests

### Phase 6: Timer Infrastructure (P1, ~3 days)

**Goal**: Non-blocking WAIT and INACTIVITY_TIMEOUT.

| Task                                            | Files                                    | Effort |
| ----------------------------------------------- | ---------------------------------------- | ------ |
| Session persistence store                       | session-store.ts                         | 1d     |
| Timer service                                   | timer-service.ts                         | 1d     |
| WAIT / INACTIVITY_TIMEOUT parsing + compilation | Parser ext, compiler ext, timer-executor | 1d     |

**Tests**: ~30 new tests

### Phase 7: Security Hardening (P1, ~3 days)

**Goal**: Multi-tenant safety across all extensions.

| Task                          | Files                                | Effort |
| ----------------------------- | ------------------------------------ | ------ |
| Tenant-scoped caching         | cache-runtime.ts                     | 0.5d   |
| SERVICE URL allowlisting      | security-validator, service-runtime  | 0.5d   |
| Secret masking in traces/logs | Trace emitter, log formatter         | 0.5d   |
| Platform limit configuration  | Platform config schema + enforcement | 0.5d   |
| Per-tenant config overrides   | tenant-config.ts, middleware         | 1d     |

**Tests**: ~30 new tests

### Phase 8: Circuit Breaking & Resilience (P0, ~4 days)

**Goal**: Production-grade resilience for all external dependencies.

| Task                                                      | Files                                          | Effort |
| --------------------------------------------------------- | ---------------------------------------------- | ------ |
| Redis circuit breaker state store                         | circuit-breaker-store.ts                       | 0.5d   |
| LLM provider circuit breaker                              | resilient-llm-provider.ts, unified-provider.ts | 1.5d   |
| Circuit breaker for store adapters                        | store-circuit-breaker.ts                       | 0.5d   |
| Circuit breaker observability (events, dashboard metrics) | circuit-breaker-events.ts                      | 0.5d   |
| Fallback model strategy (downgrade, alternate provider)   | model-router.ts, fallback-strategy.ts          | 1d     |

**Tests**: ~40 new tests

### Phase 9: Enterprise Auth & Authorization (P1, ~5 days)

**Goal**: SSO, MFA, API key scoping, service accounts.

| Task                                 | Files                                     | Effort |
| ------------------------------------ | ----------------------------------------- | ------ |
| SAML 2.0 integration (passport-saml) | saml-provider.ts, sso-routes.ts           | 1.5d   |
| OIDC integration                     | oidc-provider.ts                          | 1d     |
| MFA (TOTP + WebAuthn)                | mfa-service.ts, mfa-routes.ts             | 1d     |
| API key scope enforcement middleware | api-key-scopes.ts, all route files        | 0.5d   |
| Service account provisioning         | service-account.ts, client-credentials.ts | 0.5d   |
| Refresh token reuse detection        | token-family.ts, auth-service.ts          | 0.5d   |

**Tests**: ~50 new tests

### Phase 10: Enterprise Security & Key Management (P1, ~4 days)

**Goal**: Key rotation, HSM integration, encryption at rest.

| Task                                                          | Files                                     | Effort |
| ------------------------------------------------------------- | ----------------------------------------- | ------ |
| Key rotation service (master key, tenant DEK)                 | key-rotation-service.ts                   | 1d     |
| HSM provider abstraction (AWS KMS, local fallback)            | hsm-provider.ts, aws-kms.ts, local-hsm.ts | 1d     |
| Session data encryption (field-level PII)                     | encrypted-session-store.ts                | 1d     |
| Secret masking pipeline (traces, logs, events, API responses) | trace-masking-interceptor.ts              | 0.5d   |
| Envelope encryption implementation                            | envelope-encryption.ts                    | 0.5d   |

**Tests**: ~40 new tests

### Phase 11: Data Retention & Compliance (P1, ~5 days)

**Goal**: Automated retention enforcement, GDPR deletion, audit immutability.

| Task                                                          | Files                                         | Effort |
| ------------------------------------------------------------- | --------------------------------------------- | ------ |
| Retention policy engine                                       | retention-policy.ts, plan-defaults.ts         | 0.5d   |
| Retention enforcement scheduler (daily job)                   | retention-enforcer.ts, retention-scheduler.ts | 1d     |
| GDPR right-to-be-forgotten service                            | gdpr-deletion-service.ts                      | 1d     |
| Archive-before-delete pipeline (S3/GCS)                       | archive-service.ts                            | 1d     |
| Audit log hash chain verification                             | audit-verifier.ts                             | 0.5d   |
| Compliance conflict resolution (plan vs. SOC2/HIPAA/GDPR/PCI) | compliance-resolver.ts                        | 0.5d   |
| Row-level security (PostgreSQL RLS + Prisma middleware)       | rls-policies.sql, prisma-tenant-middleware.ts | 0.5d   |

**Tests**: ~50 new tests

---

### Total Effort

| Phase                                          | Priority | Days        | New Tests     |
| ---------------------------------------------- | -------- | ----------- | ------------- |
| Phase 1: Foundation                            | P0       | 5           | 60            |
| Phase 2: Service Integration                   | P0       | 5           | 50            |
| Phase 3: Data & Control Extensions             | P0       | 4           | 40            |
| Phase 4: Messaging & Events                    | P1       | 4           | 40            |
| Phase 5: Modular Projects & Validation         | P1       | 4           | 60            |
| Phase 6: Timer Infrastructure                  | P1       | 3           | 30            |
| Phase 7: Security Hardening                    | P1       | 3           | 30            |
| Phase 8: Circuit Breaking & Resilience         | P0       | 4           | 40            |
| Phase 9: Enterprise Auth & Authorization       | P1       | 5           | 50            |
| Phase 10: Enterprise Security & Key Management | P1       | 4           | 40            |
| Phase 11: Data Retention & Compliance          | P1       | 5           | 50            |
| **Total**                                      |          | **46 days** | **490 tests** |

### Dependency Graph

```
Phase 1 (Foundation) ──────┬── Phase 2 (Service) ── Phase 3 (Data & Control)
                           │         │
                           │         └── Phase 8 (Circuit Breaking) ◄── requires SERVICE + LLM infra
                           │
                           ├── Phase 4 (Messaging & Events)
                           │
                           ├── Phase 5 (Modular Projects & Validation)
                           │
                           ├── Phase 6 (Timers) ── Phase 7 (Security Hardening)
                           │                              │
                           │                              ├── Phase 9 (Enterprise Auth)
                           │                              │
                           │                              ├── Phase 10 (Key Management)
                           │                              │
                           │                              └── Phase 11 (Retention & Compliance)
                           │
                           └── Phase 8 can start in parallel with Phase 2
```

**Critical path**: Phase 1 → Phase 2 → Phase 8 (Circuit Breaking) for production readiness.

**Parallelization**: After Phase 1 completes:

- Track A: Phases 2 → 3 → 8 (Service + Resilience)
- Track B: Phases 4 → 5 (Messaging + Modular)
- Track C: Phases 6 → 7 → 9 → 10 → 11 (Timers + Security + Enterprise)
