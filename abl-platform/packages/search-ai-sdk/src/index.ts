/**
 * @agent-platform/search-ai-sdk
 *
 * Public client library for calling the Search-AI REST API.
 * Used by ABL Platform, Studio, MCP CLI, and other external consumers.
 *
 * This SDK provides:
 * - REST API client (SearchAIClient)
 * - API request/response types
 * - API error classes
 * - Shared constants (queue names, etc.)
 *
 * Internal implementation details (strategies, stores, embedding providers,
 * vector stores) are NOT exported from this SDK - they live in:
 * - @agent-platform/search-ai-internal (shared internal code)
 * - apps/search-ai/src/ (service-specific implementations)
 */

// Types
export * from './types/index.js';

// Client
export { SearchAIClient, type SearchAIClientConfig, type IngestDocumentResult } from './client.js';

// Errors
export * from './errors.js';

// Constants
export * from './constants.js';
