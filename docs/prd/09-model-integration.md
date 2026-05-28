# 09 — Model Integration (BYOM)

**Implements BRD §9.19 Model Integration. CU Admin surface.**

The Model Integration screen lets a CU Admin configure which LLMs the platform uses, per purpose. Supports platform-default, BYOM via API keys, and BYOM via custom API endpoints.

**Route:** `/models`

## Page header

- H1: *"Model Integration"*
- Sub: *"Configure which models serve each platform function. Bring your own provider via API key, or connect a custom endpoint."*
- Right side:
  - **Add endpoint** primary button
  - Kebab menu: "Set a default configuration," "Test all endpoints," "View per-model usage report"

## Configuration overview (top band)

A horizontal strip showing the current configuration at a glance.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Configuration:  Custom (BYOM)                                          │
│                                                                         │
│  Routing             →  Anthropic Claude Haiku (Platform default)       │
│  Response generation →  Azure OpenAI GPT-4o (Cornerstone tenant, us-east) │
│  AI Helper           →  Anthropic Claude Sonnet (your API key)          │
│  Embedding (KB)      →  Azure OpenAI text-embedding-3-large (your tenant) │
│  Evaluation grading  →  Platform default                                │
└─────────────────────────────────────────────────────────────────────────┘
```

Each row is a small card. The right side of each row has a "Change" button that opens a Sheet to reassign that purpose to a different endpoint.

## Endpoints list

Title: *"Configured endpoints"* + small *"(7 endpoints)"* count

A grid of endpoint cards (similar visual to knowledge sources but smaller).

Each card:
- Provider logo or icon (OpenAI, Anthropic, Azure, AWS Bedrock, Google, Custom)
- Endpoint name (mono, e.g., `cornerstone-azure-gpt4o`)
- Mode chip: `API key` / `OpenAI-compatible` / `Declared contract` / `Platform default`
- Model identifier (mono, e.g., `gpt-4o`, `claude-3.7-sonnet`, `llama-3.1-70b-instruct`)
- Region (e.g., `us-east-1`)
- Status dot + label: `Healthy` / `Degraded` / `Down` / `Fallback active`
- Stats row: latency p95 · cost per 1k tokens · health-check last run
- Purposes assigned: pills showing which functions use this endpoint
- Hover actions: "Test connection," "View metrics," kebab → "Edit," "Disable," "Remove"

## Endpoint detail Sheet

Click a card → Sheet opens with detail.

### Identity & connection
- Name (editable)
- Provider (read-only after creation)
- Mode (read-only)
- Region (editable for managed providers)
- Model identifier (editable — dropdown of available models)
- Credential reference (e.g., *"Vault entry: cornerstone-azure-2026"*; "Rotate" button decorative)
- Custom URL + auth (for custom endpoints; editable)

### Capability matrix (FR-MOD-10)
A small table showing the model's declared capabilities:

| Capability | Supported |
|---|---|
| Tool use | ✓ |
| JSON mode | ✓ |
| Vision | ✗ |
| Long context (>128k) | ✓ |

If a capability is required by an app currently using this endpoint and not supported, a warning callout appears: *"`fraud-triage` requires vision but this endpoint doesn't support it. Either disable vision in that app or assign a vision-capable endpoint."*

### Purposes assigned
Multi-select chips: Routing · Response generation · AI Helper · Embedding · Evaluation grading
- Greyed-out for purposes incompatible with the model's capabilities

### Data residency & compliance (FR-MOD-07, FR-MOD-08)
- Region declared: *"us-east-1"*
- *"Inference shall not occur outside us-east-1."*
- *"BAA / DPA inheritance: this endpoint operates under Cornerstone's existing BAA with Microsoft Azure."*

### Fallback configuration (FR-MOD-09)
- *"If this endpoint is unavailable, fall back to:"*
- Picker with options: another configured endpoint OR "Platform default"
- *"Fallback events will be audited."*

### Performance metrics
- Charts: latency p50/p95, error rate, cost per request — 24-hour series
- Per-app usage breakdown (which apps used this endpoint how many times)

### Audit panel
- Last 5 audit entries for this endpoint

## Add endpoint Dialog

Triggered by **Add endpoint**. Multi-step.

### Step 1 — Choose mode

Four-card chooser:
1. **API key — managed provider** (icon-grid: OpenAI / Anthropic / Azure OpenAI / AWS Bedrock / Google Vertex AI / Cohere / Mistral)
2. **OpenAI-compatible endpoint** (Lucide `Plug`) — *"For self-hosted models (vLLM, TGI, LM Studio, Ollama) or internal gateways"*
3. **Custom API (declared contract)** (Lucide `FileCode`) — *"For non-OpenAI-compatible models. You'll provide a request/response contract."*
4. **Platform default** (Lucide `Sparkles`) — *"Use the platform team's curated model selection. No configuration needed."*

### Step 2 — Configure (varies)

**API key — managed provider:**
- Provider selected from step 1 displayed
- Endpoint name (text input)
- API key (password input; *"Stored in your tenant vault. Encrypted at rest. Rotation supported via FR-MOD-06."*)
- Region picker
- Model identifier picker (dropdown populated based on provider)
- For Azure OpenAI / Bedrock / Vertex: account/tenant identifier inputs (these clarify it's BYOM into the customer's cloud account)

**OpenAI-compatible endpoint:**
- Endpoint URL input
- Auth method: Bearer token / API key / Signed request
- Auth credential input
- Model identifier (free text)
- Test connection button → 2s loader → success/fail badge

**Custom API (declared contract):**
- URL + auth (as above)
- Request/response contract: a code-style textarea for JSON schema (mocked — just visual)
- Adapter selection: *"Use generic adapter"* (default) or *"Custom adapter (Platform Team)"*

### Step 3 — Capabilities

Checkboxes for declared capabilities:
- Tool use · JSON mode · Vision · Long context

### Step 4 — Assign purposes

Multi-select: Routing · Response generation · AI Helper · Embedding · Evaluation grading

### Step 5 — Confirm

Summary + "Add endpoint" primary action.
- Toast confirmation
- Endpoint card appears in the list
- If assigned a purpose, the configuration overview updates accordingly

## Configuration overview "Change" Sheet

When clicking "Change" on a row in the top band:
- Lists all endpoints that *could* serve that purpose (filtered by capability match)
- Radio selection
- "Apply" button
- *"Changes take effect immediately. Continuous evaluation will flag behavior shifts."*

## States to render

- **Default (BYOM hybrid)** — mix of platform default and customer endpoints, per the configuration overview shown above
- **Platform default only** — all rows in overview point to platform default; endpoints list has just one row (the curated default)
- **One endpoint degraded** — its card shows degraded badge, fallback "active" badge if fallback is configured
- **Capability mismatch warning** — at least one app's required capability isn't met by its currently assigned endpoint (warning banner at the top of the page)

## Click model

| Element | Action |
|---|---|
| Configuration overview "Change" | Opens Change Sheet listing compatible endpoints |
| Endpoint card | Opens detail Sheet |
| Test connection (anywhere) | 2s loader → success/fail badge |
| Sync / rotate / remove | Confirmation Dialog → status change |
| Add endpoint | Opens multi-step Dialog |
| "Test all endpoints" (kebab) | Toast: "Running 7 health checks…" then "All endpoints healthy" |
| Capability warning banner | Click → opens the offending endpoint's detail with the capability matrix highlighted |

## Out of scope

- Real LLM calls (test connection is mocked).
- Real credential storage (visual only).
- Real cost / latency telemetry (mocked from `models.ts`).
- Real fallback execution (visual state only).
- Real per-app usage attribution (mocked).

## Acceptance criteria

- Configuration overview reflects current per-purpose assignments.
- Endpoints list renders 7 cards with correct status, mode, region, model identifier.
- Endpoint detail Sheet renders all panels with mock data.
- Capability matrix correctly indicates supported/unsupported.
- Capability mismatch warning surfaces when applicable.
- Add endpoint Dialog walks all 5 steps end-to-end.
- Fallback config can be set in the detail Sheet.
- "Change" Sheet for purpose reassignment filters by capability.
