/**
 * Memory event store implementation - in-memory storage for tests.
 *
 * Simple array-based storage with:
 * - No indexes or optimization
 * - Full IEventStore contract implementation
 * - Test helpers (getAllEvents, clear, etc.)
 * - Behavioral equivalence to ClickHouseEventStore
 */

export { MemoryEventStore, type MemoryEventStoreConfig } from './memory-event-store.js';
