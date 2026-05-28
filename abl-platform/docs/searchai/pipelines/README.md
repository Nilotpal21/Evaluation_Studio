# Pipeline Documentation

This directory contains all documentation related to the **Flow-Based Pipeline Architecture** for SearchAI's pluggable ingestion pipeline.

## Directory Structure

```
pipelines/
├── rfcs/                # RFC documents (requirements, architecture, design decisions)
├── research/            # Research documents (exploration, options analysis, recommendations)
├── analysis/            # Analysis documents (pre-check explorations of existing codebase)
└── README.md           # This file
```

## RFCs (Request for Comments)

RFC documents contain formal architecture proposals, design decisions, and requirements specifications.

### Main Architecture RFC

- **RFC-004-FLOW-BASED-ARCHITECTURE.md** - Complete flow-based pipeline architecture
  - Requirements (Functional, Non-Functional, Constraints)
  - Architecture design (flows, stages, providers, orchestration)
  - Data models, APIs, validation rules
  - Migration strategy from legacy pipeline
  - Status: ✅ Approved

### Job Tracking Integration

- **RFC-005-Job-Tracking-Architecture.md** - Job execution tracking system
  - Flat schema design for job tracking
  - MongoDB data model for `JobExecution`
  - Performance analysis (handles <1M jobs/day)
  - Status: ✅ Approved

- **RFC-006-Job-Tracking-BullMQ-Flows-Integration.md** - BullMQ Flows integration
  - Integration between BullMQ Flows and job tracking
  - 3 optional fields in job tracking schema
  - 2 indexes for flow queries
  - Status: ✅ Approved

## Research

Research documents explore specific technical topics, evaluate options, and provide recommendations.

### Flow Selection & Configuration

- **RESEARCH-cel-flow-selection.md** - CEL expression evaluation for flow selection
  - Document context structure (9 fields)
  - 40+ example CEL expressions
  - Priority-based flow matching algorithm
  - Fail-safe evaluation strategy

- **RESEARCH-default-flows-templates.md** - Default pipeline instantiation strategy
  - 3 default flow templates (PDF, Office, Default)
  - Smart defaults pattern (stage > flow > pipeline > template)
  - Template instantiation on index creation
  - Index-level customization hooks

### Resilience & Orchestration

- **RESEARCH-circuit-breaker-flow-failures.md** - Circuit breaker strategies for flow failures
  - Three-level strategy (Provider → Stage-Type → Flow)
  - Reuse of existing `@agent-platform/circuit-breaker` package
  - BullMQ integration patterns
  - Fallback hierarchy (provider fallback → stage skip → alternative flow)
  - Configuration recommendations by stage type

- **RESEARCH-bullmq-flows-pipeline-integration.md** - BullMQ Flows integration patterns
  - PipelineFlowBuilder pattern (automated flow generation)
  - Shared queue architecture
  - Per-stage lock duration configuration
  - Mandatory child failure options (`failParentOnFailure`)
  - Flow validation wrapper (Issue #3851 mitigation)
  - Backpressure control (queue depth limits)

### Provider System

- **RESEARCH-pipeline-provider-registry.md** - Provider registry architecture
  - Unified `PipelineStageProvider<TInput, TOutput, TConfig>` interface
  - Type-specific registries (Extraction, Enrichment, Embedding, etc.)
  - Automatic circuit breaker integration at registry level
  - Provider discovery API for Studio UI
  - JSON Schema-based configuration validation
  - Cost estimation interface for UI cost preview

### UI/UX Design

- **RESEARCH-ui-component-libraries-pipeline.md** - UI component libraries for pipeline visual designer
  - **React Flow** for flow visualization (350KB gzipped)
  - **DnD Kit** for drag-and-drop (already in Studio)
  - **React JSON Schema Form** for dynamic config forms (100KB gzipped)
  - **Custom Monaco Editor** for CEL expression builder
  - Total bundle impact: ~450KB gzipped (lazy loaded)
  - 5-week implementation roadmap

## Analysis

Analysis documents capture pre-check explorations of existing codebase patterns to inform design decisions.

### Data & Infrastructure

- **ANALYSIS-data-model-patterns.md** - Existing data model patterns
  - Mongoose schemas, discriminated unions, nested arrays
  - MongoDB indexing strategies
  - Dual-database architecture (MongoDB + OpenSearch)
  - Migration patterns

- **ANALYSIS-bullmq-usage.md** - Existing BullMQ usage patterns
  - Queue configuration, worker patterns
  - Job data structures, retry strategies
  - Lock durations, graceful shutdown patterns

### Expression & Validation

- **ANALYSIS-cel-integration.md** - Existing CEL integration patterns
  - `@marcbachmann/cel-js` v7.5.1 usage
  - 37 custom CEL functions available
  - CEL evaluation patterns in codebase
  - Error handling, validation strategies

- **ANALYSIS-validation-patterns.md** - Existing validation patterns
  - Zod schemas, custom validators
  - IR validation orchestrator
  - Tool DSL 5-phase validation
  - Request → Domain → Runtime validation layers

### Resilience & APIs

- **ANALYSIS-resilience-patterns.md** - Existing resilience patterns
  - Redis circuit breaker (production-ready)
  - Retry handlers (exponential backoff)
  - Fallback executors
  - Rate limiting patterns

- **ANALYSIS-rest-api-patterns.md** - Existing REST API patterns
  - Express.js + Zod validation
  - Mandatory tenant isolation
  - Permission guards (`requirePermission`)
  - CRUD conventions, error response formats

### Provider System

- **ANALYSIS-provider-plugin-registry-patterns.md** - Existing provider/registry patterns
  - 8+ production registries (CircuitBreakerRegistry, GuardrailProviderRegistry, etc.)
  - Registry manages providers pattern
  - Provider interface implementations
  - Circuit breaker integration at registry level
  - TTL and LRU eviction strategies

### UI/UX

- **ANALYSIS-studio-design-system.md** - Studio design system analysis
  - Radix UI primitives + Tailwind CSS
  - Dark theme with violet-tinted neutrals
  - 37 reusable UI components
  - Zustand state management, React Hook Form + Zod
  - Typography, spacing, color system

## Document Status

| Document                                      | Type     | Status      | Date       |
| --------------------------------------------- | -------- | ----------- | ---------- |
| RFC-004-FLOW-BASED-ARCHITECTURE               | RFC      | ✅ Approved | 2026-03-06 |
| RFC-005-Job-Tracking-Architecture             | RFC      | ✅ Approved | 2026-03-04 |
| RFC-006-Job-Tracking-BullMQ-Flows-Integration | RFC      | ✅ Approved | 2026-03-04 |
| RESEARCH-cel-flow-selection                   | Research | ✅ Complete | 2026-03-07 |
| RESEARCH-default-flows-templates              | Research | ✅ Complete | 2026-03-07 |
| RESEARCH-circuit-breaker-flow-failures        | Research | ✅ Complete | 2026-03-07 |
| RESEARCH-bullmq-flows-pipeline-integration    | Research | ✅ Complete | 2026-03-07 |
| RESEARCH-pipeline-provider-registry           | Research | ✅ Complete | 2026-03-07 |
| RESEARCH-ui-component-libraries-pipeline      | Research | ✅ Complete | 2026-03-07 |
| ANALYSIS-data-model-patterns                  | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-cel-integration                      | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-studio-design-system                 | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-bullmq-usage                         | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-rest-api-patterns                    | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-resilience-patterns                  | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-validation-patterns                  | Analysis | ✅ Complete | 2026-03-07 |
| ANALYSIS-provider-plugin-registry-patterns    | Analysis | ✅ Complete | 2026-03-07 |

## Next Steps

**Design Phase:** Now that all research and analysis is complete, proceed with detailed design:

### Backend Design (8 tasks pending)

- Data models (PipelineDefinition, PipelineFlow schemas)
- Flow selection service (CEL evaluation)
- Provider registry implementation
- BullMQ Flows integration (FlowBuilder)
- Pipeline validation service (18 rules)
- Circuit breaker service
- Manual trigger APIs (3 entry points)
- Pipeline CRUD APIs

### Frontend Design (9 tasks pending)

- Pipeline editor UI component architecture
- Dynamic stage configuration forms
- Flow selection rules builder (no-code CEL)
- Live monitoring dashboard (2 views)
- Pipeline validation display
- Manual trigger UI (2 locations)
- Flow simulation UI (test mode)
- Cost estimator UI (per-flow breakdown)

## Related Documentation

- **BULLMQ-FLOWS-PRODUCTION-GUIDE.md** - Production guide for BullMQ Flows (issues, scaling, monitoring)
- **DATABASE-SCHEMA.md** - MongoDB schema reference
- **SERVICES-INVENTORY.md** - 17+ workers catalog

## Contributors

This documentation was created as part of the flow-based pipeline architecture initiative (ABLP-2).
