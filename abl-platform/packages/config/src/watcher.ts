/**
 * Config Watcher
 *
 * Poll-based config change detection with reload callbacks.
 * Uses recursive setTimeout for proper backoff support.
 */

export interface WatcherOptions {
  /** Poll interval in milliseconds */
  intervalMs?: number;
  /** Maximum backoff interval in milliseconds (default: 5 minutes) */
  maxBackoffMs?: number;
  /** Callback when config changes are detected */
  onReload?: () => Promise<void>;
}

export class ConfigWatcher {
  private baseIntervalMs: number;
  private currentIntervalMs: number;
  private maxBackoffMs: number;
  private onReload: (() => Promise<void>) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastHash: string | null = null;
  private isReloading = false;
  private getConfigHashFn: (() => string) | null = null;

  constructor(options: WatcherOptions = {}) {
    this.baseIntervalMs = options.intervalMs ?? 60_000; // 1 minute default
    this.currentIntervalMs = this.baseIntervalMs;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000; // 5 minutes default
    this.onReload = options.onReload;
  }

  /**
   * Start watching for config changes.
   * Takes a function that returns the current config hash.
   */
  start(getConfigHash: () => string): void {
    this.lastHash = getConfigHash();
    this.getConfigHashFn = getConfigHash;
    this.currentIntervalMs = this.baseIntervalMs;
    this.schedulePoll();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.getConfigHashFn = null;
  }

  private schedulePoll(): void {
    this.timer = setTimeout(() => this.poll(), this.currentIntervalMs);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  private async poll(): Promise<void> {
    // Skip if a previous reload is still in-flight
    if (this.isReloading) {
      this.schedulePoll();
      return;
    }

    if (!this.getConfigHashFn) {
      return;
    }

    const currentHash = this.getConfigHashFn();
    if (currentHash !== this.lastHash) {
      console.info('[ConfigWatcher] Configuration change detected, reloading...');
      this.lastHash = currentHash;
      if (this.onReload) {
        this.isReloading = true;
        try {
          await this.onReload();
          // Reset to base interval on success
          this.currentIntervalMs = this.baseIntervalMs;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[ConfigWatcher] Reload failed: ${message}`);
          // Exponential backoff on failure
          this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxBackoffMs);
          console.warn(`[ConfigWatcher] Next poll in ${this.currentIntervalMs}ms (backoff)`);
        } finally {
          this.isReloading = false;
        }
      }
    }

    // Schedule next poll (only if not stopped during reload)
    if (this.getConfigHashFn !== null) {
      this.schedulePoll();
    }
  }
}
