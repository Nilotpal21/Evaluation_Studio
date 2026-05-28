/**
 * Page Processing Worker
 *
 * Converts DocumentPages to SearchChunks with progressive summarization and question generation.
 * Phase 2 implementation:
 * - Progressive summarization: passes context between pages for continuity
 * - Question generation: per-chunk and document-level questions
 * - Enhanced chunking with summaries stored in metadata
 *
 * Flow: docling-extraction → page-processing → canonical-mapping → question-synthesis → embedding
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  QUEUE_PAGE_PROCESSING,
  QUEUE_CANONICAL_MAP,
  QUEUE_QUESTION_SYNTHESIS,
  QUEUE_VISUAL_ENRICHMENT,
  DocumentStatus,
  ChunkStatus,
} from '@agent-platform/search-ai-sdk';
import { getDualConnection } from '../db/index.js';
import type {
  ISearchDocument,
  IDocumentPage,
  ISearchChunk,
  IChunkQuestion,
  ISearchIndex,
} from '@agent-platform/database';
import type { Model } from 'mongoose';

// Helper to get models from dual connections
function getModels() {
  const dualConn = getDualConnection();
  const platformConn = dualConn.getPlatformConnection();
  const contentConn = dualConn.getContentConnection();

  return {
    SearchIndex: platformConn.models.SearchIndex as Model<ISearchIndex>,
    SearchDocument: contentConn.models.SearchDocument as Model<ISearchDocument>,
    DocumentPage: contentConn.models.DocumentPage as Model<IDocumentPage>,
    SearchChunk: contentConn.models.SearchChunk as Model<ISearchChunk>,
    ChunkQuestion: contentConn.models.ChunkQuestion as Model<IChunkQuestion>,
  };
}

import { withTenantContext } from '@agent-platform/database/mongo';
import { WorkerLLMClient } from '@agent-platform/llm';
import { ProgressiveSummarizationService } from '../services/progressive-summarization/index.js';
import { QuestionSynthesisService } from '../services/question-synthesis/index.js';
import { ChunkingService } from '../services/chunking/index.js';
import { resolveEnhancedIndexLLMConfig } from '../services/llm-config/resolver.js';
import type { EnhancedResolvedUseCaseConfig } from '../services/llm-config/resolver.js';
import { createQueue, createWorkerOptions, workerLog, workerError } from './shared.js';
import type {
  PageProcessingJobData,
  CanonicalMapJobData,
  QuestionSynthesisJobData,
} from './shared.js';
import { chunkMarkdown } from '@agent-platform/search-ai-internal/chunking';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

// =============================================================================
// CONFIGURATION
// =============================================================================

const PAGES_PER_BATCH = parseInt(process.env.PAGE_PROCESSING_BATCH_SIZE || '10', 10);

// =============================================================================
// CONCURRENCY HELPERS
// =============================================================================

/**
 * Run task factories with bounded concurrency, returning results in input order.
 * Each factory is a () => Promise<T> — only called when a slot opens.
 */
async function runWithConcurrency<T>(
  factories: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(factories.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < factories.length) {
      const i = nextIdx++;
      try {
        const value = await factories[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, factories.length) }, () => worker()));
  return results;
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

async function processPageProcessingJob(job: Job<PageProcessingJobData>): Promise<void> {
  const { indexId, documentId, tenantId, pageIds, previousPageSummary } = job.data;

  workerLog('page-processing', `Processing ${pageIds.length} pages for document ${documentId}`, {
    indexId,
    tenantId,
  });

  // Resolve per-index LLM configuration with enhanced status tracking
  const llmConfig = await resolveEnhancedIndexLLMConfig(tenantId, indexId);

  // Helper to check if a feature is usable
  const isFeatureUsable = (feature: EnhancedResolvedUseCaseConfig): boolean => {
    return feature.status === 'active' || feature.status === 'fallback';
  };

  // Create services based on per-index configuration with graceful degradation
  let summarizationService: ProgressiveSummarizationService | null = null;
  const summaryConfig = llmConfig.useCases.progressiveSummarization;

  if (summaryConfig.enabled) {
    if (isFeatureUsable(summaryConfig)) {
      const llmClient = new WorkerLLMClient(
        summaryConfig.provider!,
        summaryConfig.apiKey!,
        summaryConfig.model!.modelId,
      );

      summarizationService = new ProgressiveSummarizationService(llmClient, {
        model: summaryConfig.model!.modelId,
        maxTokens: summaryConfig.maxTokens,
        enableDocumentSummary: summaryConfig.enableDocumentSummary,
        documentSummaryMaxTokens: summaryConfig.documentSummaryMaxTokens,
      });

      if (summaryConfig.status === 'fallback') {
        workerLog(
          'page-processing',
          `Using fallback model for progressive summarization: ${summaryConfig.resolution.message}`,
        );
      }
    } else {
      workerLog(
        'page-processing',
        `Progressive summarization unavailable (${summaryConfig.status}): ${summaryConfig.resolution.message}. ` +
          `${summaryConfig.actionRequired ? summaryConfig.actionRequired.message : 'Continuing without summaries.'}`,
      );
    }
  }

  let questionService: QuestionSynthesisService | null = null;
  const questionConfig = llmConfig.useCases.questionSynthesis;

  if (questionConfig.enabled) {
    if (isFeatureUsable(questionConfig)) {
      const llmClient = new WorkerLLMClient(
        questionConfig.provider!,
        questionConfig.apiKey!,
        questionConfig.model!.modelId,
      );

      questionService = new QuestionSynthesisService(llmClient, {
        model: questionConfig.model!.modelId,
        questionsPerChunk: questionConfig.questionsPerChunk,
        maxTokens: questionConfig.maxTokens,
        enableEmbedding: questionConfig.enableEmbedding,
      });

      if (questionConfig.status === 'fallback') {
        workerLog(
          'page-processing',
          `Using fallback model for question synthesis: ${questionConfig.resolution.message}`,
        );
      }
    } else {
      workerLog(
        'page-processing',
        `Question synthesis unavailable (${questionConfig.status}): ${questionConfig.resolution.message}. ` +
          `${questionConfig.actionRequired ? questionConfig.actionRequired.message : 'Continuing without questions.'}`,
      );
    }
  }

  await withTenantContext({ tenantId }, async () => {
    // Get models from dual connections
    const { SearchIndex, SearchDocument, DocumentPage, SearchChunk, ChunkQuestion } = getModels();

    // ── 1. Load pages, document, and index info ──────────────────────────────────────
    const [pages, document, index] = await Promise.all([
      DocumentPage.find({
        _id: { $in: pageIds },
        documentId,
        indexId,
        status: 'pending',
      }).sort({ pageNumber: 1 }),
      SearchDocument.findOne({ _id: documentId, tenantId })
        .select('originalReference contentType flowId')
        .lean(),
      SearchIndex.findOne({ _id: indexId, tenantId }).select('tokenChunkStrategy').lean(),
    ]);

    if (pages.length === 0) {
      workerLog('page-processing', `No pending pages found for batch, skipping`);
      return;
    }

    const documentTitle = document?.originalReference || 'Unknown';
    const documentFlowId = (document as any)?.flowId ?? null;

    workerLog('page-processing', `Loaded ${pages.length} pages`);

    // ── 2. Create chunks from pages with progressive summarization ───────────
    const chunks: any[] = [];
    const chunkQuestions: any[] = [];
    let chunkIndex = 0;
    let currentSummary: string | null = previousPageSummary;

    // ── 2.0. Check chunking strategy ──────────────────────────────────────────
    // Priority:
    // 1. Pipeline stage config (pipelineStage from job data) — from pipeline UI
    // 2. SearchIndex.tokenChunkStrategy — legacy per-index setting
    // 3. Page-based chunking (Docling default) — 1 page = 1 chunk

    // Check for pipeline stage config (injected by ingestion worker)
    const pipelineChunking = job.data.pipelineStage;
    const pipelineChunkSize = pipelineChunking?.providerConfig?.chunkSize as number | undefined;
    const pipelineChunkOverlap = pipelineChunking?.providerConfig?.chunkOverlap as
      | number
      | undefined;

    // Page-level formats ALWAYS use page-based chunking (1 page = 1 chunk).
    // Pipeline-driven chunking only applies to plain text / markdown formats.
    const PAGE_LEVEL_FORMATS = new Set([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/tiff',
      'image/bmp',
      'image/webp',
    ]);
    const forcePageLevel = PAGE_LEVEL_FORMATS.has(document?.contentType ?? '');

    // ── Markdown-chunkable types use chunkMarkdown BY DEFAULT ──
    // For HTML, DOCX, MD, TXT: default strategy is chunkMarkdown (structure-aware).
    // BUT if the pipeline explicitly selects a different strategy (fixed-size, semantic),
    // that choice is respected — user intentionally wants a different approach.
    const MARKDOWN_CHUNKABLE_TYPES_EARLY = new Set([
      'text/markdown',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/html',
    ]);
    const isMarkdownChunkable =
      MARKDOWN_CHUNKABLE_TYPES_EARLY.has(document?.contentType ?? '') && pages.length > 0;

    // Pipeline explicitly chose fixed-size or semantic → respect that choice
    const pipelineOverridesStrategy =
      pipelineChunking &&
      pipelineChunkSize &&
      (pipelineChunking.provider === 'fixed-size' || pipelineChunking.provider === 'semantic');

    if (isMarkdownChunkable && !pipelineOverridesStrategy) {
      // ═══════════════════════════════════════════════════════════════════════
      // STRUCTURE-AWARE MARKDOWN CHUNKING (default for HTML, DOCX, MD, TXT)
      // Uses chunkMarkdown — token-based, heading-split, merge-up.
      // Pipeline can provide custom maxChunkTokens/mergeTargetTokens if set.
      // ═══════════════════════════════════════════════════════════════════════

      // Allow pipeline or index settings to override token thresholds
      const overrideMaxChunkTokens =
        pipelineChunkSize ?? index?.tokenChunkStrategy?.chunkSize ?? undefined;
      const overrideMergeTargetTokens = overrideMaxChunkTokens
        ? Math.min(overrideMaxChunkTokens, 1500)
        : undefined;

      workerLog('page-processing', `Using structure-aware chunking for ${document?.contentType}`, {
        ...(overrideMaxChunkTokens ? { maxChunkTokens: overrideMaxChunkTokens } : {}),
        ...(overrideMergeTargetTokens ? { mergeTargetTokens: overrideMergeTargetTokens } : {}),
      });

      const fullMarkdown = pages.map((p) => p.text).join('\n\n');

      if (fullMarkdown.trim().length === 0) {
        workerLog('page-processing', 'No text content found in pages, skipping chunking');
      } else {
        const markdownChunks = chunkMarkdown(fullMarkdown, {
          headingLevels: [1, 2, 3],
          preserveCodeBlocks: true,
          preserveTables: true,
          preserveLists: true,
          ...(overrideMaxChunkTokens ? { maxChunkTokens: overrideMaxChunkTokens } : {}),
          ...(overrideMergeTargetTokens ? { mergeTargetTokens: overrideMergeTargetTokens } : {}),
        });

        workerLog(
          'page-processing',
          `Created ${markdownChunks.length} structure-aware chunks from markdown`,
        );

        for (const mdChunk of markdownChunks) {
          // Generate progressive summary if enabled
          let chunkSummary: string | null = null;
          if (summarizationService && mdChunk.text.trim().length > 0) {
            try {
              const summaryResult = await summarizationService.summarizeChunk(
                mdChunk.text,
                currentSummary,
                {
                  documentTitle,
                  sectionHeading: mdChunk.metadata.sectionPath.join(' > '),
                },
              );
              chunkSummary = summaryResult.summary;
              currentSummary = chunkSummary;
            } catch (error) {
              workerError('page-processing', `Failed to generate summary for chunk`, error);
            }
          }

          // Generate questions if enabled
          if (questionService && mdChunk.text.trim().length > 0) {
            try {
              const questionResult = await questionService.generateQuestions(mdChunk.text, {
                documentTitle,
                sectionHeading: mdChunk.metadata.sectionPath.join(' > '),
              });

              for (let qIdx = 0; qIdx < questionResult.questions.length; qIdx++) {
                const q = questionResult.questions[qIdx];
                chunkQuestions.push({
                  tenantId,
                  indexId,
                  documentId,
                  chunkId: null,
                  chunkIndex: chunkIndex,
                  question: q.question,
                  scope: 'chunk',
                  questionType: q.questionType,
                  confidence: q.confidence,
                  questionIndex: qIdx,
                  status: 'pending',
                });
              }
            } catch (error) {
              workerError('page-processing', `Failed to generate questions for chunk`, error);
            }
          }

          const chunkData: any = {
            tenantId,
            indexId,
            documentId,
            content: mdChunk.text,
            tokenCount: mdChunk.text.split(/\s+/).length, // approximate
            chunkIndex: chunkIndex,
            pageNumber: pages[0]?.pageNumber ?? 1,
            metadata: {
              chunkType: 'markdown-structure',
              sectionPath: mdChunk.metadata.sectionPath,
              containsCode: mdChunk.metadata.containsCode,
              containsTable: mdChunk.metadata.containsTable,
              containsList: mdChunk.metadata.containsList,
              startLine: mdChunk.metadata.startLine,
              endLine: mdChunk.metadata.endLine,
            },
            ...(chunkSummary ? { summary: chunkSummary } : {}),
            canonicalMetadata: null,
            status: ChunkStatus.PENDING,
          };

          chunks.push(chunkData);
          chunkIndex++;
        }
      }

      // Mark all pages as processed
      await DocumentPage.updateMany(
        { _id: { $in: pageIds }, documentId, indexId },
        { $set: { status: 'processed' } },
      );
    } else if (pipelineChunking && pipelineChunkSize && !forcePageLevel) {
      // ═══════════════════════════════════════════════════════════════════════
      // PIPELINE-DRIVEN CHUNKING (from pipeline stage providerConfig)
      // ═══════════════════════════════════════════════════════════════════════
      const chunkSize = pipelineChunkSize;
      const chunkOverlap = pipelineChunkOverlap ?? 200;
      const method = pipelineChunking.provider === 'fixed-size' ? 'fixed' : ('semantic' as const);

      workerLog(
        'page-processing',
        `Using pipeline chunking: provider=${pipelineChunking.provider}`,
        {
          chunkSize,
          chunkOverlap,
          method,
          pipelineId: pipelineChunking.pipelineId,
          flowId: pipelineChunking.flowId,
        },
      );

      // Reconstruct full text from all pages and build a char-offset→page lookup
      const pageDelimiter = '\n\n';
      const fullText = pages.map((p) => p.text).join(pageDelimiter);

      // Build cumulative offsets so we can map charStart → page
      const pageOffsets: Array<{ start: number; end: number; pageNumber: number }> = [];
      let offset = 0;
      for (let pi = 0; pi < pages.length; pi++) {
        const len = pages[pi].text.length;
        pageOffsets.push({
          start: offset,
          end: offset + len,
          pageNumber: pages[pi].pageNumber ?? pi + 1,
        });
        offset += len + pageDelimiter.length;
      }

      if (fullText.trim().length === 0) {
        workerLog('page-processing', 'No text content found in pages, skipping chunking');
      } else {
        const chunkingService = new ChunkingService();
        const textChunks = chunkingService.chunk(fullText, {
          strategy: method,
          chunkSize,
          chunkOverlap,
          respectBoundaries: true,
        });

        workerLog(
          'page-processing',
          `Created ${textChunks.length} chunks using pipeline config (chunkSize=${chunkSize})`,
        );

        for (const textChunk of textChunks) {
          const chunkData: any = {
            tenantId,
            indexId,
            documentId,
            content: textChunk.content,
            tokenCount: textChunk.tokenCount,
            chunkIndex: textChunk.index,
            metadata: {
              chunkType: 'pipeline-driven',
              strategy: method,
              provider: pipelineChunking.provider,
              pipelineId: pipelineChunking.pipelineId,
              charStart: textChunk.charStart,
              charEnd: textChunk.charEnd,
              originalTokenCount: textChunk.tokenCount,
            },
          };

          // Determine page reference by matching chunk charStart to page offsets
          const matchedPage = pageOffsets.find(
            (po) => textChunk.charStart >= po.start && textChunk.charStart < po.end,
          );
          if (matchedPage) {
            chunkData.pageNumber = matchedPage.pageNumber;
          } else if (pages[0]) {
            chunkData.pageNumber = pages[0].pageNumber ?? 1;
          }

          chunks.push(chunkData);
        }
      }

      // Mark all pages as processed (prevents re-processing loop)
      await DocumentPage.updateMany(
        { _id: { $in: pageIds }, documentId, indexId },
        { $set: { status: 'processed' } },
      );
    } else if (index?.tokenChunkStrategy) {
      // ═══════════════════════════════════════════════════════════════════════
      // TOKEN-BASED CHUNKING (ChunkingService)
      // ═══════════════════════════════════════════════════════════════════════
      workerLog(
        'page-processing',
        `Using token-based chunking: ${index.tokenChunkStrategy.method}`,
        {
          chunkSize: index.tokenChunkStrategy.chunkSize,
          chunkOverlap: index.tokenChunkStrategy.chunkOverlap,
        },
      );

      // Reconstruct full text from all pages
      const fullText = pages.map((p) => p.text).join('\n\n');

      if (fullText.trim().length === 0) {
        workerLog('page-processing', `No text content found in pages, skipping chunking`);
      } else {
        // Use ChunkingService with configured strategy
        const chunkingService = new ChunkingService();
        const textChunks = chunkingService.chunk(fullText, {
          strategy: index.tokenChunkStrategy.method,
          chunkSize: index.tokenChunkStrategy.chunkSize,
          chunkOverlap: index.tokenChunkStrategy.chunkOverlap,
          respectBoundaries: true, // Respect paragraph boundaries for semantic strategy
        });

        workerLog('page-processing', `Created ${textChunks.length} chunks using ChunkingService`);

        // Convert TextChunks to SearchChunks
        for (const textChunk of textChunks) {
          const chunkData: any = {
            tenantId,
            indexId,
            documentId,
            content: textChunk.content,
            tokenCount: textChunk.tokenCount,
            chunkIndex: textChunk.index,
            metadata: {
              chunkType: 'token-based',
              strategy: index.tokenChunkStrategy.method,
              charStart: textChunk.charStart,
              charEnd: textChunk.charEnd,
              originalTokenCount: textChunk.tokenCount,
            },
            canonicalMetadata: null,
            status: ChunkStatus.PENDING,
          };

          chunks.push(chunkData);

          // Generate questions for chunk if enabled
          if (questionService && textChunk.content.trim().length > 0) {
            try {
              const questionResult = await questionService.generateQuestions(textChunk.content, {
                documentTitle,
                sectionHeading: `Chunk ${textChunk.index + 1}`,
              });

              for (let qIdx = 0; qIdx < questionResult.questions.length; qIdx++) {
                const q = questionResult.questions[qIdx];
                chunkQuestions.push({
                  tenantId,
                  indexId,
                  documentId,
                  chunkId: null,
                  chunkIndex: chunkData.chunkIndex,
                  question: q.question,
                  scope: 'chunk',
                  questionType: q.questionType,
                  confidence: q.confidence,
                  questionIndex: qIdx,
                  status: 'pending',
                });
              }

              workerLog(
                'page-processing',
                `Generated ${questionResult.questions.length} questions for chunk ${textChunk.index}`,
                {
                  tokens: questionResult.totalTokens,
                  cost: questionResult.cost.toFixed(6),
                },
              );
            } catch (error) {
              workerError(
                'page-processing',
                `Failed to generate questions for chunk ${textChunk.index}`,
                error,
              );
            }
          }
        }
      }

      // Mark all pages as processed
      await DocumentPage.updateMany(
        { _id: { $in: pageIds }, documentId, indexId },
        { $set: { status: 'processed' } },
      );
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // PAGE-BASED CHUNKING (Docling - Default)
      // ═══════════════════════════════════════════════════════════════════════
      workerLog('page-processing', `Using page-based chunking (Docling default)`);

      // ── 2.1. Markdown-aware chunking ──────────────────────────────────────────
      // For markdown, DOCX, HTML, and plain text documents, use structure-aware
      // chunking. Docling exports DOCX/HTML as markdown with headings (## Section),
      // and plain text files may also contain heading markers. The markdown chunker
      // splits on H1/H2 headings when present; if no headings exist, the text
      // remains as a single chunk (same behavior as page-based).
      const MARKDOWN_CHUNKABLE_TYPES = new Set([
        'text/markdown',
        'text/plain', // .txt — split on headings if present
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
        'application/msword', // .doc
        'text/html',
      ]);
      const useMarkdownChunking = MARKDOWN_CHUNKABLE_TYPES.has(document?.contentType ?? '');

      if (useMarkdownChunking && pages.length > 0) {
        workerLog('page-processing', `Using structure-aware chunking for ${document?.contentType}`);

        // Reconstruct full markdown text from all pages
        const fullMarkdown = pages.map((p) => p.text).join('\n\n');

        // Chunk markdown with structure awareness (token-based, merge-up strategy)
        const markdownChunks = chunkMarkdown(fullMarkdown, {
          headingLevels: [1, 2, 3], // Split on H1, H2, H3
          preserveCodeBlocks: true,
          preserveTables: true,
          preserveLists: true,
        });

        workerLog(
          'page-processing',
          `Created ${markdownChunks.length} structure-aware chunks from markdown`,
        );

        // Convert markdown chunks to SearchChunks
        for (const mdChunk of markdownChunks) {
          // Generate progressive summary if enabled
          let chunkSummary: string | null = null;
          if (summarizationService && mdChunk.text.trim().length > 0) {
            try {
              const summaryResult = await summarizationService.summarizeChunk(
                mdChunk.text,
                currentSummary,
                {
                  documentTitle,
                  sectionHeading: mdChunk.metadata.sectionPath.join(' > '),
                },
              );
              chunkSummary = summaryResult.summary;
              currentSummary = chunkSummary;

              workerLog('page-processing', `Generated summary for markdown chunk ${chunkIndex}`, {
                tokens: summaryResult.totalTokens,
                cost: summaryResult.cost.toFixed(6),
              });
            } catch (error) {
              workerError(
                'page-processing',
                `Failed to generate summary for markdown chunk`,
                error,
              );
            }
          }

          const chunkData: any = {
            tenantId,
            indexId,
            documentId,
            content: mdChunk.text,
            tokenCount: countTokens(mdChunk.text), // Accurate token count using tiktoken
            chunkIndex: chunkIndex++,
            metadata: {
              chunkType: 'markdown-section',
              sectionPath: mdChunk.metadata.sectionPath,
              containsCode: mdChunk.metadata.containsCode,
              containsTable: mdChunk.metadata.containsTable,
              containsList: mdChunk.metadata.containsList,
              startLine: mdChunk.metadata.startLine,
              endLine: mdChunk.metadata.endLine,
              progressiveSummary: chunkSummary,
            },
            canonicalMetadata: null,
            status: ChunkStatus.PENDING,
          };

          chunks.push(chunkData);

          // Generate questions for chunk if enabled
          if (questionService && mdChunk.text.trim().length > 0) {
            try {
              const questionResult = await questionService.generateQuestions(mdChunk.text, {
                documentTitle,
                sectionHeading: mdChunk.metadata.sectionPath.join(' > '),
              });

              for (let qIdx = 0; qIdx < questionResult.questions.length; qIdx++) {
                const q = questionResult.questions[qIdx];
                chunkQuestions.push({
                  tenantId,
                  indexId,
                  documentId,
                  chunkId: null,
                  chunkIndex: chunkData.chunkIndex,
                  question: q.question,
                  scope: 'chunk',
                  questionType: q.questionType,
                  confidence: q.confidence,
                  questionIndex: qIdx,
                  status: 'pending',
                });
              }

              workerLog(
                'page-processing',
                `Generated ${questionResult.questions.length} questions for markdown chunk ${chunkData.chunkIndex}`,
                {
                  tokens: questionResult.totalTokens,
                  cost: questionResult.cost.toFixed(6),
                },
              );
            } catch (error) {
              workerError(
                'page-processing',
                `Failed to generate questions for markdown chunk`,
                error,
              );
            }
          }
        }

        // Mark all pages as processed
        await DocumentPage.updateMany(
          { _id: { $in: pageIds }, documentId, indexId },
          { $set: { status: 'processed' } },
        );
      } else {
        // Non-markdown: page-based chunking with true parallel LLM calls.
        //
        // Parallelism strategy (Opt 1 + Opt 2):
        //   - Question generation is page-independent → fire ALL pages concurrently
        //   - Progressive summarization chains page-to-page → must be sequential
        //   - Run both streams in parallel: questions for all pages start immediately
        //     while summaries walk sequentially. The slower stream determines total time.
        //
        // For 15 pages with ~2.5s/summary and ~2.5s/questions:
        //   Before: 15 × (2.5 + 2.5) = 75s serial
        //   After:  max(15 × 2.5 sequential, 15 × 2.5 / concurrency parallel) ≈ 37s

        const QUESTION_CONCURRENCY = parseInt(process.env.PAGE_LLM_CONCURRENCY || '5', 10);

        workerLog(
          'page-processing',
          `Processing ${pages.length} pages (question concurrency=${QUESTION_CONCURRENCY})`,
        );

        // ── Two parallel streams: questions (concurrent) + summaries (sequential) ──
        // Both streams run simultaneously via Promise.all. Total time =
        // max(summary_chain_time, question_concurrent_time) instead of the sum.

        type QResult = {
          pageNumber: number;
          result: Awaited<ReturnType<QuestionSynthesisService['generateQuestions']>>;
        } | null;

        // Build question task factories (lazy — not started until runWithConcurrency calls them)
        const questionFactories: (() => Promise<QResult>)[] = questionService
          ? pages.map((page) => async (): Promise<QResult> => {
              if (page.text.trim().length === 0) return null;
              try {
                const result = await questionService!.generateQuestions(page.text, {
                  documentTitle,
                  sectionHeading: page.layout.headings[0]?.text,
                });
                workerLog(
                  'page-processing',
                  `Generated ${result.questions.length} questions for page ${page.pageNumber}`,
                  { tokens: result.totalTokens, cost: result.cost.toFixed(6) },
                );
                return { pageNumber: page.pageNumber, result };
              } catch (error) {
                workerError(
                  'page-processing',
                  `Failed to generate questions for page ${page.pageNumber}`,
                  error,
                );
                return null;
              }
            })
          : [];

        // Summary generation: sequential (chains page→page), runs as a single async task
        const pageSummaries = new Map<number, string | null>();
        const summaryTask = async (): Promise<void> => {
          for (const page of pages) {
            let pageSummary: string | null = null;
            if (summarizationService && page.text.trim().length > 0) {
              try {
                const summaryResult = await summarizationService.summarizeChunk(
                  page.text,
                  currentSummary,
                  {
                    documentTitle,
                    pageNumber: page.pageNumber,
                    sectionHeading: page.layout.headings[0]?.text,
                  },
                );
                pageSummary = summaryResult.summary;
                currentSummary = pageSummary;

                workerLog('page-processing', `Generated summary for page ${page.pageNumber}`, {
                  tokens: summaryResult.totalTokens,
                  cost: summaryResult.cost.toFixed(6),
                });
              } catch (error) {
                workerError(
                  'page-processing',
                  `Failed to generate summary for page ${page.pageNumber}`,
                  error,
                );
              }
            }
            pageSummaries.set(page.pageNumber, pageSummary);
          }
        };

        // Run both streams in parallel — total time = max(summaries, questions)
        const [, allQuestionResults] = await Promise.all([
          summaryTask(),
          questionFactories.length > 0
            ? runWithConcurrency(questionFactories, QUESTION_CONCURRENCY)
            : Promise.resolve([] as PromiseSettledResult<QResult>[]),
        ]);

        // Index question results by page number
        const questionsByPage = new Map<number, QResult>();
        for (let i = 0; i < pages.length && i < allQuestionResults.length; i++) {
          const settled = allQuestionResults[i];
          if (settled.status === 'fulfilled' && settled.value) {
            questionsByPage.set(settled.value.pageNumber, settled.value);
          }
        }

        // ── Build chunks and attach results from both streams ────────────────
        for (const page of pages) {
          const pageSummary = pageSummaries.get(page.pageNumber) ?? null;

          const hasOnlyTables =
            page.tables.length > 0 &&
            page.text.trim().length > 0 &&
            page.tables.every((table: any) => page.text.includes(table.markdown));
          let totalTableChars = 0;
          for (const table of page.tables) {
            totalTableChars += table.markdown.length;
          }
          const nonTableContent = page.text.trim().length - totalTableChars;
          const isTableOnlyPage = hasOnlyTables && nonTableContent < 50;

          const hasPageImages = page.images && page.images.length > 0;
          if ((page.text.trim().length > 0 && !isTableOnlyPage) || hasPageImages) {
            const chunkContent =
              page.text.trim().length > 0 ? page.text : `[Image: ${documentTitle || 'Untitled'}]`;
            const chunkData: any = {
              tenantId,
              indexId,
              documentId,
              content: chunkContent,
              tokenCount: countTokens(chunkContent),
              chunkIndex: chunkIndex++,
              metadata: {
                pageNumber: page.pageNumber,
                pageId: page._id,
                chunkType: 'page',
                hasImages: page.images.length > 0,
                hasTables: page.tables.length > 0,
                images: page.images.length > 0 ? page.images : undefined,
                tables: page.tables.length > 0 ? page.tables : undefined,
                headings: page.layout.headings.map((h: any) => ({
                  level: h.level,
                  text: h.text,
                })),
                progressiveSummary: pageSummary,
              },
              canonicalMetadata: null,
              status: ChunkStatus.PENDING,
            };

            chunks.push(chunkData);

            // Attach questions from parallel results
            const qResult = questionsByPage.get(page.pageNumber);
            if (qResult) {
              for (let qIdx = 0; qIdx < qResult.result.questions.length; qIdx++) {
                const q = qResult.result.questions[qIdx];
                chunkQuestions.push({
                  tenantId,
                  indexId,
                  documentId,
                  chunkId: null,
                  chunkIndex: chunkData.chunkIndex,
                  question: q.question,
                  scope: 'chunk',
                  questionType: q.questionType,
                  confidence: q.confidence,
                  questionIndex: qIdx,
                  status: 'pending',
                });
              }
            }
          }

          // Extract tables as separate chunks
          for (let tableIdx = 0; tableIdx < page.tables.length; tableIdx++) {
            const table = page.tables[tableIdx];
            chunks.push({
              tenantId,
              indexId,
              documentId,
              content: table.markdown,
              tokenCount: countTokens(table.markdown),
              chunkIndex: chunkIndex++,
              metadata: {
                pageNumber: page.pageNumber,
                pageId: page._id,
                chunkType: 'table',
                tableIndex: tableIdx,
                tableHeaders: table.headers,
                isComplete: table.isComplete,
              },
              canonicalMetadata: null,
              status: ChunkStatus.PENDING,
            });
          }
        }

        // Mark all pages as processed
        await DocumentPage.updateMany(
          { _id: { $in: pageIds }, documentId, indexId },
          { $set: { status: 'processed' } },
        );
      } // End of non-markdown path
    } // End of page-based chunking (else block)

    // ── 3. Insert chunks ──────────────────────────────────────────────────────
    let insertedChunks: any[] = [];

    if (chunks.length > 0) {
      workerLog('page-processing', `Inserting ${chunks.length} chunks into MongoDB`);

      for (const chunk of chunks) {
        chunk.flowId = documentFlowId;
      }

      try {
        insertedChunks = await SearchChunk.insertMany(chunks, { ordered: true });
        workerLog('page-processing', `Created ${insertedChunks.length} chunks successfully`);
      } catch (error) {
        workerError('page-processing', `Failed to insert chunks`, error);
        throw error;
      }
    } else {
      workerLog('page-processing', `No chunks created (all pages empty)`);
    }

    // ── 3b. Insert questions and link to chunks ───────────────────────────────
    if (chunkQuestions.length > 0 && insertedChunks.length > 0) {
      workerLog('page-processing', `Inserting ${chunkQuestions.length} questions into MongoDB`);

      // Map chunkIndex to actual chunkId
      const chunkIndexToId = new Map<number, string>();
      for (const chunk of insertedChunks) {
        chunkIndexToId.set(chunk.chunkIndex, chunk._id);
      }

      // Update chunkId for questions
      for (const question of chunkQuestions) {
        const chunkId = chunkIndexToId.get(question.chunkIndex);
        if (chunkId) {
          question.chunkId = chunkId;
        }
        delete question.chunkIndex; // Remove temporary field
      }

      // Insert questions
      try {
        await ChunkQuestion.insertMany(chunkQuestions);
        workerLog('page-processing', `Created ${chunkQuestions.length} questions successfully`);
      } catch (error) {
        workerError('page-processing', `Failed to insert questions`, error);
        // Don't throw - questions are optional
      }
    }

    // ── 4. Check if more pages remain ─────────────────────────────────────────
    const remainingPages = await DocumentPage.find({
      documentId,
      indexId,
      status: 'pending',
    })
      .select('_id')
      .sort({ pageNumber: 1 })
      .limit(PAGES_PER_BATCH);

    if (remainingPages.length > 0) {
      const nextBatchData: PageProcessingJobData = {
        indexId,
        documentId,
        tenantId,
        pageIds: remainingPages.map((p: any) => p._id),
        previousPageSummary: currentSummary,
        pipelineStage: job.data.pipelineStage,
      };

      await createQueue(QUEUE_PAGE_PROCESSING).add(
        `page-processing:${documentId}:${Date.now()}`,
        nextBatchData,
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );

      workerLog('page-processing', `Enqueued next batch with ${remainingPages.length} pages`, {
        hasContext: !!currentSummary,
      });
    } else {
      workerLog(
        'page-processing',
        `All pages processed, generating document-level summary and questions`,
      );

      // ── 4a. Generate document-level summary ────────────────────────────────
      if (summarizationService) {
        try {
          const allChunks = await SearchChunk.find({
            documentId,
            indexId,
            tenantId,
            'metadata.chunkType': { $in: ['page', 'markdown-section'] },
            'metadata.progressiveSummary': { $exists: true, $ne: null },
          })
            .sort({ chunkIndex: 1 })
            .select('metadata.progressiveSummary')
            .lean();

          const chunkSummaries = allChunks
            .map((c: any) => c.metadata?.progressiveSummary)
            .filter(Boolean);

          if (chunkSummaries.length > 0) {
            const docSummaryResult = await summarizationService.summarizeDocument(chunkSummaries, {
              documentTitle,
              totalPages: chunkSummaries.length,
            });

            await SearchDocument.findOneAndUpdate(
              { _id: documentId, tenantId },
              {
                $set: {
                  'metadata.documentSummary': docSummaryResult.summary,
                  'metadata.summaryTokens': docSummaryResult.totalTokens,
                  'metadata.summaryCost': docSummaryResult.cost,
                },
              },
            );

            workerLog('page-processing', `Generated document-level summary`, {
              chunkSummaries: chunkSummaries.length,
              tokens: docSummaryResult.totalTokens,
              cost: docSummaryResult.cost.toFixed(6),
            });
          }
        } catch (error) {
          workerError('page-processing', `Failed to generate document-level summary`, error);
        }
      }

      // ── 4b. Enqueue question synthesis for document-level questions ────────
      if (questionService) {
        await createQueue(QUEUE_QUESTION_SYNTHESIS).add(
          `question-synthesis:${documentId}`,
          { indexId, documentId, tenantId } satisfies QuestionSynthesisJobData,
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
        );
        workerLog('page-processing', `Enqueued question synthesis for document-level questions`);
      }

      // ── 4c. Enqueue visual enrichment ───────────────────────────────────────
      if (llmConfig.useCases.vision.enabled) {
        const chunksWithPages = await SearchChunk.find({
          documentId,
          indexId,
          tenantId,
        })
          .select('_id metadata.pageNumber metadata.hasImages')
          .sort({ 'metadata.pageNumber': 1 })
          .lean();

        const firstPage = chunksWithPages.find((c: any) => c.metadata?.pageNumber === 1);
        if (firstPage && firstPage.metadata?.hasImages) {
          const visualData: import('./shared.js').VisualEnrichmentJobData = {
            tenantId,
            indexId,
            documentId,
            pageNumber: 1,
            chunkId: firstPage._id.toString(),
          };

          await createQueue(QUEUE_VISUAL_ENRICHMENT).add('enrich-page', visualData, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
          });

          workerLog(
            'page-processing',
            `Enqueued visual enrichment starting from page 1 (${chunksWithPages.length} total pages)`,
          );
        } else {
          workerLog('page-processing', `No images on page 1, skipping visual enrichment`);
        }
      }

      // ── 4e. Update document and enqueue canonical mapping ──────────────────
      const totalChunks = await SearchChunk.countDocuments({ documentId, indexId, tenantId });

      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.EXTRACTED,
          chunkCount: totalChunks,
        },
      );

      workerLog('page-processing', `Updated document with ${totalChunks} chunks`);

      await createQueue(QUEUE_CANONICAL_MAP).add(
        `canonical-map:${documentId}`,
        { indexId, documentId, tenantId } satisfies CanonicalMapJobData,
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
    }
  });
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

export default function createPageProcessingWorker(concurrency = 3): Worker<PageProcessingJobData> {
  const worker = new Worker(
    QUEUE_PAGE_PROCESSING,
    processPageProcessingJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) =>
    workerLog('page-processing', `Job ${job.id} completed`, { documentId: job.data.documentId }),
  );

  worker.on('failed', (job, err) => workerError('page-processing', `Job ${job?.id} failed`, err));

  workerLog('page-processing', `Started with concurrency=${concurrency}`);
  return worker;
}
