import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRuntimeUrl } from '@/config/runtime.server';
import { checkToolPermission, type ToolPermissionContext } from '../guards';

const log = createLogger('arch-ai:simulation-ops');

const SIMULATION_TIMEOUT_MS = 60_000;

export interface SimulationOpsInput {
  agentName: string;
  dslOverride?: string;
  scriptedUserTurns: string[];
  mockedToolResponses?: Record<
    string,
    {
      success?: boolean;
      response?: unknown;
      data?: unknown;
      error?: { code: string; message: string };
      delayMs?: number;
    }
  >;
  options?: {
    maxTurns?: number;
    scenarioId?: string;
    intentTags?: string[];
  };
}

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

interface SimulationOpsResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

function parseSsePayload(payload: string): ParsedSseEvent[] {
  return payload
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event:'));
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart());

      let data: unknown = null;
      const rawData = dataLines.join('\n');
      if (rawData.length > 0) {
        try {
          data = JSON.parse(rawData);
        } catch {
          data = rawData;
        }
      }

      return {
        event: eventLine ? eventLine.slice('event:'.length).trim() : 'message',
        data,
      };
    });
}

async function readRuntimeError(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  if (!raw) {
    return `Runtime returned ${response.status}: ${response.statusText}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? `Runtime returned ${response.status}: ${response.statusText}`;
  } catch {
    return `Runtime returned ${response.status}: ${response.statusText}`;
  }
}

export async function executeSimulationOps(
  input: SimulationOpsInput,
  ctx: ToolPermissionContext,
): Promise<SimulationOpsResult> {
  const permission = await checkToolPermission('testing_ops', 'run_test', ctx);
  if (!permission.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: permission.error ?? 'Permission denied' },
    };
  }

  if (!ctx.authToken) {
    return {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'A user auth token is required to run a runtime simulation.',
      },
    };
  }

  const url = `${getRuntimeUrl()}/api/projects/${encodeURIComponent(
    ctx.projectId,
  )}/runtime/simulate`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(SIMULATION_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.authToken}`,
        'X-Tenant-Id': ctx.user.tenantId,
      },
      body: JSON.stringify({
        agentId: input.agentName,
        dslOverride: input.dslOverride,
        scriptedUserTurns: input.scriptedUserTurns,
        mockedToolResponses: input.mockedToolResponses ?? {},
        options: input.options,
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: 'RUNTIME_ERROR',
          message: await readRuntimeError(response),
        },
      };
    }

    const events = parseSsePayload(await response.text());
    const errorEvent = events.find((event) => event.event === 'error');
    if (errorEvent) {
      const data = errorEvent.data as { error?: { code?: string; message?: string } };
      return {
        success: false,
        error: {
          code: data.error?.code ?? 'SIMULATION_FAILED',
          message: data.error?.message ?? 'Simulation failed',
        },
      };
    }

    const started = events.find((event) => event.event === 'started')?.data ?? null;
    const complete = events.find((event) => event.event === 'complete')?.data ?? null;
    const turns = events.filter((event) => event.event === 'turn').map((event) => event.data);
    const traces = events.filter((event) => event.event === 'trace').map((event) => event.data);

    return {
      success: true,
      data: {
        started,
        turns,
        traces,
        complete,
        eventCount: events.length,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Simulation request failed', {
      projectId: ctx.projectId,
      agentName: input.agentName,
      error: message,
    });
    return { success: false, error: { code: 'RUNTIME_FETCH_ERROR', message } };
  }
}
