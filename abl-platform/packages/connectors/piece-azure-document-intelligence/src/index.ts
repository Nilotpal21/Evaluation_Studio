/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @abl/piece-azure-document-intelligence
 *
 * From-scratch AP-format piece for Azure Document Intelligence (LLD §3 Phase 3).
 * Exposes a single `extract_document` action. No triggers.
 */

import { createPiece } from '@activepieces/pieces-framework';
import { azureDocumentIntelligenceAuth } from './auth';
import { extractDocumentAction } from './actions/extract-document';

export const azureDocumentIntelligence = createPiece({
  displayName: 'Azure Document Intelligence',
  logoUrl:
    'https://learn.microsoft.com/en-us/training/achievements/azure-document-intelligence.svg',
  authors: [],
  description:
    'Layout-aware document extraction (PDF / DOCX / images) via Microsoft Azure Document Intelligence.',
  auth: azureDocumentIntelligenceAuth as any,
  actions: [extractDocumentAction as never],
  triggers: [],
});

export default azureDocumentIntelligence;
