/**
 * Scheduler Types
 *
 * Shared types for the job scheduling system.
 * Supports BullMQ (Redis) and setInterval fallback strategies.
 */

export interface ScheduledJob {
  name: string;
  cron: string; // Cron expression (e.g., '0 2 * * *')
  handler: () => Promise<void>;
  retries?: number; // Max retry attempts (default: 3)
  backoff?: number; // Initial backoff in ms (default: 5000)
  timeout?: number; // Job timeout in ms (default: 300000)
}

export interface SchedulerStrategy {
  /** Register a repeatable job */
  register(job: ScheduledJob): Promise<void>;

  /** Remove a registered job */
  remove(jobName: string): Promise<void>;

  /** Start the scheduler */
  start(): Promise<void>;

  /** Stop the scheduler gracefully */
  stop(): Promise<void>;

  /** Check if scheduler is running */
  isRunning(): boolean;

  /** Get scheduler type identifier */
  getType(): string;

  /** Get scheduler status including registered jobs */
  getStatus(): SchedulerStatus;
}

export interface SchedulerStatus {
  type: string;
  running: boolean;
  registeredJobs: string[];
  nextRunTimes: Record<string, Date | null>;
}
