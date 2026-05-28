# Airlines Domain

Airline customer service system with a supervisor routing to three specialist agents, powered by SearchAI vocabulary resolution and search tools.

## Architecture

```
Airlines_Supervisor
  |-- Flight_Search     (structured + hybrid search)
  |-- Policy_Advisor    (hybrid + vector search)
  |-- Analytics          (vocabulary + aggregation)
```

## Agents

### Airlines_Supervisor

Routes customer queries to the appropriate specialist based on intent: flight search, policies, or analytics.

### Flight_Search

Translates flight queries into structured metadata filters using vocabulary resolution. Resolves terms like "first class", "domestic flights" to canonical field values.

### Policy_Advisor

Answers airline policy questions (baggage, cancellation, refunds, loyalty) using semantic search over policy documents.

### Analytics

Handles analytical questions about revenue, fares, and operations using vocabulary-resolved aggregation queries.

## Supporting Files

- `search-ai/documents.ts` - 4 realistic airline documents for SearchAI ingestion (operations manual, baggage/fare policy, loyalty guide, in-flight services)
- `search-ai/vocabulary.ts` - 7 vocabulary entries mapping airline terms to metadata filters and aggregation specs

## Import

```bash
abl import ./examples/airlines
```
