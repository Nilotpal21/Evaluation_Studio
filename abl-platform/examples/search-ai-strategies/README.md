# Search AI Strategies

Three standalone search strategy agents demonstrating different SearchAI query patterns with vocabulary resolution.

## Agents

### aggregation-agent

Handles analytical/aggregation queries by resolving measure and dimension terms via vocabulary, executing aggregations, and validating results.

**Example query:** "What is the total revenue from closed deals in Q4?"

### knowledge-retrieval-agent

Handles semantic/multi-hop knowledge retrieval using vector search with optional vocabulary-based metadata filtering for precision.

**Example query:** "How do I process a refund for an international order?"

### list-query-agent

Handles structured list/filter queries by resolving business terms via vocabulary, constructing metadata filters, and executing structured search.

**Example query:** "Show all open P1 bugs assigned to me"

## Tools

All agents share SearchAI tools:

- `vocabulary_resolve` - Resolve business terms to canonical fields
- `search_aggregate` - Aggregation queries (sum, avg, count, min, max)
- `validate_aggregation` - Validate aggregation results
- `search_hybrid` - Hybrid vector + keyword search
- `search_vector` - Pure semantic search
- `search_structured` - Structured metadata filter queries
- `search_list` - Paginated results with sorting

## Import

```bash
abl import ./examples/search-ai-strategies
```
