/**
 * Tree Construction Strategy Interface
 *
 * Provides abstraction for different tree construction algorithms.
 * Enables swapping between greedy, optimal, balanced approaches.
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Tree node
 */
export interface TreeNode {
  /** Unique node ID */
  id: string;
  /** Parent node ID (null for root) */
  parentId: string | null;
  /** Child node IDs */
  childIds: string[];
  /** Depth in tree (0 for root) */
  depth: number;
  /** Node type */
  nodeType: 'root' | 'internal' | 'leaf';
  /** Chunk ID (for leaf nodes) */
  chunkId: string | null;
  /** Summary text (for internal/root nodes) */
  summary: string | null;
  /** Token count */
  tokenCount: number;
  /** Position among siblings */
  positionInParent: number;
  /** Similarity score (optional, for semantic grouping) */
  similarityScore?: number;
}

/**
 * Leaf data for tree construction
 */
export interface LeafData {
  /** Chunk ID */
  chunkId: string;
  /** Chunk text */
  text: string;
  /** Token count */
  tokenCount: number;
  /** Similarity score (optional) */
  similarityScore?: number;
  /** Embedding vector (optional, for semantic grouping) */
  embedding?: number[];
}

/**
 * Tree construction constraints
 */
export interface TreeConstraints {
  /** Maximum tree depth */
  maxDepth: number;
  /** Maximum children per node */
  maxChildrenPerNode: number;
  /** Minimum children per node */
  minChildrenPerNode: number;
}

/**
 * Tree validation result
 */
export interface TreeValidationResult {
  /** Whether tree is valid */
  valid: boolean;
  /** Validation errors */
  errors: string[];
  /** Validation warnings */
  warnings?: string[];
}

// =============================================================================
// TREE CONSTRUCTION STRATEGY INTERFACE
// =============================================================================

/**
 * Strategy for constructing hierarchical trees from leaf nodes
 */
export interface TreeConstructionStrategy {
  /**
   * Build tree from leaf nodes
   * @param leaves - Leaf node data
   * @param constraints - Tree constraints
   * @returns Array of tree nodes (root, internal, leaf)
   */
  buildTree(leaves: LeafData[], constraints: TreeConstraints): TreeNode[];

  /**
   * Validate tree structure
   * @param nodes - Tree nodes to validate
   * @param constraints - Constraints to check against
   * @returns Validation result
   */
  validateTree(nodes: TreeNode[], constraints: TreeConstraints): TreeValidationResult;

  /**
   * Get strategy name
   */
  getName(): string;
}

// =============================================================================
// GREEDY BALANCING STRATEGY (Current Implementation)
// =============================================================================

/**
 * Greedy balancing strategy
 * Builds tree by greedily grouping nodes to satisfy constraints
 * Fast but may not produce optimal trees
 */
export class GreedyBalancingStrategy implements TreeConstructionStrategy {
  buildTree(leaves: LeafData[], constraints: TreeConstraints): TreeNode[] {
    if (leaves.length === 0) {
      return [];
    }

    const nodes: TreeNode[] = [];
    let nodeIdCounter = 0;

    // Create leaf nodes
    const leafNodes: TreeNode[] = leaves.map((leaf, index) => ({
      id: `node_${nodeIdCounter++}`,
      parentId: null, // Will be set later
      childIds: [],
      depth: 0, // Will be updated later
      nodeType: 'leaf' as const,
      chunkId: leaf.chunkId,
      summary: null,
      tokenCount: leaf.tokenCount,
      positionInParent: index,
      similarityScore: leaf.similarityScore,
    }));

    nodes.push(...leafNodes);

    // Build tree bottom-up
    let currentLevel = leafNodes;
    let currentDepth = 1;

    while (currentLevel.length > 1 && currentDepth <= constraints.maxDepth) {
      const nextLevel: TreeNode[] = [];
      const groupSize = Math.min(
        constraints.maxChildrenPerNode,
        Math.ceil(currentLevel.length / Math.max(2, constraints.minChildrenPerNode)),
      );

      // Group nodes
      for (let i = 0; i < currentLevel.length; i += groupSize) {
        const group = currentLevel.slice(i, i + groupSize);

        // Create parent node
        const parentNode: TreeNode = {
          id: `node_${nodeIdCounter++}`,
          parentId: null, // Will be set in next iteration
          childIds: group.map((n) => n.id),
          depth: currentDepth,
          nodeType: group.length === currentLevel.length ? 'root' : 'internal',
          chunkId: null,
          summary: null, // Summary will be generated later
          tokenCount: group.reduce((sum, n) => sum + n.tokenCount, 0),
          positionInParent: nextLevel.length,
        };

        // Update children's parent IDs and depths
        for (let j = 0; j < group.length; j++) {
          group[j].parentId = parentNode.id;
          group[j].depth = currentDepth - 1;
          group[j].positionInParent = j;
        }

        nodes.push(parentNode);
        nextLevel.push(parentNode);
      }

      currentLevel = nextLevel;
      currentDepth++;
    }

    // If we have multiple nodes at top level, create a root
    if (currentLevel.length > 1) {
      const rootNode: TreeNode = {
        id: `node_${nodeIdCounter++}`,
        parentId: null,
        childIds: currentLevel.map((n) => n.id),
        depth: currentDepth,
        nodeType: 'root',
        chunkId: null,
        summary: null,
        tokenCount: currentLevel.reduce((sum, n) => sum + n.tokenCount, 0),
        positionInParent: 0,
      };

      for (let i = 0; i < currentLevel.length; i++) {
        currentLevel[i].parentId = rootNode.id;
        currentLevel[i].depth = currentDepth - 1;
        currentLevel[i].positionInParent = i;
      }

      nodes.push(rootNode);
    } else if (currentLevel.length === 1) {
      // Single node at top becomes root
      currentLevel[0].nodeType = 'root';
    }

    return nodes;
  }

  validateTree(nodes: TreeNode[], constraints: TreeConstraints): TreeValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check max depth
    const maxDepth = Math.max(...nodes.map((n) => n.depth));
    if (maxDepth > constraints.maxDepth) {
      errors.push(`Max depth ${maxDepth} exceeds constraint ${constraints.maxDepth}`);
    }

    // Check max children
    for (const node of nodes) {
      if (node.childIds.length > constraints.maxChildrenPerNode) {
        errors.push(
          `Node ${node.id} has ${node.childIds.length} children, exceeds ${constraints.maxChildrenPerNode}`,
        );
      }

      // Warning for min children (except leaves and root)
      if (node.nodeType === 'internal' && node.childIds.length < constraints.minChildrenPerNode) {
        warnings.push(
          `Node ${node.id} has ${node.childIds.length} children, below minimum ${constraints.minChildrenPerNode}`,
        );
      }
    }

    // Check for single root
    const roots = nodes.filter((n) => n.nodeType === 'root');
    if (roots.length === 0) {
      errors.push('No root node found');
    } else if (roots.length > 1) {
      errors.push(`Multiple root nodes found: ${roots.length}`);
    }

    // Check parent-child consistency
    for (const node of nodes) {
      for (const childId of node.childIds) {
        const child = nodes.find((n) => n.id === childId);
        if (!child) {
          errors.push(`Child ${childId} of node ${node.id} not found`);
        } else if (child.parentId !== node.id) {
          errors.push(
            `Child ${childId} parent mismatch: expected ${node.id}, got ${child.parentId}`,
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  getName(): string {
    return 'greedy-balancing';
  }
}

// =============================================================================
// BREADTH-FIRST TREE CONSTRUCTION
// =============================================================================

/**
 * Breadth-first tree construction
 * Builds balanced tree level by level
 */
export class BreadthFirstTreeConstructionStrategy implements TreeConstructionStrategy {
  buildTree(leaves: LeafData[], constraints: TreeConstraints): TreeNode[] {
    if (leaves.length === 0) {
      return [];
    }

    const nodes: TreeNode[] = [];
    let nodeIdCounter = 0;

    // Create leaf nodes
    const leafNodes: TreeNode[] = leaves.map((leaf, index) => ({
      id: `node_${nodeIdCounter++}`,
      parentId: null,
      childIds: [],
      depth: 0,
      nodeType: 'leaf' as const,
      chunkId: leaf.chunkId,
      summary: null,
      tokenCount: leaf.tokenCount,
      positionInParent: index,
    }));

    nodes.push(...leafNodes);

    // Build tree level by level
    let currentLevel = leafNodes;
    let currentDepth = 1;

    while (currentLevel.length > 1 && currentDepth <= constraints.maxDepth) {
      const nextLevel: TreeNode[] = [];
      const nodesPerGroup = constraints.maxChildrenPerNode;

      for (let i = 0; i < currentLevel.length; i += nodesPerGroup) {
        const group = currentLevel.slice(i, i + nodesPerGroup);

        const parentNode: TreeNode = {
          id: `node_${nodeIdCounter++}`,
          parentId: null,
          childIds: group.map((n) => n.id),
          depth: currentDepth,
          nodeType: 'internal',
          chunkId: null,
          summary: null,
          tokenCount: group.reduce((sum, n) => sum + n.tokenCount, 0),
          positionInParent: nextLevel.length,
        };

        for (let j = 0; j < group.length; j++) {
          group[j].parentId = parentNode.id;
          group[j].depth = currentDepth - 1;
          group[j].positionInParent = j;
        }

        nodes.push(parentNode);
        nextLevel.push(parentNode);
      }

      currentLevel = nextLevel;
      currentDepth++;
    }

    // Create root
    if (currentLevel.length === 1) {
      currentLevel[0].nodeType = 'root';
    } else {
      const rootNode: TreeNode = {
        id: `node_${nodeIdCounter++}`,
        parentId: null,
        childIds: currentLevel.map((n) => n.id),
        depth: currentDepth,
        nodeType: 'root',
        chunkId: null,
        summary: null,
        tokenCount: currentLevel.reduce((sum, n) => sum + n.tokenCount, 0),
        positionInParent: 0,
      };

      for (let i = 0; i < currentLevel.length; i++) {
        currentLevel[i].parentId = rootNode.id;
        currentLevel[i].depth = currentDepth - 1;
        currentLevel[i].positionInParent = i;
        currentLevel[i].nodeType = 'internal';
      }

      nodes.push(rootNode);
    }

    return nodes;
  }

  validateTree(nodes: TreeNode[], constraints: TreeConstraints): TreeValidationResult {
    // Reuse validation from GreedyBalancingStrategy
    return new GreedyBalancingStrategy().validateTree(nodes, constraints);
  }

  getName(): string {
    return 'breadth-first';
  }
}

// =============================================================================
// SEMANTIC GROUPING TREE CONSTRUCTION
// =============================================================================

/**
 * Semantic grouping tree construction
 * Groups similar chunks together using embeddings
 * Requires embeddings to be provided
 */
export class SemanticGroupingTreeConstructionStrategy implements TreeConstructionStrategy {
  constructor(private similarityThreshold: number = 0.7) {}

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  buildTree(leaves: LeafData[], constraints: TreeConstraints): TreeNode[] {
    if (leaves.length === 0) {
      return [];
    }

    // Check if embeddings are provided
    const hasEmbeddings = leaves.every((leaf) => leaf.embedding !== undefined);

    if (!hasEmbeddings) {
      // Fall back to greedy balancing if no embeddings
      return new GreedyBalancingStrategy().buildTree(leaves, constraints);
    }

    const nodes: TreeNode[] = [];
    let nodeIdCounter = 0;

    // Create leaf nodes
    const leafNodes: TreeNode[] = leaves.map(
      (leaf, index) =>
        ({
          id: `node_${nodeIdCounter++}`,
          parentId: null,
          childIds: [],
          depth: 0,
          nodeType: 'leaf' as const,
          chunkId: leaf.chunkId,
          summary: null,
          tokenCount: leaf.tokenCount,
          positionInParent: index,
          embedding: leaf.embedding,
        }) as TreeNode & { embedding?: number[] },
    );

    nodes.push(...leafNodes);

    // Build tree by semantic similarity
    let currentLevel = leafNodes as (TreeNode & { embedding?: number[] })[];
    let currentDepth = 1;

    while (currentLevel.length > 1 && currentDepth <= constraints.maxDepth) {
      const nextLevel: (TreeNode & { embedding?: number[] })[] = [];
      const grouped = new Set<string>();

      for (const node of currentLevel) {
        if (grouped.has(node.id)) continue;

        const group: (TreeNode & { embedding?: number[] })[] = [node];
        grouped.add(node.id);

        // Find similar nodes
        for (const other of currentLevel) {
          if (grouped.has(other.id)) continue;
          if (group.length >= constraints.maxChildrenPerNode) break;

          if (node.embedding && other.embedding) {
            const similarity = this.cosineSimilarity(node.embedding, other.embedding);
            if (similarity >= this.similarityThreshold) {
              group.push(other);
              grouped.add(other.id);
            }
          }
        }

        // Create parent node
        const avgEmbedding = group[0].embedding
          ? group.reduce(
              (acc, n) => acc.map((v, i) => v + (n.embedding![i] || 0) / group.length),
              new Array(group[0].embedding.length).fill(0),
            )
          : undefined;

        const parentNode: TreeNode & { embedding?: number[] } = {
          id: `node_${nodeIdCounter++}`,
          parentId: null,
          childIds: group.map((n) => n.id),
          depth: currentDepth,
          nodeType: 'internal',
          chunkId: null,
          summary: null,
          tokenCount: group.reduce((sum, n) => sum + n.tokenCount, 0),
          positionInParent: nextLevel.length,
          embedding: avgEmbedding,
        };

        for (let j = 0; j < group.length; j++) {
          group[j].parentId = parentNode.id;
          group[j].depth = currentDepth - 1;
          group[j].positionInParent = j;
        }

        nodes.push(parentNode);
        nextLevel.push(parentNode);
      }

      currentLevel = nextLevel;
      currentDepth++;
    }

    // Create root
    if (currentLevel.length === 1) {
      currentLevel[0].nodeType = 'root';
    } else if (currentLevel.length > 1) {
      const rootNode: TreeNode = {
        id: `node_${nodeIdCounter++}`,
        parentId: null,
        childIds: currentLevel.map((n) => n.id),
        depth: currentDepth,
        nodeType: 'root',
        chunkId: null,
        summary: null,
        tokenCount: currentLevel.reduce((sum, n) => sum + n.tokenCount, 0),
        positionInParent: 0,
      };

      for (let i = 0; i < currentLevel.length; i++) {
        currentLevel[i].parentId = rootNode.id;
        currentLevel[i].depth = currentDepth - 1;
        currentLevel[i].positionInParent = i;
        currentLevel[i].nodeType = 'internal';
      }

      nodes.push(rootNode);
    }

    // Remove embedding field from nodes before returning (type cast to remove extra property)
    return nodes.map((node) => {
      const { embedding, ...cleanNode } = node as any;
      return cleanNode as TreeNode;
    });
  }

  validateTree(nodes: TreeNode[], constraints: TreeConstraints): TreeValidationResult {
    return new GreedyBalancingStrategy().validateTree(nodes, constraints);
  }

  getName(): string {
    return 'semantic-grouping';
  }
}
