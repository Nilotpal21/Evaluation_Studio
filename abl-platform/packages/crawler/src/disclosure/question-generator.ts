/**
 * Question Generator - User-friendly prompt questions
 *
 * Generates clear, non-technical questions based on:
 * - Decision ambiguity (low confidence)
 * - Site profile characteristics
 * - Alternative strategies
 *
 * Design Principles:
 * - Clear Language: No technical jargon
 * - Context First: Explain why we're asking
 * - Recommend: Suggest best option
 * - Limit: Max 4 questions per session
 */

import type { CrawlDecision, DecisionContext, Alternative } from '../decision/interfaces.js';
import type { SiteProfile } from '../profiler/interfaces.js';

/**
 * Question types
 */
export type QuestionType = 'choice' | 'confirm' | 'range';

/**
 * Question option (for choice questions)
 */
export interface QuestionOption {
  /** Value to return if selected */
  value: string;

  /** Display label */
  label: string;

  /** Detailed description */
  description: string;

  /** Whether this is recommended */
  recommended?: boolean;

  /** Expected outcome if chosen */
  expectedOutcome?: {
    speed?: string; // e.g., "Fast", "Moderate", "Slow"
    reliability?: string; // e.g., "Very Reliable", "Reliable", "May Miss Content"
    duration?: string; // e.g., "~30 seconds", "~2 minutes"
  };
}

/**
 * Prompt Question
 */
export interface PromptQuestion {
  /** Unique question ID */
  id: string;

  /** Question type */
  type: QuestionType;

  /** The question to ask (clear, non-technical) */
  question: string;

  /** Context/background to help answer */
  context: string;

  /** Options for choice questions */
  options?: QuestionOption[];

  /** Default value */
  defaultValue?: string | number | boolean;

  /** Range for numeric questions */
  range?: {
    min: number;
    max: number;
    step: number;
  };

  /** Priority (higher = more important) */
  priority: number;
}

/**
 * Question Generator Options
 */
export interface QuestionGeneratorOptions {
  /** Maximum questions to generate (default: 4) */
  maxQuestions?: number;

  /** Minimum confidence to ask strategy question (default: 70) */
  strategyConfidenceThreshold?: number;

  /** Whether to include outcome estimates (default: true) */
  includeOutcomeEstimates?: boolean;
}

/**
 * Question Generator
 *
 * Generates user-friendly questions based on decision uncertainty
 */
export class QuestionGenerator {
  private readonly maxQuestions: number;
  private readonly strategyConfidenceThreshold: number;
  private readonly includeOutcomeEstimates: boolean;

  constructor(options: QuestionGeneratorOptions = {}) {
    this.maxQuestions = options.maxQuestions ?? 4;
    this.strategyConfidenceThreshold = options.strategyConfidenceThreshold ?? 70;
    this.includeOutcomeEstimates = options.includeOutcomeEstimates ?? true;
  }

  /**
   * Generate questions based on decision and profile
   */
  generate(decision: CrawlDecision, context: DecisionContext): PromptQuestion[] {
    const questions: PromptQuestion[] = [];
    const profile = context.profile;

    // Question 1: Strategy selection (if low confidence)
    if (decision.confidence < this.strategyConfidenceThreshold) {
      const strategyQ = this.generateStrategyQuestion(decision, profile);
      if (strategyQ) {
        questions.push(strategyQ);
      }
    }

    // Question 2: Batch size (if rate limits or large site)
    if (profile.rateLimitDetected || profile.estimatedSize > 500) {
      const batchSizeQ = this.generateBatchSizeQuestion(decision, profile);
      if (batchSizeQ) {
        questions.push(batchSizeQ);
      }
    }

    // Question 3: JavaScript handling (if unclear)
    if (profile.siteType === 'unknown' || profile.siteType === 'hybrid') {
      const jsQ = this.generateJavaScriptQuestion(decision, profile);
      if (jsQ) {
        questions.push(jsQ);
      }
    }

    // Question 4: Concurrency (if rate limits or slow responses)
    if (profile.rateLimitDetected || profile.avgResponseTime > 2000) {
      const concurrencyQ = this.generateConcurrencyQuestion(decision, profile);
      if (concurrencyQ) {
        questions.push(concurrencyQ);
      }
    }

    // Sort by priority and limit to max
    return questions.sort((a, b) => b.priority - a.priority).slice(0, this.maxQuestions);
  }

  // ========================================
  // Private: Question Generators
  // ========================================

  /**
   * Generate strategy selection question
   */
  private generateStrategyQuestion(
    decision: CrawlDecision,
    profile: SiteProfile,
  ): PromptQuestion | null {
    const context = this.buildStrategyContext(decision, profile);
    const options = this.buildStrategyOptions(decision, profile);

    return {
      id: 'strategy',
      type: 'choice',
      question: 'How should we crawl this website?',
      context,
      options,
      defaultValue: 'auto',
      priority: 100, // Highest priority
    };
  }

  /**
   * Generate batch size question
   */
  private generateBatchSizeQuestion(
    decision: CrawlDecision,
    profile: SiteProfile,
  ): PromptQuestion | null {
    let context = `We'll crawl approximately ${profile.estimatedSize} pages.`;

    if (profile.rateLimitDetected) {
      context += ' Rate limiting detected - smaller batches are safer but slower.';
    } else if (profile.estimatedSize > 1000) {
      context += ' This is a large site - larger batches will be faster.';
    }

    context += ` Our recommendation: ${decision.batchSize} pages per batch.`;

    const min = profile.rateLimitDetected ? 5 : 10;
    const max = profile.rateLimitDetected ? 50 : 100;

    return {
      id: 'batchSize',
      type: 'range',
      question: 'How many pages should we process at once?',
      context,
      range: { min, max, step: 5 },
      defaultValue: decision.batchSize,
      priority: 60,
    };
  }

  /**
   * Generate JavaScript handling question
   */
  private generateJavaScriptQuestion(
    decision: CrawlDecision,
    profile: SiteProfile,
  ): PromptQuestion | null {
    let context = '';

    if (profile.siteType === 'hybrid') {
      context = 'This site has both static and dynamic content.';
    } else if (profile.siteType === 'unknown') {
      context = "We're not sure how much JavaScript this site uses.";
    }

    const options: QuestionOption[] = [
      {
        value: 'auto',
        label: 'Let the system decide (Recommended)',
        description: `We'll use our best guess based on the site type. Current: ${decision.jsHandling}`,
        recommended: true,
      },
      {
        value: 'none',
        label: 'Skip JavaScript',
        description: 'Faster but may miss content that loads dynamically.',
        expectedOutcome: {
          speed: 'Fast',
          reliability: 'Good for static sites',
        },
      },
      {
        value: 'static',
        label: 'Basic JavaScript',
        description: 'Handle simple JavaScript but skip complex interactions.',
        expectedOutcome: {
          speed: 'Moderate',
          reliability: 'Good for most sites',
        },
      },
      {
        value: 'dynamic',
        label: 'Full JavaScript',
        description: 'Wait for all JavaScript to finish. Slowest but most complete.',
        expectedOutcome: {
          speed: 'Slow',
          reliability: 'Best for SPAs',
        },
      },
    ];

    return {
      id: 'jsHandling',
      type: 'choice',
      question: 'How should we handle JavaScript on this site?',
      context,
      options,
      defaultValue: 'auto',
      priority: 80,
    };
  }

  /**
   * Generate concurrency question
   */
  private generateConcurrencyQuestion(
    decision: CrawlDecision,
    profile: SiteProfile,
  ): PromptQuestion | null {
    let context = '';

    if (profile.rateLimitDetected) {
      context = 'Rate limiting detected. Lower concurrency is safer to avoid getting blocked.';
    } else if (profile.avgResponseTime > 2000) {
      context = `The site is responding slowly (${profile.avgResponseTime}ms average). Lower concurrency reduces server load.`;
    }

    context += ` Our recommendation: ${decision.concurrency} concurrent requests.`;

    const min = profile.rateLimitDetected ? 1 : 2;
    const max = profile.rateLimitDetected ? 5 : 20;

    return {
      id: 'concurrency',
      type: 'range',
      question: 'How many pages should we fetch at the same time?',
      context,
      range: { min, max, step: 1 },
      defaultValue: decision.concurrency,
      priority: 40,
    };
  }

  // ========================================
  // Private: Context Builders
  // ========================================

  /**
   * Build context for strategy question
   */
  private buildStrategyContext(decision: CrawlDecision, profile: SiteProfile): string {
    const parts: string[] = [];

    // Site characteristics
    if (profile.siteType !== 'unknown') {
      const typeDescriptions = {
        static: 'mostly static HTML',
        spa: 'a Single Page Application (lots of JavaScript)',
        hybrid: 'mixed static and dynamic content',
      };
      parts.push(`This appears to be ${typeDescriptions[profile.siteType]}.`);
    }

    // Site size
    if (profile.estimatedSize > 0) {
      parts.push(`We estimate about ${profile.estimatedSize} pages to crawl.`);
    }

    // Performance characteristics
    if (profile.avgResponseTime > 1000) {
      parts.push(`The site responds slowly (${profile.avgResponseTime}ms per page).`);
    } else if (profile.avgResponseTime < 300) {
      parts.push('The site is very fast.');
    }

    // Rate limiting
    if (profile.rateLimitDetected) {
      parts.push('⚠️ Rate limiting detected.');
    }

    // Current recommendation
    parts.push(`Our recommendation: ${this.strategyToFriendlyName(decision.strategy)}.`);

    return parts.join(' ');
  }

  /**
   * Build strategy options
   */
  private buildStrategyOptions(decision: CrawlDecision, profile: SiteProfile): QuestionOption[] {
    const options: QuestionOption[] = [];

    // Auto option (recommended)
    options.push({
      value: 'auto',
      label: 'Let the system decide (Recommended)',
      description: `We'll choose the best approach automatically. Current: ${this.strategyToFriendlyName(decision.strategy)}`,
      recommended: true,
    });

    // Bulk option
    const bulkAlt = decision.alternatives?.find((a) => a.strategy === 'bulk');
    options.push({
      value: 'bulk',
      label: 'Fast Bulk Crawl',
      description: 'Use our high-speed crawler. Best for static sites with simple HTML.',
      expectedOutcome:
        this.includeOutcomeEstimates && bulkAlt
          ? {
              speed: 'Fast',
              reliability: 'Good for static sites',
              duration: this.formatDuration(bulkAlt.expectedOutcome.estimatedDuration),
            }
          : undefined,
    });

    // Browser option
    const browserAlt = decision.alternatives?.find((a) => a.strategy === 'browser');
    options.push({
      value: 'browser',
      label: 'Browser-Based Crawl',
      description: 'Use a real browser. Best for sites with JavaScript and dynamic content.',
      expectedOutcome:
        this.includeOutcomeEstimates && browserAlt
          ? {
              speed: 'Slower',
              reliability: 'Most complete',
              duration: this.formatDuration(browserAlt.expectedOutcome.estimatedDuration),
            }
          : undefined,
    });

    // Hybrid option
    const hybridAlt = decision.alternatives?.find((a) => a.strategy === 'hybrid');
    if (hybridAlt || decision.strategy === 'hybrid') {
      options.push({
        value: 'hybrid',
        label: 'Balanced Approach',
        description: 'Mix of fast and thorough. Good for sites with some JavaScript.',
        expectedOutcome:
          this.includeOutcomeEstimates && hybridAlt
            ? {
                speed: 'Moderate',
                reliability: 'Reliable',
                duration: this.formatDuration(hybridAlt.expectedOutcome.estimatedDuration),
              }
            : undefined,
      });
    }

    return options;
  }

  // ========================================
  // Private: Helpers
  // ========================================

  /**
   * Convert strategy to friendly name
   */
  private strategyToFriendlyName(strategy: string): string {
    const names: Record<string, string> = {
      browser: 'Browser-Based Crawl',
      bulk: 'Fast Bulk Crawl',
      hybrid: 'Balanced Approach',
    };
    return names[strategy] || strategy;
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `~${ms}ms`;
    } else if (ms < 60000) {
      const seconds = Math.round(ms / 1000);
      return `~${seconds} second${seconds !== 1 ? 's' : ''}`;
    } else {
      const minutes = Math.round(ms / 60000);
      return `~${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
  }
}
