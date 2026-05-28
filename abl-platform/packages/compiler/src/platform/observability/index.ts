/**
 * Observability Module
 *
 * Barrel export for observability primitives:
 * - AsyncLocalStorage context propagation
 * - Pino structured logger setup
 */

export {
  type ObservabilityContext,
  runWithObservabilityContext,
  getObservabilityContext,
  getCurrentTraceId,
  getCurrentSpanId,
} from './context.js';

export { initPino, getPino } from './pino-setup.js';
