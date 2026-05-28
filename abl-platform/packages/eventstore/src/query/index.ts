/**
 * Event query service - wraps IEventReader with caching and convenience methods.
 */

export { EventQueryService, type EventQueryServiceConfig } from './event-query-service.js';
export { RedisCacheProvider, MemoryCacheProvider } from './cache-providers.js';
