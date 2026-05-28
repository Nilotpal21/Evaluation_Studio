import { PIIVault } from '@abl/compiler/platform';
import type { RuntimeSession } from '../execution/types.js';
import {
  renderSessionMessagesForUserSurface,
  renderTraceEventsForReadSurface,
  type PIIReadSurfaceContext,
  type SessionMessagePIIResponse,
  type TraceEventPIIResponse,
} from './runtime-pii-boundary-service.js';
import { refreshSessionPIIContext } from './session-pii-context.js';

export async function buildRuntimeSessionPIIReadSurfaceContext(
  runtimeSession?: RuntimeSession | null,
): Promise<PIIReadSurfaceContext | undefined> {
  if (runtimeSession) {
    await refreshSessionPIIContext(runtimeSession);
  }

  if (!runtimeSession?.piiRedactionConfig?.enabled) {
    return undefined;
  }

  if (!runtimeSession.piiVault) {
    runtimeSession.piiVault = new PIIVault({
      recognizerRegistry: runtimeSession.piiRecognizerRegistry,
    });
  } else {
    runtimeSession.piiVault.setRecognizerRegistry(runtimeSession.piiRecognizerRegistry);
  }

  return {
    piiRedactionConfig: runtimeSession.piiRedactionConfig,
    piiVault: runtimeSession.piiVault,
    piiPatternConfigs: runtimeSession.piiPatternConfigs,
  };
}

export async function renderRuntimeMessagesForReadSurface<T extends SessionMessagePIIResponse>(
  messages: T[],
  runtimeSession?: RuntimeSession | null,
): Promise<T[]> {
  return renderSessionMessagesForUserSurface(
    messages,
    await buildRuntimeSessionPIIReadSurfaceContext(runtimeSession),
  );
}

export async function renderRuntimeTraceEventsForReadSurface<T extends TraceEventPIIResponse>(
  traceEvents: T[],
  runtimeSession?: RuntimeSession | null,
): Promise<T[]> {
  return renderTraceEventsForReadSurface(
    traceEvents,
    await buildRuntimeSessionPIIReadSurfaceContext(runtimeSession),
  );
}
