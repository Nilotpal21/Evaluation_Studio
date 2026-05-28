/**
 * Event emitters - validates and enqueues events for persistence.
 *
 * Two implementations:
 * - EventEmitter: Standard emitter (validation + enqueue)
 * - ResilientEventEmitter: 3-level failover (queue → direct → WAL)
 */

export { EventEmitter, type EventEmitterConfig } from './event-emitter.js';
export { ResilientEventEmitter, type ResilienceConfig } from './resilient-event-emitter.js';
