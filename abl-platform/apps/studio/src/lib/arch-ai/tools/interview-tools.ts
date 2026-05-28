/**
 * Build tools for the INTERVIEW onboarding phase.
 * Used by the v4 message flow under apps/studio/src/app/api/arch-ai/message/route.ts.
 * Imports service singletons from message-services.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { askUserSchema, collectFileSchema, updateSpecSchema } from '@/lib/arch-ai/tool-schemas';
import {
  sessionService,
  journalService,
  specDocumentService,
} from '@/lib/arch-ai/message-services';
import {
  truncate,
  journalAppendAndEmit,
  specUpdateAndEmit,
} from '@/lib/arch-ai/helpers/stream-helpers';
import { SPEC_TO_SESSION_FIELD_MAP } from '@agent-platform/arch-ai';
import type { ArchSSEEvent, ArchSession } from '@agent-platform/arch-ai';

const log = createLogger('api:arch-ai:interview-tools');

/** Build tools for INTERVIEW phase */
export function buildInterviewTools(
  ctx: { tenantId: string; userId: string },
  sessionId: string,
  session: ArchSession,
  jEmit?: (event: ArchSSEEvent) => void,
  authToken?: string,
  options?: { includeCollectFile?: boolean },
) {
  const includeCollectFile = options?.includeCollectFile ?? true;

  return {
    ask_user: tool({
      description:
        'Ask the user a structured question with an interactive widget. Use for ALL questions.',
      inputSchema: askUserSchema,
      // No execute — client-side tool. AI SDK stops here when maxSteps is set.
    }),
    ...(includeCollectFile
      ? {
          collect_file: tool({
            description: 'Request file upload from the user.',
            inputSchema: collectFileSchema,
            // No execute — client-side tool
          }),
        }
      : {}),
    update_specification: tool({
      description:
        'Update the project specification. Use field+value for form fields, note for conversation notes, or both.',
      inputSchema: updateSpecSchema,
      execute: async (input) => {
        const field = input.field as string | undefined;
        const value = input.value as unknown;
        const note = input.note;

        const results: string[] = [];

        if (field && value !== undefined) {
          // Validate projectName early — don't let an invalid name travel through
          // Blueprint + Build only to fail at Create Project.
          if (field === 'projectName') {
            const name = typeof value === 'string' ? value.trim() : '';
            if (!name || name.length < 2) {
              return { updated: false, error: 'Project name must be at least 2 characters.' };
            }
            if (name.length > 100) {
              return { updated: false, error: 'Project name must be 100 characters or fewer.' };
            }
            // Check for duplicate within the tenant via service layer
            const { projectExistsByName } = await import('@/services/project-service');
            if (await projectExistsByName(name, ctx.tenantId)) {
              return {
                updated: false,
                error: `A project named "${name}" already exists. Please choose a different name.`,
              };
            }
          }

          // Normalize channels to prevent LLM re-encoding artifacts
          let normalizedValue = value;
          if (field === 'channels') {
            const { normalizeChannels } = await import('@/lib/arch-ai/helpers/normalize-channels');
            normalizedValue = normalizeChannels(value);
          }
          await sessionService.updateSpecification(ctx, sessionId, {
            [field]: normalizedValue,
          });
          results.push(`Updated ${field}`);
          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'mutation',
              content: {
                type: 'mutation',
                what:
                  field === 'projectName'
                    ? `Named project: ${String(value)}`
                    : `Set ${field}: "${truncate(String(value), 80)}"`,
                field,
                to: value,
                reason: `${field} captured during interview`,
                specialist: 'onboarding',
                requestedBy: 'user' as const,
              },
              specialist: 'onboarding',
              phase: 'INTERVIEW',
            },
            jEmit,
          );

          // Spec document parallel write (non-blocking)
          try {
            const specDocForField = await specDocumentService.getBySession(ctx, sessionId);
            if (specDocForField) {
              const fieldToSpecPath: Record<string, string> = {
                projectName: 'business.projectName',
                description: 'business.objective',
                channels: 'business.channels',
                language: 'business.language',
              };
              const specPath = fieldToSpecPath[field];
              if (specPath) {
                const sessionField = SPEC_TO_SESSION_FIELD_MAP[specPath];
                await specUpdateAndEmit(
                  specDocumentService,
                  log,
                  ctx,
                  String(specDocForField._id),
                  specPath,
                  normalizedValue,
                  jEmit,
                  sessionId,
                  sessionField,
                );
              }
            }
          } catch {
            /* non-blocking — spec doc write failure does not affect main flow */
          }
        }

        if (note) {
          const spec = session.metadata.specification;
          const notes = [...(spec.conversationNotes ?? []), note];
          await sessionService.updateSpecification(ctx, sessionId, {
            conversationNotes: notes,
          } as Record<string, unknown>);
          results.push(`Added note: ${note.label}`);
          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'mutation',
              content: {
                type: 'mutation',
                what: `Requirement: ${note.label}`,
                to: note.detail ? truncate(note.detail, 120) : undefined,
                reason: `${note.category ?? 'general'} requirement from interview`,
                specialist: 'onboarding',
                requestedBy: 'specialist' as const,
              },
              specialist: 'onboarding',
              phase: 'INTERVIEW',
            },
            jEmit,
          );

          // Spec document parallel write for conversation note (non-blocking)
          try {
            const specDocForNote = await specDocumentService.getBySession(ctx, sessionId);
            if (specDocForNote) {
              await specUpdateAndEmit(
                specDocumentService,
                log,
                ctx,
                String(specDocForNote._id),
                'business.notes',
                notes,
                jEmit,
              );
            }
          } catch {
            /* non-blocking — spec doc write failure does not affect main flow */
          }
        }

        return results.length > 0 ? results.join(', ') : 'No field or note provided';
      },
    }),
    proceed_to_next_phase: tool({
      description:
        'Advance to the next onboarding phase when the user explicitly confirms readiness. ' +
        'Only call this when the user clearly wants to proceed (e.g., "looks good", "build it", ' +
        '"continue", "create project"). Do NOT call this if the user is requesting changes or ' +
        'asking questions — handle those first.',
      inputSchema: z.object({
        reason: z.string().describe('Brief explanation of why the user is ready to proceed'),
      }),
      execute: async () => {
        const { canExitInterview } = await import('@agent-platform/arch-ai');
        const { executePhaseTransition } = await import('@/lib/arch-ai/phase-transition');

        // Re-read session to get latest specification state
        const freshSession = await sessionService.getById(ctx, sessionId);
        if (!freshSession) {
          return { error: 'Session not found' };
        }

        if (!canExitInterview(freshSession.metadata.specification)) {
          return {
            error:
              'Cannot proceed yet — project name is required. Ask the user to provide a project name first.',
          };
        }

        const emitFn = jEmit ?? (() => {});
        const journalFn = async (summary: string, rationale: string, spec: string, ph: string) => {
          await journalAppendAndEmit(
            journalService,
            ctx,
            {
              sessionId,
              type: 'decision',
              content: {
                type: 'decision',
                summary,
                rationale,
                specialist: spec,
                source: 'specialist_recommendation' as const,
              },
              specialist: spec,
              phase: ph,
            },
            jEmit,
          );
        };

        return executePhaseTransition(ctx, freshSession, sessionService, emitFn, journalFn);
      },
    }),
    platform_context: tool({
      description:
        'Query platform capabilities — list available LLM models. ' +
        'Use this to populate selection widgets with real data instead of asking users to type from memory. ' +
        'During onboarding (before project creation), only list_models is available.',
      inputSchema: z.object({
        action: z
          .enum([
            'get_summary',
            'list_agents',
            'list_models',
            'list_tools',
            'list_channels',
            'list_auth_profiles',
          ])
          .describe('Platform context action to perform'),
        agentName: z.string().optional().describe('Filter by agent name (for agent-specific data)'),
        toolType: z.string().optional().describe('Filter by tool type (for list_tools)'),
      }),
      execute: async (input) => {
        const projectScopedActions = [
          'get_summary',
          'list_agents',
          'list_tools',
          'list_channels',
          'list_auth_profiles',
        ];
        if (projectScopedActions.includes(input.action)) {
          return {
            success: false,
            error: {
              code: 'PROJECT_REQUIRED',
              message:
                'This action requires a project. It will be available after the project is created. ' +
                'During onboarding, use list_models to query available LLM models.',
            },
          };
        }
        const { executePlatformContext } = await import('@/lib/arch-ai/tools/platform-context');
        return executePlatformContext(input, {
          projectId: '',
          user: {
            permissions: [],
            tenantId: ctx.tenantId,
            userId: ctx.userId,
          },
          authToken,
        });
      },
    }),
  };
}
