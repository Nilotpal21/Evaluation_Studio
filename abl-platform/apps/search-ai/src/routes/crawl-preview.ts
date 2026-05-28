/**
 * Crawl Preview Route
 *
 * POST /api/crawl/preview — Fetches a URL, runs Readability extraction,
 * and returns a preview without ingesting. Used by Step 3 of the crawl flow
 * to let users inspect extraction quality before committing to a full crawl.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { ValidationError } from '@agent-platform/shared-kernel';
import { getModel } from '../db/index.js';
import { validateAndFetchURL } from '../utils/ssrf-protection.js';
import { readabilityService } from '../services/readability/index.js';
import { searchAiRateLimit } from '../middleware/rate-limit.js';

const router: RouterType = Router();
const log = createLogger('crawl-preview');

// ─── Validation ─────────────────────────────────────────────────────────────

const previewSchema = z.object({
  url: z.string().url(),
  baseUrl: z.string().url(),
});

// ─── Rate Limit: 10 requests/min/tenant (own counter, not shared with global) ─

// eslint-disable-next-line @typescript-eslint/no-explicit-any
router.use(searchAiRateLimit({ limit: 10, windowMs: 60_000, operation: 'preview' }) as any);

// ─── Pure Logic Helpers (exported for testing) ──────────────────────────────

/** Check that two URLs share the same origin */
export function checkOriginMatch(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Count words in text content */
export function computeWordCount(textContent: string): number {
  return textContent.split(/\s+/).filter(Boolean).length;
}

/** Count <img> tags in HTML */
export function computeImageCount(html: string): number {
  return (html.match(/<img/gi) || []).length;
}

/** Detect if a page likely requires JS rendering */
export function detectJsRendering(textContentLength: number, rawHtmlLength: number): boolean {
  return textContentLength < 100 && rawHtmlLength > 10_000;
}

/** Truncate HTML to a max byte limit */
export function truncateHtml(html: string, maxLength: number): string {
  return html.substring(0, maxLength);
}

/** Generate an excerpt from text content */
export function generateExcerpt(text: string, maxLength: number = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.substring(0, maxLength).trimEnd() + '…';
}

/** Classify a caught error into a structured API error response shape */
export function classifyPreviewError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof ValidationError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'This URL cannot be previewed for security reasons',
    };
  }
  if (error instanceof Error && error.message.includes('timeout')) {
    return {
      status: 504,
      code: 'TIMEOUT',
      message: 'Page took too long to respond',
    };
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Failed to preview this page',
  };
}

// ─── Max cleaned HTML size in response ──────────────────────────────────────

const MAX_PREVIEW_HTML = 50_000; // 50KB

// ─── POST /preview ──────────────────────────────────────────────────────────

router.post('/preview', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Auth check
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    // Validate body
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        },
      });
      return;
    }

    const { url, baseUrl } = parsed.data;

    // Origin check
    if (!checkOriginMatch(url, baseUrl)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'ORIGIN_MISMATCH',
          message: 'Preview URL must be on the same domain as the base URL',
        },
      });
      return;
    }

    // Ownership check — user must have a source with matching baseUrl origin
    const { tenantId } = req.tenantContext;
    const SearchSource = getModel('SearchSource');
    const baseOrigin = new URL(baseUrl).origin;

    // Find any source for this tenant whose sourceConfig.url starts with the same origin
    const source = await SearchSource.findOne({
      tenantId,
      sourceType: 'web',
      'sourceConfig.url': { $regex: `^${baseOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
    }).lean();

    if (!source) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NO_SOURCE',
          message: 'No web source found for this domain',
        },
      });
      return;
    }

    // Fetch the URL with SSRF protection
    const rawHtml = await validateAndFetchURL(url);

    // Run Readability extraction
    const result = readabilityService.cleanHTML(rawHtml, url);

    if (!result.success) {
      res.status(422).json({
        success: false,
        error: {
          code: 'EXTRACTION_FAILED',
          message: 'Could not extract content from this page',
        },
      });
      return;
    }

    // Compute metrics
    const textContent =
      result.cleanedHTML
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '';
    const wordCount = computeWordCount(textContent);
    const imageCount = computeImageCount(result.cleanedHTML);
    const jsRenderingAdvised = detectJsRendering(textContent.length, rawHtml.length);
    const cleanedHtml = truncateHtml(result.cleanedHTML, MAX_PREVIEW_HTML);
    const excerpt = generateExcerpt(result.metadata.excerpt || textContent);

    const durationMs = Date.now() - startTime;
    log.info('Preview extracted', { url, wordCount, durationMs });

    res.json({
      success: true,
      data: {
        url,
        title: result.metadata.title,
        excerpt,
        cleanedHtml,
        wordCount,
        imageCount,
        metadata: {
          contentLength: result.metadata.contentLength,
          textContentLength: result.metadata.textContentLength,
          sizeReduction: result.metadata.sizeReduction,
          originalSize: result.metadata.originalSize,
          cleanedSize: result.metadata.cleanedSize,
        },
        jsRenderingAdvised,
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const classified = classifyPreviewError(error);

    const logLevel = classified.status < 500 ? 'warn' : 'error';
    log[logLevel](`Preview ${classified.code.toLowerCase()}`, {
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(classified.status).json({
      success: false,
      error: { code: classified.code, message: classified.message },
    });
  }
});

export default router;
