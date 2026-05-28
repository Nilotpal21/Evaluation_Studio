/**
 * Transcripts API Routes
 *
 * GET /api/v1/transcripts - List saved transcripts
 * GET /api/v1/transcripts/:id - Get transcript details
 * POST /api/v1/transcripts - Save a transcript from a session
 * DELETE /api/v1/transcripts/:id - Delete a transcript
 */

import { Router, type Request, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import crypto from 'crypto';
import { getRuntimeExecutor } from '../services/runtime-executor.js';
import { getTraceStore } from '../services/trace-store.js';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import { hasPermission } from '@agent-platform/shared/rbac';
import { isTenantAdminRole } from '@agent-platform/shared-auth/rbac';
import type { TranscriptExport } from '../types/index.js';
import { resolveTranscriptPath, InvalidTranscriptIdError } from './transcripts-path.js';
import { evaluateProjectPermission } from '../middleware/rbac.js';
import {
  renderRuntimeMessagesForReadSurface,
  renderRuntimeTraceEventsForReadSurface,
} from '../services/pii/runtime-read-surface-renderer.js';

const log = createLogger('transcripts-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/transcripts',
  tags: ['Transcripts'],
});
const router: RouterType = openapi.router;

// All transcript routes require authentication
router.use(authMiddleware);

// Transcript storage directory — resolve relative to this file's package root
const TRANSCRIPTS_DIR = path.resolve(process.cwd(), 'output/transcripts');

// Ensure directory exists (async)
async function ensureTranscriptsDir(): Promise<void> {
  try {
    await access(TRANSCRIPTS_DIR, constants.F_OK);
  } catch {
    await mkdir(TRANSCRIPTS_DIR, { recursive: true });
  }
}

type TranscriptScope = NonNullable<TranscriptExport['scope']>;

function getRequestTenantContext(req: Request) {
  return req.tenantContext;
}

function getTranscriptScope(transcript: TranscriptExport): TranscriptScope | undefined {
  return transcript.scope;
}

function canReadLegacyUnscopedTranscript(req: Request): boolean {
  const tenantContext = getRequestTenantContext(req);
  return (
    isTenantAdminRole(tenantContext?.role) ||
    hasPermission(tenantContext?.permissions ?? [], 'project:*')
  );
}

async function canReadTranscript(req: Request, transcript: TranscriptExport): Promise<boolean> {
  const tenantContext = getRequestTenantContext(req);
  if (!tenantContext?.tenantId) {
    return false;
  }

  const scope = getTranscriptScope(transcript);
  if (!scope) {
    return canReadLegacyUnscopedTranscript(req);
  }

  if (scope.tenantId !== tenantContext.tenantId) {
    return false;
  }

  if (scope.projectId) {
    const projectAccess = await evaluateProjectPermission(req, 'session:read', scope.projectId, {
      concealNotMember: true,
    });
    return projectAccess.allowed;
  }

  return Boolean(scope.userId && tenantContext.userId && scope.userId === tenantContext.userId);
}

function getLiveSessionScope(req: Request, session: any) {
  const tenantContext = getRequestTenantContext(req);
  return {
    tenantId: typeof session?.tenantId === 'string' ? session.tenantId : tenantContext?.tenantId,
    projectId: typeof session?.projectId === 'string' ? session.projectId : undefined,
    userId: typeof session?.userId === 'string' ? session.userId : tenantContext?.userId,
    sessionId: typeof session?.id === 'string' ? session.id : undefined,
  };
}

async function canCreateTranscriptFromSession(req: Request, session: any): Promise<boolean> {
  if (!session) {
    return false;
  }

  const tenantContext = getRequestTenantContext(req);
  const scope = getLiveSessionScope(req, session);
  if (!tenantContext?.tenantId || !scope.tenantId || scope.tenantId !== tenantContext.tenantId) {
    return false;
  }

  if (scope.projectId) {
    const projectAccess = await evaluateProjectPermission(req, 'session:read', scope.projectId, {
      concealNotMember: true,
    });
    return projectAccess.allowed;
  }

  return Boolean(scope.userId && tenantContext.userId && scope.userId === tenantContext.userId);
}

/**
 * GET /api/v1/transcripts
 * List all saved transcripts
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List transcripts',
    description: 'List all saved transcripts with metadata',
    response: z.object({
      success: z.boolean(),
      total: z.number(),
      transcripts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          agentId: z.string(),
          agentName: z.string(),
          messageCount: z.number(),
          createdAt: z.string().or(z.date()),
        }),
      ),
    }),
  },
  async (req, res) => {
    try {
      await ensureTranscriptsDir();

      const allFiles = await readdir(TRANSCRIPTS_DIR);
      const jsonFiles = allFiles.filter((f) => f.endsWith('.json'));

      const transcripts = await Promise.all(
        jsonFiles.map(async (f) => {
          const content = await readFile(path.join(TRANSCRIPTS_DIR, f), 'utf-8');
          const transcript = JSON.parse(content) as TranscriptExport;
          if (!(await canReadTranscript(req, transcript))) {
            return null;
          }
          return {
            id: transcript.id,
            name: transcript.name,
            agentId: transcript.agentId,
            agentName: transcript.agentName,
            messageCount: transcript.messages.length,
            createdAt: transcript.createdAt,
          };
        }),
      );
      const visibleTranscripts = transcripts.filter(
        (transcript): transcript is NonNullable<(typeof transcripts)[number]> =>
          transcript !== null,
      );

      res.json({
        success: true,
        total: visibleTranscripts.length,
        transcripts: visibleTranscripts,
      });
    } catch (error) {
      log.error('Error listing transcripts', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: 'Failed to list transcripts',
      });
    }
  },
);

/**
 * GET /api/v1/transcripts/:id
 * Get full transcript details
 */
openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get transcript details',
    description: 'Get full transcript details including messages, trace events, and final state',
    response: z.object({
      success: z.boolean(),
      transcript: z.object({
        id: z.string(),
        name: z.string(),
        agentId: z.string(),
        agentName: z.string(),
        createdAt: z.string().or(z.date()),
        messages: z.array(
          z.object({
            id: z.string(),
            role: z.enum(['user', 'assistant', 'system']),
            content: z.string(),
            timestamp: z.string().or(z.date()),
            traceIds: z.array(z.string()),
            metadata: z
              .object({
                tokensIn: z.number().optional(),
                tokensOut: z.number().optional(),
                latencyMs: z.number().optional(),
                agentName: z.string().optional(),
                action: z.unknown().optional(),
              })
              .optional(),
          }),
        ),
        traceEvents: z.array(z.unknown()),
        finalState: z.record(z.unknown()),
      }),
    }),
  },
  async (req, res) => {
    try {
      await ensureTranscriptsDir();

      let filePath: string;
      try {
        filePath = resolveTranscriptPath(req.params.id, TRANSCRIPTS_DIR);
      } catch (e) {
        if (e instanceof InvalidTranscriptIdError) {
          res.status(400).json({
            success: false,
            error: { code: e.code, message: e.message },
          });
          return;
        }
        throw e;
      }

      try {
        await access(filePath, constants.F_OK);
      } catch {
        res.status(404).json({
          success: false,
          error: `Transcript not found: ${req.params.id}`,
        });
        return;
      }

      const content = await readFile(filePath, 'utf-8');
      const transcript = JSON.parse(content) as TranscriptExport;
      if (!(await canReadTranscript(req, transcript))) {
        res.status(404).json({
          success: false,
          error: `Transcript not found: ${req.params.id}`,
        });
        return;
      }

      res.json({
        success: true,
        transcript,
      });
    } catch (error) {
      log.error('Error getting transcript', {
        error: error instanceof Error ? error.message : String(error),
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to get transcript',
      });
    }
  },
);

/**
 * POST /api/v1/transcripts
 * Save a transcript from a session
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create transcript',
    description: 'Save a transcript from an active or historical session',
    body: z.object({
      sessionId: z.string().describe('Session ID to create transcript from'),
      name: z.string().optional().describe('Optional name for the transcript'),
    }),
    response: z.object({
      success: z.boolean(),
      transcript: z.object({
        id: z.string(),
        name: z.string(),
        filePath: z.string(),
      }),
    }),
    successStatus: 201,
  },
  async (req, res) => {
    try {
      const { sessionId, name } = req.body;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'Missing required field: sessionId',
        });
        return;
      }

      const executor = getRuntimeExecutor();
      const detail = executor.getSessionDetail(sessionId);
      if (!detail) {
        res.status(404).json({
          success: false,
          error: `Session not found: ${sessionId}`,
        });
        return;
      }

      // Get trace events from TraceStore
      let traceEvents = detail.traceEvents;
      if (traceEvents.length === 0) {
        try {
          const storeEvents = getTraceStore().getEvents(sessionId);
          if (Array.isArray(storeEvents) && storeEvents.length > 0) {
            traceEvents = storeEvents;
          }
        } catch {
          // Trace store unavailable
        }
      }
      const runtimeSession = executor.getSession(sessionId);
      if (!(await canCreateTranscriptFromSession(req, runtimeSession))) {
        res.status(404).json({
          success: false,
          error: `Session not found: ${sessionId}`,
        });
        return;
      }
      const transcriptMessages = detail.messages as unknown as TranscriptExport['messages'];
      const renderedMessages = await renderRuntimeMessagesForReadSurface(
        transcriptMessages,
        runtimeSession,
      );
      const renderedTraceEvents = await renderRuntimeTraceEventsForReadSurface(
        traceEvents as TranscriptExport['traceEvents'],
        runtimeSession,
      );

      await ensureTranscriptsDir();

      const agentName = detail.agentName;
      const transcript: TranscriptExport = {
        id: crypto.randomUUID(),
        name: name || `${agentName}-${new Date().toISOString().split('T')[0]}`,
        agentId: agentName,
        agentName,
        createdAt: new Date(),
        scope: getLiveSessionScope(req, runtimeSession) as TranscriptExport['scope'],
        messages: renderedMessages,
        traceEvents: renderedTraceEvents,
        finalState: detail.state as TranscriptExport['finalState'],
      };

      const filePath = path.join(TRANSCRIPTS_DIR, `${transcript.id}.json`);
      await writeFile(filePath, JSON.stringify(transcript, null, 2));

      res.status(201).json({
        success: true,
        transcript: {
          id: transcript.id,
          name: transcript.name,
          filePath,
        },
      });
    } catch (error) {
      log.error('Error saving transcript', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: 'Failed to save transcript',
      });
    }
  },
);

/**
 * DELETE /api/v1/transcripts/:id
 * Delete a transcript
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete transcript',
    description: 'Delete a saved transcript by ID',
    response: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async (req, res) => {
    try {
      await ensureTranscriptsDir();

      let filePath: string;
      try {
        filePath = resolveTranscriptPath(req.params.id, TRANSCRIPTS_DIR);
      } catch (e) {
        if (e instanceof InvalidTranscriptIdError) {
          res.status(400).json({
            success: false,
            error: { code: e.code, message: e.message },
          });
          return;
        }
        throw e;
      }

      try {
        await access(filePath, constants.F_OK);
      } catch {
        res.status(404).json({
          success: false,
          error: `Transcript not found: ${req.params.id}`,
        });
        return;
      }

      const content = await readFile(filePath, 'utf-8');
      const transcript = JSON.parse(content) as TranscriptExport;
      if (!(await canReadTranscript(req, transcript))) {
        res.status(404).json({
          success: false,
          error: `Transcript not found: ${req.params.id}`,
        });
        return;
      }

      await unlink(filePath);

      res.json({
        success: true,
        message: 'Transcript deleted',
      });
    } catch (error) {
      log.error('Error deleting transcript', {
        error: error instanceof Error ? error.message : String(error),
        id: req.params.id,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to delete transcript',
      });
    }
  },
);

export default openapi.router;
