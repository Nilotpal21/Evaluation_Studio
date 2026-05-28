/**
 * Mapping Suggestion Service
 *
 * LLM-powered field mapping suggestions with Redis-backed circuit breaker.
 */

export {
  MappingSuggestionService,
  mappingSuggestionService,
  type MappingSuggestion,
  type MappingSuggestionRequest,
  type MappingSuggestionResponse,
  type CircuitStatusResponse,
} from './mapping-suggestion.service.js';

export { getCircuitBreakerRegistry } from './circuit-breaker-registry.js';
