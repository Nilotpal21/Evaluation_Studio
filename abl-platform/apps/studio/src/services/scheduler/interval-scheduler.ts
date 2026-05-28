/**
 * Interval Scheduler
 *
 * Fallback scheduler using setInterval when Redis is unavailable.
 * Parses cron expressions for next-run calculation and uses
 * setInterval with 60s tick to check job eligibility.
 */

import type { ScheduledJob, SchedulerStrategy, SchedulerStatus } from './scheduler-types';

interface ScheduledEntry {
  job: ScheduledJob;
  lastRun: Date | null;
  running: boolean;
}

export class IntervalScheduler implements SchedulerStrategy {
  private entries = new Map<string, ScheduledEntry>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  async register(job: ScheduledJob): Promise<void> {
    this.entries.set(job.name, { job, lastRun: null, running: false });
  }

  async remove(jobName: string): Promise<void> {
    this.entries.delete(jobName);
  }

  async start(): Promise<void> {
    if (this.running) return;

    console.warn(
      '[Scheduler] Using setInterval fallback (Redis unavailable). Jobs will not persist across restarts.',
    );

    // Check every 60 seconds if any job should run
    this.timer = setInterval(() => this.tick(), 60_000);
    this.running = true;

    console.log(`[Scheduler] Interval scheduler started with ${this.entries.size} jobs`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.running = false;
    console.log('[Scheduler] Interval scheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getType(): string {
    return 'interval';
  }

  getStatus(): SchedulerStatus {
    const registeredJobs = Array.from(this.entries.keys());
    const nextRunTimes: Record<string, Date | null> = {};
    for (const [name, entry] of this.entries) {
      nextRunTimes[name] = entry.lastRun;
    }
    return {
      type: this.getType(),
      running: this.running,
      registeredJobs,
      nextRunTimes,
    };
  }

  private async tick(): Promise<void> {
    const now = new Date();

    for (const [name, entry] of this.entries) {
      if (entry.running) continue;

      if (this.shouldRun(entry.job.cron, now, entry.lastRun)) {
        entry.running = true;
        entry.lastRun = now;

        try {
          console.log(`[Scheduler] Executing job: ${name}`);
          await entry.job.handler();
          console.log(`[Scheduler] Completed job: ${name}`);
        } catch (error) {
          console.error(`[Scheduler] Job ${name} failed:`, error);
        } finally {
          entry.running = false;
        }
      }
    }
  }

  /**
   * Simple cron matching: supports standard 5-field cron.
   * Checks if `now` matches the cron pattern and at least 1 minute
   * has passed since lastRun.
   */
  private shouldRun(cron: string, now: Date, lastRun: Date | null): boolean {
    // Prevent running more than once per minute
    if (lastRun && now.getTime() - lastRun.getTime() < 60_000) {
      return false;
    }

    const parts = cron.split(/\s+/);
    if (parts.length < 5) return false;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    return (
      this.matchField(minute, now.getMinutes()) &&
      this.matchField(hour, now.getHours()) &&
      this.matchField(dayOfMonth, now.getDate()) &&
      this.matchField(month, now.getMonth() + 1) &&
      this.matchField(dayOfWeek, now.getDay())
    );
  }

  private matchField(pattern: string, value: number): boolean {
    if (pattern === '*') return true;

    // Handle */N (every N)
    if (pattern.startsWith('*/')) {
      const interval = parseInt(pattern.slice(2), 10);
      return value % interval === 0;
    }

    // Handle comma-separated values
    if (pattern.includes(',')) {
      return pattern.split(',').some((p) => parseInt(p, 10) === value);
    }

    // Handle range (e.g., 1-5)
    if (pattern.includes('-')) {
      const [start, end] = pattern.split('-').map(Number);
      return value >= start && value <= end;
    }

    return parseInt(pattern, 10) === value;
  }
}
