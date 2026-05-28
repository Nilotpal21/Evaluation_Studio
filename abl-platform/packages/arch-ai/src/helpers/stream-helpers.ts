import { createLogger } from '@abl/compiler/platform';
import type { ArchSSEEvent, JournalContent } from '../index.js';
import type { JournalEntryType } from '../index.js';
import type { JournalService, SpecDocumentService } from '../index.js';

const log = createLogger('api:arch-ai:message');

// ─── Journal helper: persist THEN emit SSE (journal-before-response) ──
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function buildJournalDisplay(content: JournalContent): {
  summary: string;
  description: string;
} {
  switch (content.type) {
    case 'mutation':
      return {
        summary: content.what,
        description: content.to ? truncate(String(content.to), 120) : content.reason,
      };
    case 'decision':
      return {
        summary: content.summary,
        description: content.rationale,
      };
    case 'validation':
      return {
        summary: `${content.target}: ${content.result}`,
        description:
          content.result === 'fail'
            ? (content.errors?.join(', ') ?? 'Compilation failed')
            : `${content.warnings?.length ?? 0} warnings`,
      };
    case 'consultation':
      return {
        summary: `${content.fromSpecialist} → ${content.toSpecialist}: ${content.topic}`,
        description: content.outcome,
      };
    case 'analysis':
      return {
        summary: content.question,
        description: content.rootCause,
      };
    default:
      return {
        summary: String((content as Record<string, unknown>).summary ?? 'Entry'),
        description: '',
      };
  }
}

export async function journalAppendAndEmit(
  journalService: InstanceType<typeof JournalService>,
  ctx: { tenantId: string; userId: string },
  params: {
    sessionId: string;
    type: JournalEntryType;
    content: JournalContent;
    specialist: string;
    phase: string;
  },
  emit?: (event: ArchSSEEvent) => void,
): Promise<void> {
  try {
    await journalService.append(ctx, params);
    const display = buildJournalDisplay(params.content);
    emit?.({
      type: 'journal_entry',
      entryType: params.type,
      summary: display.summary,
      description: display.description || undefined,
    });
  } catch (err: unknown) {
    log.warn('Journal append failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: params.sessionId,
    });
  }
}

// ─── Spec document helper: parallel write THEN emit SSE ──
export async function specUpdateAndEmit(
  specDocumentService: InstanceType<typeof SpecDocumentService>,
  log: ReturnType<typeof createLogger>,
  ctx: { tenantId: string; userId: string },
  specId: string,
  path: string,
  value: unknown,
  emit?: (event: ArchSSEEvent) => void,
  sessionId?: string,
  sessionFieldName?: string,
): Promise<void> {
  try {
    let newVersion: number;
    if (sessionFieldName && sessionId) {
      newVersion = await specDocumentService.updateBusinessField(
        ctx,
        specId,
        sessionId,
        path,
        value,
        sessionFieldName,
      );
    } else {
      newVersion = await specDocumentService.updateField(ctx, specId, path, value);
    }
    emit?.({ type: 'spec_document_update', path, value, version: newVersion });
  } catch (err: unknown) {
    // Non-blocking: spec doc update failure should not break the main flow
    log.error('specUpdateAndEmit failed', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
