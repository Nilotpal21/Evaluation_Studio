# Execution Context for Graph Pipelines — Design

## Problem

Compute services (sentiment, intent, mentions, etc.) read conversation data via `config.sourceStep` — a string config field that tells the service which previous step's output to look up in `previousSteps[sourceStep].data`. This creates tight coupling between the service and the node ID of its data source. In graph pipelines, node IDs are user-defined (e.g., `read-conv` vs `read-conversation`), forcing users to manually set `sourceStep` in every compute node's config.

## Solution

Replace `sourceStep` with a shared **execution context** — a flat key-value map accumulated as nodes execute. Each node type declares a `contextKey` (e.g., `conversation`, `sentiment`) that it writes to. Downstream nodes read from well-known keys without knowing which specific node produced the data.

## Data Flow

```
read-conversation executes
  → executionContext.conversation = result.data

compute-sentiment executes
  → reads executionContext.conversation
  → executionContext.sentiment = result.data

node-group (parallel) executes
  → child: compute-sentiment → executionContext.sentiment
  → child: compute-intent → executionContext.intent

store-results executes
  → reads executionContext.sentiment, executionContext.intent
```

## Key Decisions

1. **`contextKey` on node type definitions** — Each node type declares what key it writes to. Stored in the `NodeTypeDefinition` and `NodeTypeDefinitionDoc` types, persisted in `node_type_definitions` MongoDB collection.

2. **Implicit derivation** — If `contextKey` is not explicitly set, derived from the type name by stripping the verb prefix (`read-`, `compute-`, `evaluate-`, `call-`) and converting to camelCase. Example: `compute-tool-effectiveness` → `toolEffectiveness`.

3. **`resolveContextInput` helper** — Services call `resolveContextInput(input, 'conversation')` which checks `executionContext` first (graph), falls back to `previousSteps[sourceStep]` (linear). One function, backward compatible.

4. **Node-group children** — After a node-group completes, the graph walker extracts each child's output and writes to the child's context key. Children also receive the current `executionContext` so they can read from it.

5. **Backward compatibility** — `previousSteps` and `sourceStep` config remain. `executionContext` is optional on `PipelineStepContext`. Linear pipelines are unaffected.

## Context Key Mapping

| Node Type                     | contextKey             |
| ----------------------------- | ---------------------- |
| `read-conversation`           | `conversation`         |
| `read-message-window`         | `messageWindow`        |
| `compute-sentiment`           | `sentiment`            |
| `compute-intent`              | `intent`               |
| `compute-quality`             | `quality`              |
| `compute-mentions`            | `mentions`             |
| `conversation-analyzer`       | `conversationAnalyzer` |
| `compute-toxicity`            | `toxicity`             |
| `compute-tool-effectiveness`  | `toolEffectiveness`    |
| `compute-statistical`         | `statistical`          |
| `compute-predictive-features` | `predictiveFeatures`   |
| `evaluate-metrics`            | `metrics`              |
| `evaluate-policy`             | `policy`               |
| `call-llm`                    | `llmResult`            |
| `store-results`               | —                      |
| `node-group`                  | —                      |

## Changes

1. **Types**: Add `contextKey?: string` to `NodeTypeDefinition`, `NodeTypeDefinitionDoc`, Mongoose schema
2. **Seed data**: Add `contextKey` to producer node types in JSON
3. **New file**: `execution-context.ts` with `deriveContextKey`, `resolveContextInput`, `buildExecutionContext`
4. **Graph walker**: Build `executionContext`, pass to activity router, pass `children` for node-groups
5. **Activity router**: Accept and propagate `executionContext` through to services
6. **Compute services**: Replace `sourceStep` lookup with `resolveContextInput(input, 'conversation')`
7. **Trait cleanup**: Remove `sourceStep` from compute trait
