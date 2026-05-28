/**
 * Remote event store clients - HTTP clients for standalone service mode.
 *
 * Used when runtime pods operate in 'remote' mode:
 * - Writes go to event queue (BullMQ/Kafka)
 * - Reads go to remote service via HTTP (RemoteEventQueryClient)
 * - Retention/GDPR go to remote service via HTTP (RemoteEventLifecycleClient)
 */

export { RemoteEventQueryClient } from './remote-event-query-client.js';
export { RemoteEventLifecycleClient } from './remote-event-lifecycle-client.js';
