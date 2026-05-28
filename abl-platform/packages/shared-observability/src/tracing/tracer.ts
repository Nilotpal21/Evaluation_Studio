/**
 * Tracer — Creates and manages spans.
 */
import type { SpanContext } from './span-context.js';
import type { Span } from './span.js';

export interface Tracer {
  startSpan(
    name: string,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Span;

  withSpan<T>(
    name: string,
    fn: () => T | Promise<T>,
    options?: { agentName?: string; attributes?: Record<string, string> },
  ): Promise<T>;

  runSync<T>(span: Span, fn: () => T): T;

  run<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T>;

  activeSpan(): Span | null;

  emit(event: { type: string; data: Record<string, unknown>; durationMs?: number }): void;

  continueFrom(context: SpanContext, name: string): Span;
}
