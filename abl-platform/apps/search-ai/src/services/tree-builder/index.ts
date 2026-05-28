/**
 * Tree Builder Service
 *
 * Orchestrates adaptive tree construction for ATLAS-KG Phase 2:
 * 1. Sentence-aligned chunking (no sentence split across boundaries)
 * 2. Semantic splitting (cosine similarity grouping)
 * 3. Constrained balancing (max depth 4, max children 10)
 * 4. Summary generation for internal nodes (LLM)
 *
 * Architecture:
 * - Leaf nodes are actual chunks with content
 * - Internal nodes have LLM-generated summaries
 * - Root node summarizes entire document
 */

import type { ChatLLMClient } from '@agent-platform/llm';
import type { Message } from '@abl/compiler/platform/llm/types';
import type { ISearchChunk } from '@agent-platform/database';
import { SentenceAligner, type SentenceAlignmentConfig } from './sentence-aligner.js';
import {
  SemanticSplitter,
  type SemanticSplitConfig,
  type ChunkWithEmbedding,
} from './semantic-splitter.js';
import {
  ConstrainedBalancer,
  type BalancerConfig,
  type LeafData,
  type TreeNode,
} from './constrained-balancer.js';

export interface TreeBuilderConfig {
  sentenceAlignment: SentenceAlignmentConfig;
  semanticSplit: SemanticSplitConfig;
  balancer: BalancerConfig;
  summaryModel: string;
  summaryMaxTokens: number;
  enableSemanticSplitting: boolean;
}

export interface TreeBuildResult {
  nodes: TreeNode[];
  leafCount: number;
  internalCount: number;
  rootId: string | null;
  maxDepth: number;
  totalTokens: number;
}

export class TreeBuilderService {
  private aligner: SentenceAligner;
  private splitter: SemanticSplitter;
  private balancer: ConstrainedBalancer;
  private llmClient: ChatLLMClient;
  private config: TreeBuilderConfig;

  constructor(llmClient: ChatLLMClient, config: Partial<TreeBuilderConfig> = {}) {
    this.config = {
      sentenceAlignment: config.sentenceAlignment ?? {
        targetChunkSize: 512,
        maxChunkSize: 1024,
        minChunkSize: 128,
      },
      semanticSplit: config.semanticSplit ?? {
        similarityThreshold: 0.7,
        embeddingDim: 1536,
      },
      balancer: config.balancer ?? {
        maxDepth: 4,
        maxChildrenPerNode: 10,
        minChildrenPerNode: 2,
      },
      summaryModel: config.summaryModel ?? 'gpt-4o-mini',
      summaryMaxTokens: config.summaryMaxTokens ?? 200,
      enableSemanticSplitting: config.enableSemanticSplitting ?? true,
    };

    this.aligner = new SentenceAligner(this.config.sentenceAlignment);
    this.splitter = new SemanticSplitter(this.config.semanticSplit);
    this.balancer = new ConstrainedBalancer(this.config.balancer);
    this.llmClient = llmClient;
  }

  /**
   * Build tree from document text
   */
  async buildTreeFromText(
    tenantId: string,
    indexId: string,
    documentId: string,
    text: string,
    embeddings?: number[][],
  ): Promise<TreeBuildResult> {
    // Step 1: Sentence-aligned chunking
    const sentences = this.aligner.splitIntoSentences(text);
    let chunks = this.aligner.alignIntoChunks(sentences);

    // Step 2: Semantic splitting (optional)
    if (this.config.enableSemanticSplitting && embeddings && embeddings.length === chunks.length) {
      const chunksWithEmbeddings: ChunkWithEmbedding[] = chunks.map((sentenceGroup, idx) => ({
        text: SentenceAligner.mergeSpans(sentenceGroup),
        embedding: embeddings[idx],
        tokenCount: SentenceAligner.getTotalTokenCount(sentenceGroup),
      }));

      const semanticGroups = this.splitter.splitIntoGroups(chunksWithEmbeddings);

      // Convert semantic groups back to sentence chunks
      chunks = semanticGroups.map((group) => {
        const allSentences = group.chunks.flatMap((chunk) => {
          // Re-split each chunk text into sentences
          const chunkSentences = this.aligner.splitIntoSentences(chunk.text);
          return chunkSentences;
        });
        return allSentences;
      });
    }

    // Step 3: Create leaf data from chunks
    const leaves: LeafData[] = chunks.map((sentenceGroup, idx) => ({
      chunkId: `chunk_${idx}`, // Placeholder - will be replaced with actual chunk IDs
      text: SentenceAligner.mergeSpans(sentenceGroup),
      tokenCount: SentenceAligner.getTotalTokenCount(sentenceGroup),
      similarityScore: undefined,
    }));

    // Step 4: Build constrained tree
    const nodes = this.balancer.buildTree(tenantId, indexId, documentId, leaves);

    // Step 5: Validate tree constraints
    const validation = this.balancer.validateTree(nodes);
    if (!validation.valid) {
      throw new Error(`Tree validation failed: ${validation.errors.join(', ')}`);
    }

    // Step 6: Generate summaries for internal/root nodes
    await this.generateSummaries(nodes, leaves);

    // Calculate stats
    const leafCount = nodes.filter((n) => n.nodeType === 'leaf').length;
    const internalCount = nodes.filter((n) => n.nodeType === 'internal').length;
    const root = nodes.find((n) => n.nodeType === 'root');
    const maxDepth = Math.max(...nodes.map((n) => n.depth));
    const totalTokens = nodes.reduce((sum, n) => sum + n.tokenCount, 0);

    return {
      nodes,
      leafCount,
      internalCount,
      rootId: root?.id ?? null,
      maxDepth,
      totalTokens,
    };
  }

  /**
   * Build tree from existing chunks
   */
  async buildTreeFromChunks(
    tenantId: string,
    indexId: string,
    documentId: string,
    chunks: ISearchChunk[],
  ): Promise<TreeBuildResult> {
    // Convert chunks to leaf data
    const leaves: LeafData[] = chunks.map((chunk) => ({
      chunkId: chunk._id,
      text: chunk.content,
      tokenCount: chunk.metadata?.tokenCount ?? this.estimateTokenCount(chunk.content),
      similarityScore: undefined,
    }));

    // Build tree
    const nodes = this.balancer.buildTree(tenantId, indexId, documentId, leaves);

    // Validate
    const validation = this.balancer.validateTree(nodes);
    if (!validation.valid) {
      throw new Error(`Tree validation failed: ${validation.errors.join(', ')}`);
    }

    // Generate summaries
    await this.generateSummaries(nodes, leaves);

    // Calculate stats
    const leafCount = nodes.filter((n) => n.nodeType === 'leaf').length;
    const internalCount = nodes.filter((n) => n.nodeType === 'internal').length;
    const root = nodes.find((n) => n.nodeType === 'root');
    const maxDepth = Math.max(...nodes.map((n) => n.depth));
    const totalTokens = nodes.reduce((sum, n) => sum + n.tokenCount, 0);

    return {
      nodes,
      leafCount,
      internalCount,
      rootId: root?.id ?? null,
      maxDepth,
      totalTokens,
    };
  }

  /**
   * Generate summaries for internal and root nodes using LLM
   */
  private async generateSummaries(nodes: TreeNode[], leaves: LeafData[]): Promise<void> {
    const nodesToSummarize = nodes.filter(
      (n) => n.nodeType === 'internal' || n.nodeType === 'root',
    );

    // Create lookup map for leaves
    const leafMap = new Map<string, LeafData>();
    nodes
      .filter((n) => n.nodeType === 'leaf')
      .forEach((leaf, idx) => {
        if (leaf.id && leaves[idx]) {
          leafMap.set(leaf.id, leaves[idx]);
        }
      });

    // Generate summaries in parallel (batch of 5 at a time to avoid rate limits)
    const batchSize = 5;
    for (let i = 0; i < nodesToSummarize.length; i += batchSize) {
      const batch = nodesToSummarize.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (node) => {
          const childTexts = this.getChildTexts(node, nodes, leafMap);
          if (childTexts.length === 0) return;

          const summary = await this.generateSummary(
            childTexts,
            node.nodeType as 'root' | 'internal',
          );
          node.summary = summary;
        }),
      );
    }
  }

  /**
   * Get text content of all children for a node
   */
  private getChildTexts(
    node: TreeNode,
    allNodes: TreeNode[],
    leafMap: Map<string, LeafData>,
  ): string[] {
    const texts: string[] = [];

    for (const childId of node.childIds) {
      const child = allNodes.find((n) => n.id === childId);
      if (!child) continue;

      if (child.nodeType === 'leaf') {
        const leaf = leafMap.get(child.id);
        if (leaf) texts.push(leaf.text);
      } else if (child.summary) {
        texts.push(child.summary);
      }
    }

    return texts;
  }

  /**
   * Generate summary for a node using LLM
   */
  private async generateSummary(
    childTexts: string[],
    nodeType: 'internal' | 'root',
  ): Promise<string> {
    const systemPrompt =
      nodeType === 'root'
        ? 'You are a document summarizer. Generate a concise summary of the entire document based on the section summaries provided.'
        : 'You are a section summarizer. Generate a concise summary of this section based on the chunk content provided.';

    const userPrompt = `Summarize the following ${nodeType === 'root' ? 'section summaries' : 'chunks'}:\n\n${childTexts.join('\n\n---\n\n')}`;

    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    try {
      const response = await this.llmClient.chat(systemPrompt, messages, {
        model: this.config.summaryModel,
        maxTokens: this.config.summaryMaxTokens,
      });

      return response;
    } catch (error) {
      console.error('Failed to generate summary:', error);
      // Fallback: use truncated concatenation
      return childTexts.join(' ').slice(0, 500) + '...';
    }
  }

  /**
   * Estimate token count (simple heuristic)
   */
  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// Re-export types and classes
export { SentenceAligner, SemanticSplitter, ConstrainedBalancer };
export type { SentenceAlignmentConfig, SemanticSplitConfig, BalancerConfig, TreeNode, LeafData };
