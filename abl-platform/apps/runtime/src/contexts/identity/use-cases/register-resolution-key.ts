/**
 * Register Resolution Key Use Case
 *
 * Stores a session resolution key via the SessionResolutionStore port.
 * This key maps a (tenant, channel, artifact hash) tuple to a session ID
 * for future session resumption.
 */

import type { SessionResolutionWriteInput } from '../domain/session-resolution-record.js';
import type { SessionResolutionStore } from './resolve-session.js';

export class RegisterResolutionKey {
  constructor(private readonly store: SessionResolutionStore) {}

  async execute(key: SessionResolutionWriteInput): Promise<void> {
    await this.store.save(key);
  }
}
