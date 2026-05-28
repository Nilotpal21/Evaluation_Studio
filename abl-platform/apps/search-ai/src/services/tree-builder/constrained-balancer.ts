/**
 * Constrained Balancer
 *
 * Builds balanced trees with constraints:
 * - Max depth: 4 levels
 * - Max children per node: 10
 *
 * Uses recursive grouping to ensure balanced hierarchy.
 */

import type { IChunkHierarchy } from '@agent-platform/database';

export interface TreeNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
  nodeType: 'root' | 'internal' | 'leaf';
  chunkId: string | null;
  summary: string | null;
  similarityScore: number | null;
  tokenCount: number;
  positionInParent: number;
}

export interface BalancerConfig {
  maxDepth: number;
  maxChildrenPerNode: number;
  minChildrenPerNode: number;
}

export interface LeafData {
  chunkId: string;
  text: string;
  tokenCount: number;
  similarityScore?: number;
}

export class ConstrainedBalancer {
  private config: BalancerConfig;
  private nodeIdCounter = 0;

  constructor(config: Partial<BalancerConfig> = {}) {
    this.config = {
      maxDepth: config.maxDepth ?? 4,
      maxChildrenPerNode: config.maxChildrenPerNode ?? 10,
      minChildrenPerNode: config.minChildrenPerNode ?? 2,
    };
  }

  /**
   * Build balanced tree from leaf chunks
   */
  buildTree(tenantId: string, indexId: string, documentId: string, leaves: LeafData[]): TreeNode[] {
    if (leaves.length === 0) return [];

    // Reset counter for each tree
    this.nodeIdCounter = 0;

    // Create leaf nodes
    const leafNodes: TreeNode[] = leaves.map((leaf, idx) => this.createLeafNode(leaf, idx));

    // Build tree recursively from bottom up
    const allNodes: TreeNode[] = [...leafNodes];
    let currentLevel = leafNodes;
    let currentDepth = 0;

    while (currentLevel.length > 1 && currentDepth < this.config.maxDepth - 1) {
      const parentLevel = this.groupIntoParents(currentLevel, currentDepth + 1);
      allNodes.push(...parentLevel);
      currentLevel = parentLevel;
      currentDepth++;
    }

    // Create root if needed
    if (currentLevel.length > 1) {
      const root = this.createRootNode(currentLevel);
      allNodes.push(root);
    } else if (currentLevel.length === 1 && currentLevel[0].depth > 0) {
      // Single node at top level becomes root
      currentLevel[0].nodeType = 'root';
    }

    return allNodes;
  }

  /**
   * Group nodes into parent level
   */
  private groupIntoParents(children: TreeNode[], depth: number): TreeNode[] {
    const parents: TreeNode[] = [];
    const maxChildren = this.config.maxChildrenPerNode;

    for (let i = 0; i < children.length; i += maxChildren) {
      const childGroup = children.slice(i, i + maxChildren);
      const parent = this.createInternalNode(childGroup, depth);
      parents.push(parent);

      // Update children with parent ID
      childGroup.forEach((child, idx) => {
        child.parentId = parent.id;
        child.positionInParent = idx;
      });
    }

    return parents;
  }

  /**
   * Create leaf node
   */
  private createLeafNode(leaf: LeafData, position: number): TreeNode {
    return {
      id: this.generateNodeId(),
      parentId: null,
      childIds: [],
      depth: 0,
      nodeType: 'leaf',
      chunkId: leaf.chunkId,
      summary: null,
      similarityScore: leaf.similarityScore ?? null,
      tokenCount: leaf.tokenCount,
      positionInParent: position,
    };
  }

  /**
   * Create internal node
   */
  private createInternalNode(children: TreeNode[], depth: number): TreeNode {
    const childIds = children.map((c) => c.id);
    const totalTokens = children.reduce((sum, c) => sum + c.tokenCount, 0);
    const avgSimilarity =
      children
        .map((c) => c.similarityScore)
        .filter((s): s is number => s !== null)
        .reduce((sum, s) => sum + s, 0) / children.length || null;

    return {
      id: this.generateNodeId(),
      parentId: null, // Will be set by parent level
      childIds,
      depth,
      nodeType: 'internal',
      chunkId: null,
      summary: null, // Will be filled by LLM later
      similarityScore: avgSimilarity,
      tokenCount: totalTokens,
      positionInParent: 0, // Will be set by parent level
    };
  }

  /**
   * Create root node
   */
  private createRootNode(children: TreeNode[]): TreeNode {
    const childIds = children.map((c) => c.id);
    const totalTokens = children.reduce((sum, c) => sum + c.tokenCount, 0);
    const maxDepth = Math.max(...children.map((c) => c.depth));

    const root: TreeNode = {
      id: this.generateNodeId(),
      parentId: null,
      childIds,
      depth: maxDepth + 1,
      nodeType: 'root',
      chunkId: null,
      summary: null, // Will be filled by LLM later
      similarityScore: null,
      tokenCount: totalTokens,
      positionInParent: 0,
    };

    // Update children with root as parent
    children.forEach((child, idx) => {
      child.parentId = root.id;
      child.positionInParent = idx;
    });

    return root;
  }

  /**
   * Generate unique node ID
   */
  private generateNodeId(): string {
    return `node_${this.nodeIdCounter++}`;
  }

  /**
   * Validate tree constraints
   */
  validateTree(nodes: TreeNode[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check max depth
    const maxDepth = Math.max(...nodes.map((n) => n.depth));
    if (maxDepth > this.config.maxDepth) {
      errors.push(`Max depth exceeded: ${maxDepth} > ${this.config.maxDepth}`);
    }

    // Check max children
    for (const node of nodes) {
      if (node.childIds.length > this.config.maxChildrenPerNode) {
        errors.push(
          `Node ${node.id} has ${node.childIds.length} children > ${this.config.maxChildrenPerNode}`,
        );
      }
    }

    // Check root count
    const roots = nodes.filter((n) => n.nodeType === 'root');
    if (roots.length > 1) {
      errors.push(`Multiple roots found: ${roots.length}`);
    }

    // Check orphans
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const node of nodes) {
      if (node.parentId && !nodeIds.has(node.parentId)) {
        errors.push(`Node ${node.id} has missing parent ${node.parentId}`);
      }
      for (const childId of node.childIds) {
        if (!nodeIds.has(childId)) {
          errors.push(`Node ${node.id} has missing child ${childId}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Convert TreeNode to IChunkHierarchy
   */
  static toChunkHierarchy(
    node: TreeNode,
    tenantId: string,
    indexId: string,
    documentId: string,
    metadata?: Record<string, unknown>,
  ): Omit<IChunkHierarchy, '_id' | 'createdAt' | 'updatedAt' | '_v'> {
    return {
      tenantId,
      indexId,
      documentId,
      parentId: node.parentId,
      childIds: node.childIds,
      depth: node.depth,
      nodeType: node.nodeType,
      chunkId: node.chunkId,
      summary: node.summary,
      similarityScore: node.similarityScore,
      tokenCount: node.tokenCount,
      positionInParent: node.positionInParent,
      metadata: metadata ?? null,
    };
  }
}
