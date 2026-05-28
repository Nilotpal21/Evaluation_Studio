/**
 * Span — Represents a unit of work within a trace.
 */
import type { SpanContext } from './span-context.js';

export interface Span {
  readonly name: string;
  readonly context: SpanContext;
  agentName?: string;
  attributes: Record<string, string>;
  setAttribute(key: string, value: string): void;
  addEvent(name: string, data?: Record<string, unknown>): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(): void;
}
