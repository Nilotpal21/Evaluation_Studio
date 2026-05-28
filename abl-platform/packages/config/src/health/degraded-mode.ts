/**
 * Manages degraded mode state for the config system.
 * When degraded, services should return 503, reject new WebSocket connections,
 * and close active connections with code 1013.
 */
export interface DegradedModeListener {
  onEnterDegradedMode(reason: string): void;
  onExitDegradedMode(): void;
}

export class DegradedModeManager {
  private degraded = false;
  private degradedSince: Date | null = null;
  private degradedReason: string | null = null;
  private revalidationTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: DegradedModeListener[] = [];
  private revalidateChecks: Array<() => Promise<boolean>> = [];

  constructor(
    private readonly revalidationIntervalMs: number = 30_000,
    private readonly maxDegradedMs: number = 300_000,
  ) {}

  addListener(listener: DegradedModeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: DegradedModeListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  addRevalidationCheck(check: () => Promise<boolean>): void {
    this.revalidateChecks.push(check);
  }

  enter(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.degradedSince = new Date();
    this.degradedReason = reason;

    for (const listener of this.listeners) {
      try {
        listener.onEnterDegradedMode(reason);
      } catch {
        // Don't let listener errors prevent degraded mode
      }
    }

    this.startRevalidation();
    console.error(`[Config] Entered degraded mode: ${reason}`);
  }

  exit(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.degradedSince = null;
    this.degradedReason = null;
    this.stopRevalidation();

    for (const listener of this.listeners) {
      try {
        listener.onExitDegradedMode();
      } catch {
        // Don't let listener errors prevent recovery
      }
    }

    console.log('[Config] Exited degraded mode');
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getStatus(): {
    isDegraded: boolean;
    since: Date | null;
    reason: string | null;
    durationMs: number;
  } {
    return {
      isDegraded: this.degraded,
      since: this.degradedSince,
      reason: this.degradedReason,
      durationMs: this.degradedSince ? Date.now() - this.degradedSince.getTime() : 0,
    };
  }

  private startRevalidation(): void {
    this.stopRevalidation();
    this.revalidationTimer = setInterval(async () => {
      await this.revalidate();
    }, this.revalidationIntervalMs);
    if (
      this.revalidationTimer &&
      typeof this.revalidationTimer === 'object' &&
      'unref' in this.revalidationTimer
    ) {
      (this.revalidationTimer as NodeJS.Timeout).unref();
    }
  }

  private stopRevalidation(): void {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
  }

  private async revalidate(): Promise<void> {
    if (!this.degraded) return;

    // Check if we've exceeded max degraded duration
    if (this.degradedSince && Date.now() - this.degradedSince.getTime() > this.maxDegradedMs) {
      console.error(
        `[Config] CRITICAL: Degraded for ${this.maxDegradedMs / 1000}s, exceeds max threshold`,
      );
      // Exit degraded mode (notifies listeners and cleans up state)
      this.exit();
      return;
    }

    // Run all revalidation checks
    if (this.revalidateChecks.length === 0) return;

    try {
      const results = await Promise.all(
        this.revalidateChecks.map((check) => check().catch(() => false)),
      );
      if (results.every(Boolean)) {
        this.exit();
      }
    } catch {
      // Revalidation failed, stay degraded
    }
  }

  destroy(): void {
    this.stopRevalidation();
    this.listeners = [];
    this.revalidateChecks = [];
  }
}
