/**
 * Quality Metrics Service
 *
 * Measures and validates extraction quality improvements.
 * Compares raw vs cleaned HTML to track noise reduction, content preservation,
 * and metadata extraction success.
 *
 * Metrics Tracked:
 * - Noise reduction: Percentage of non-content removed
 * - Content preservation: Main content retained vs lost
 * - Metadata extraction: Title, author, excerpt success rates
 * - Structure preservation: Headings, lists, tables detected
 * - Size reduction: Storage savings
 *
 * Use Cases:
 * - Production monitoring: Track quality over time
 * - A/B testing: Compare extraction algorithms
 * - Quality gates: Fail if quality drops below threshold
 * - Debugging: Identify problematic pages
 */

import { JSDOM } from 'jsdom';

// =============================================================================
// TYPES
// =============================================================================

export interface QualityMetrics {
  /** Document identifier (URL or ID) */
  documentId: string;
  /** Original URL */
  url: string;
  /** Timestamp of analysis */
  timestamp: Date;

  /** Size metrics */
  size: {
    rawBytes: number;
    cleanedBytes: number;
    reductionPercent: number;
  };

  /** Content metrics */
  content: {
    rawTextLength: number;
    cleanedTextLength: number;
    contentPreservationPercent: number; // How much content retained
  };

  /** Structure metrics */
  structure: {
    headingsRaw: number;
    headingsCleaned: number;
    headingsPreservedPercent: number;
    linksRaw: number;
    linksCleaned: number;
    imagesRaw: number;
    imagesCleaned: number;
    tablesRaw: number;
    tablesCleaned: number;
  };

  /** Noise metrics */
  noise: {
    navElementsRemoved: number;
    asideElementsRemoved: number;
    footerElementsRemoved: number;
    scriptTagsRemoved: number;
    styleTagsRemoved: number;
    estimatedNoisePercent: number; // Estimated percentage that was noise
  };

  /** Metadata extraction */
  metadata: {
    titleExtracted: boolean;
    authorExtracted: boolean;
    excerptExtracted: boolean;
    titleMatch: boolean; // Does extracted title match page title
  };

  /** Quality scores (0-100) */
  scores: {
    overall: number; // Weighted average of all metrics
    noiseReduction: number; // How well noise was removed
    contentPreservation: number; // How well content was kept
    structurePreservation: number; // How well structure was kept
    metadataExtraction: number; // How well metadata was extracted
  };
}

export interface QualityReport {
  /** Total documents analyzed */
  totalDocuments: number;
  /** Analysis period */
  period: {
    start: Date;
    end: Date;
  };

  /** Aggregate metrics */
  aggregate: {
    avgSizeReduction: number;
    avgContentPreservation: number;
    avgNoiseReduction: number;
    avgOverallScore: number;
  };

  /** Distribution */
  distribution: {
    excellent: number; // Score >= 90
    good: number; // Score >= 70
    fair: number; // Score >= 50
    poor: number; // Score < 50
  };

  /** Individual metrics */
  metrics: QualityMetrics[];
}

// =============================================================================
// SERVICE
// =============================================================================

export class QualityMetricsService {
  /**
   * Analyze quality metrics for raw vs cleaned HTML
   */
  analyzeQuality(
    documentId: string,
    url: string,
    rawHTML: string,
    cleanedHTML: string,
    extractedMetadata?: {
      title?: string;
      author?: string;
      excerpt?: string;
    },
  ): QualityMetrics {
    // Parse both versions
    const rawDom = new JSDOM(rawHTML);
    const cleanedDom = new JSDOM(cleanedHTML);

    const rawDoc = rawDom.window.document;
    const cleanedDoc = cleanedDom.window.document;

    // Calculate size metrics
    const rawBytes = Buffer.byteLength(rawHTML, 'utf-8');
    const cleanedBytes = Buffer.byteLength(cleanedHTML, 'utf-8');
    const reductionPercent = Math.round(((rawBytes - cleanedBytes) / rawBytes) * 100);

    // Calculate content metrics
    const rawText = this.extractText(rawDoc);
    const cleanedText = this.extractText(cleanedDoc);
    const contentPreservationPercent = Math.round((cleanedText.length / rawText.length) * 100);

    // Calculate structure metrics
    const structure = this.analyzeStructure(rawDoc, cleanedDoc);

    // Calculate noise metrics
    const noise = this.analyzeNoise(rawDoc, cleanedDoc);

    // Calculate metadata metrics
    const metadata = this.analyzeMetadata(rawDoc, extractedMetadata);

    // Calculate quality scores
    const scores = this.calculateScores({
      reductionPercent,
      contentPreservationPercent,
      structure,
      noise,
      metadata,
    });

    return {
      documentId,
      url,
      timestamp: new Date(),
      size: {
        rawBytes,
        cleanedBytes,
        reductionPercent,
      },
      content: {
        rawTextLength: rawText.length,
        cleanedTextLength: cleanedText.length,
        contentPreservationPercent,
      },
      structure,
      noise,
      metadata,
      scores,
    };
  }

  /**
   * Generate quality report from multiple metrics
   */
  generateReport(metrics: QualityMetrics[]): QualityReport {
    if (metrics.length === 0) {
      throw new Error('Cannot generate report with zero metrics');
    }

    // Calculate aggregates
    const totalDocs = metrics.length;
    const avgSizeReduction =
      metrics.reduce((sum, m) => sum + m.size.reductionPercent, 0) / totalDocs;
    const avgContentPreservation =
      metrics.reduce((sum, m) => sum + m.content.contentPreservationPercent, 0) / totalDocs;
    const avgNoiseReduction =
      metrics.reduce((sum, m) => sum + m.scores.noiseReduction, 0) / totalDocs;
    const avgOverallScore = metrics.reduce((sum, m) => sum + m.scores.overall, 0) / totalDocs;

    // Calculate distribution
    const distribution = {
      excellent: metrics.filter((m) => m.scores.overall >= 90).length,
      good: metrics.filter((m) => m.scores.overall >= 70 && m.scores.overall < 90).length,
      fair: metrics.filter((m) => m.scores.overall >= 50 && m.scores.overall < 70).length,
      poor: metrics.filter((m) => m.scores.overall < 50).length,
    };

    // Get time period
    const timestamps = metrics.map((m) => m.timestamp);
    const start = new Date(Math.min(...timestamps.map((t) => t.getTime())));
    const end = new Date(Math.max(...timestamps.map((t) => t.getTime())));

    return {
      totalDocuments: totalDocs,
      period: { start, end },
      aggregate: {
        avgSizeReduction: Math.round(avgSizeReduction),
        avgContentPreservation: Math.round(avgContentPreservation),
        avgNoiseReduction: Math.round(avgNoiseReduction),
        avgOverallScore: Math.round(avgOverallScore),
      },
      distribution,
      metrics,
    };
  }

  /**
   * Extract plain text from document
   */
  private extractText(doc: Document): string {
    // Remove script and style elements
    const scripts = doc.querySelectorAll('script, style');
    scripts.forEach((el) => el.remove());

    // Get text content
    const text = doc.body?.textContent || '';

    // Clean whitespace
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Analyze structure preservation
   */
  private analyzeStructure(rawDoc: Document, cleanedDoc: Document): QualityMetrics['structure'] {
    const headingsRaw = rawDoc.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
    const headingsCleaned = cleanedDoc.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
    const headingsPreservedPercent =
      headingsRaw > 0 ? Math.round((headingsCleaned / headingsRaw) * 100) : 100;

    const linksRaw = rawDoc.querySelectorAll('a[href]').length;
    const linksCleaned = cleanedDoc.querySelectorAll('a[href]').length;

    const imagesRaw = rawDoc.querySelectorAll('img').length;
    const imagesCleaned = cleanedDoc.querySelectorAll('img').length;

    const tablesRaw = rawDoc.querySelectorAll('table').length;
    const tablesCleaned = cleanedDoc.querySelectorAll('table').length;

    return {
      headingsRaw,
      headingsCleaned,
      headingsPreservedPercent,
      linksRaw,
      linksCleaned,
      imagesRaw,
      imagesCleaned,
      tablesRaw,
      tablesCleaned,
    };
  }

  /**
   * Analyze noise removal
   */
  private analyzeNoise(rawDoc: Document, cleanedDoc: Document): QualityMetrics['noise'] {
    const navElementsRaw = rawDoc.querySelectorAll('nav').length;
    const navElementsCleaned = cleanedDoc.querySelectorAll('nav').length;
    const navElementsRemoved = navElementsRaw - navElementsCleaned;

    const asideElementsRaw = rawDoc.querySelectorAll('aside').length;
    const asideElementsCleaned = cleanedDoc.querySelectorAll('aside').length;
    const asideElementsRemoved = asideElementsRaw - asideElementsCleaned;

    const footerElementsRaw = rawDoc.querySelectorAll('footer').length;
    const footerElementsCleaned = cleanedDoc.querySelectorAll('footer').length;
    const footerElementsRemoved = footerElementsRaw - footerElementsCleaned;

    const scriptTagsRaw = rawDoc.querySelectorAll('script').length;
    const scriptTagsCleaned = cleanedDoc.querySelectorAll('script').length;
    const scriptTagsRemoved = scriptTagsRaw - scriptTagsCleaned;

    const styleTagsRaw = rawDoc.querySelectorAll('style').length;
    const styleTagsCleaned = cleanedDoc.querySelectorAll('style').length;
    const styleTagsRemoved = styleTagsRaw - styleTagsCleaned;

    // Estimate noise percentage based on elements removed
    const totalNoiseElements =
      navElementsRemoved +
      asideElementsRemoved +
      footerElementsRemoved +
      scriptTagsRemoved +
      styleTagsRemoved;
    const totalRawElements = rawDoc.querySelectorAll('*').length;
    const estimatedNoisePercent =
      totalRawElements > 0 ? Math.round((totalNoiseElements / totalRawElements) * 100) : 0;

    return {
      navElementsRemoved,
      asideElementsRemoved,
      footerElementsRemoved,
      scriptTagsRemoved,
      styleTagsRemoved,
      estimatedNoisePercent,
    };
  }

  /**
   * Analyze metadata extraction
   */
  private analyzeMetadata(
    rawDoc: Document,
    extractedMetadata?: { title?: string; author?: string; excerpt?: string },
  ): QualityMetrics['metadata'] {
    const rawTitle = rawDoc.querySelector('title')?.textContent?.trim() || '';

    const titleExtracted = !!extractedMetadata?.title;
    const authorExtracted = !!extractedMetadata?.author;
    const excerptExtracted = !!extractedMetadata?.excerpt;

    // Check if extracted title matches page title (case-insensitive, fuzzy)
    const titleMatch = titleExtracted
      ? this.fuzzyMatch(extractedMetadata!.title!, rawTitle)
      : false;

    return {
      titleExtracted,
      authorExtracted,
      excerptExtracted,
      titleMatch,
    };
  }

  /**
   * Calculate quality scores
   */
  private calculateScores(data: {
    reductionPercent: number;
    contentPreservationPercent: number;
    structure: QualityMetrics['structure'];
    noise: QualityMetrics['noise'];
    metadata: QualityMetrics['metadata'];
  }): QualityMetrics['scores'] {
    // Noise reduction score (0-100)
    // Higher is better. We want 20-60% reduction.
    const noiseReduction = Math.min(100, Math.max(0, data.reductionPercent * 2));

    // Content preservation score (0-100)
    // We want 80-100% preservation
    const contentPreservation = Math.min(100, data.contentPreservationPercent);

    // Structure preservation score (0-100)
    // Based on headings preserved
    const structurePreservation = data.structure.headingsPreservedPercent;

    // Metadata extraction score (0-100)
    const metadataScore =
      (data.metadata.titleExtracted ? 40 : 0) +
      (data.metadata.titleMatch ? 20 : 0) +
      (data.metadata.authorExtracted ? 20 : 0) +
      (data.metadata.excerptExtracted ? 20 : 0);

    // Overall score (weighted average)
    const overall = Math.round(
      noiseReduction * 0.3 +
        contentPreservation * 0.3 +
        structurePreservation * 0.2 +
        metadataScore * 0.2,
    );

    return {
      overall,
      noiseReduction: Math.round(noiseReduction),
      contentPreservation: Math.round(contentPreservation),
      structurePreservation: Math.round(structurePreservation),
      metadataExtraction: Math.round(metadataScore),
    };
  }

  /**
   * Fuzzy string matching (case-insensitive, handles minor differences)
   */
  private fuzzyMatch(str1: string, str2: string): boolean {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const n1 = normalize(str1);
    const n2 = normalize(str2);

    // Exact match
    if (n1 === n2) return true;

    // One contains the other
    if (n1.includes(n2) || n2.includes(n1)) return true;

    // Calculate similarity (Levenshtein distance)
    const similarity = this.similarity(n1, n2);
    return similarity > 0.8; // 80% similarity threshold
  }

  /**
   * Calculate string similarity (0-1)
   */
  private similarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const costs: number[] = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }
}

// Singleton instance
export const qualityMetricsService = new QualityMetricsService();
