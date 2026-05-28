/**
 * NLU Config Version Tracker
 *
 * Computes a version hash from NLU configuration (intents, entities,
 * categories, models). On version change, invalidates tenant cache
 * and fires a callback.
 */

import * as crypto from 'crypto';
import type { NLUIRConfig } from '../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('nlu-version-tracker');

export class NLUVersionTracker {
  private currentVersion: string;
  private changeCallbacks: Array<(oldVersion: string, newVersion: string) => void> = [];

  constructor(config?: NLUIRConfig) {
    this.currentVersion = config ? NLUVersionTracker.computeVersion(config) : 'none';
  }

  /**
   * Get the current NLU config version hash.
   */
  getVersion(): string {
    return this.currentVersion;
  }

  /**
   * Check if a new config has a different version.
   * If changed, fires callbacks and returns true.
   */
  checkForChanges(newConfig: NLUIRConfig): boolean {
    const newVersion = NLUVersionTracker.computeVersion(newConfig);

    if (newVersion === this.currentVersion) {
      return false;
    }

    const oldVersion = this.currentVersion;
    this.currentVersion = newVersion;

    for (const cb of this.changeCallbacks) {
      try {
        cb(oldVersion, newVersion);
      } catch (error) {
        log.warn('Version change callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return true;
  }

  /**
   * Register a callback for version changes.
   */
  onVersionChange(callback: (oldVersion: string, newVersion: string) => void): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Compute a version hash from NLU IR config.
   */
  static computeVersion(config: NLUIRConfig): string {
    const data = JSON.stringify({
      intents: config.intents?.map((i) => ({ name: i.name, patterns: i.patterns })),
      entities: config.entities?.map((e) => ({ name: e.name, type: e.type, values: e.values })),
      categories: config.categories?.map((c) => ({ name: c.name, patterns: c.patterns })),
      models: config.models,
    });

    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }
}
