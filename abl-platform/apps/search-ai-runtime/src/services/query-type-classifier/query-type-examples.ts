/**
 * Query Type Classification Examples
 *
 * Configuration for few-shot learning in query type classification.
 * Examples are organized by connector type and query type.
 *
 * **Structure:**
 * - connector type (jira, salesforce, servicenow, generic)
 *   - query type (structured, semantic, hybrid, aggregation)
 *     - examples array
 */

export interface QueryExample {
  query: string;
  queryType?: string;
  reasoning: string;
  confidence: number;
}

export interface QueryTypeExampleSet {
  structured: {
    examples: QueryExample[];
  };
  semantic: {
    examples: QueryExample[];
  };
  hybrid: {
    examples: QueryExample[];
  };
  aggregation: {
    examples: QueryExample[];
  };
}

export const QUERY_TYPE_EXAMPLES: Record<string, QueryTypeExampleSet> = {
  /**
   * Jira-specific examples
   */
  jira: {
    structured: {
      examples: [
        {
          query: 'Show high priority bugs',
          reasoning: 'Jira-specific: priority and type are standard fields',
          confidence: 0.95,
        },
        {
          query: 'Find bugs in sprint 23',
          reasoning: 'Jira-specific: sprint is a standard field',
          confidence: 0.93,
        },
        {
          query: 'List open issues assigned to John',
          reasoning: 'Standard field-based query with assignee filter',
          confidence: 0.94,
        },
      ],
    },
    semantic: {
      examples: [
        {
          query: 'Find bugs about API rate limiting',
          reasoning: 'Semantic concept requires searching descriptions/comments',
          confidence: 0.9,
        },
        {
          query: 'Issues related to authentication problems',
          reasoning: 'Concept-based search, not field reference',
          confidence: 0.88,
        },
        {
          query: 'Show work regarding performance optimization',
          reasoning: 'Abstract concept search',
          confidence: 0.87,
        },
      ],
    },
    hybrid: {
      examples: [
        {
          query: 'Show high priority bugs about authentication',
          reasoning: 'Combines structured (priority) with semantic (authentication)',
          confidence: 0.93,
        },
        {
          query: 'Find open issues related to database performance',
          reasoning: 'Structured status filter + semantic concept',
          confidence: 0.91,
        },
        {
          query: 'List P0 bugs about login failures',
          reasoning: 'Priority filter + semantic concept search',
          confidence: 0.92,
        },
      ],
    },
    aggregation: {
      examples: [
        {
          query: 'Count bugs by assignee',
          reasoning: 'Aggregation function with grouping',
          confidence: 0.96,
        },
        {
          query: 'Total story points per sprint',
          reasoning: 'Sum aggregation with sprint grouping',
          confidence: 0.95,
        },
        {
          query: 'Average resolution time by priority',
          reasoning: 'Average metric grouped by priority',
          confidence: 0.94,
        },
      ],
    },
  },

  /**
   * Salesforce-specific examples
   */
  salesforce: {
    structured: {
      examples: [
        {
          query: 'Show high value opportunities',
          reasoning: 'Salesforce field: opportunity value',
          confidence: 0.94,
        },
        {
          query: 'Find accounts in California',
          reasoning: 'Geographic field filter',
          confidence: 0.93,
        },
        {
          query: 'List closed-won deals',
          reasoning: 'Standard Salesforce stage field',
          confidence: 0.95,
        },
      ],
    },
    semantic: {
      examples: [
        {
          query: 'Find opportunities about cloud migration',
          reasoning: 'Semantic search in opportunity descriptions',
          confidence: 0.89,
        },
        {
          query: 'Accounts related to enterprise software',
          reasoning: 'Concept-based account search',
          confidence: 0.87,
        },
      ],
    },
    hybrid: {
      examples: [
        {
          query: 'Show high-value opportunities about SaaS products',
          reasoning: 'Value filter + semantic product concept',
          confidence: 0.91,
        },
        {
          query: 'Find closed-won deals related to AI solutions',
          reasoning: 'Stage filter + semantic concept',
          confidence: 0.9,
        },
      ],
    },
    aggregation: {
      examples: [
        {
          query: 'Total revenue by region',
          reasoning: 'Sum aggregation grouped by region',
          confidence: 0.96,
        },
        {
          query: 'Count opportunities by stage',
          reasoning: 'Count aggregation with stage grouping',
          confidence: 0.95,
        },
        {
          query: 'Average deal size per account owner',
          reasoning: 'Average metric grouped by owner',
          confidence: 0.94,
        },
      ],
    },
  },

  /**
   * ServiceNow-specific examples
   */
  servicenow: {
    structured: {
      examples: [
        {
          query: 'Show critical incidents',
          reasoning: 'Priority/severity field filter',
          confidence: 0.95,
        },
        {
          query: 'Find open tickets assigned to IT team',
          reasoning: 'Status and assignment group filters',
          confidence: 0.93,
        },
      ],
    },
    semantic: {
      examples: [
        {
          query: 'Find incidents about network outages',
          reasoning: 'Semantic search in incident descriptions',
          confidence: 0.88,
        },
        {
          query: 'Tickets related to VPN connectivity',
          reasoning: 'Concept-based search',
          confidence: 0.87,
        },
      ],
    },
    hybrid: {
      examples: [
        {
          query: 'Show critical incidents about database performance',
          reasoning: 'Priority filter + semantic concept',
          confidence: 0.92,
        },
      ],
    },
    aggregation: {
      examples: [
        {
          query: 'Count incidents by category',
          reasoning: 'Count aggregation with category grouping',
          confidence: 0.96,
        },
        {
          query: 'Average resolution time per priority',
          reasoning: 'Average metric grouped by priority',
          confidence: 0.94,
        },
      ],
    },
  },

  /**
   * Generic examples for unknown connector types
   */
  generic: {
    structured: {
      examples: [
        {
          query: 'Show high priority items',
          reasoning: 'Clear field reference (priority)',
          confidence: 0.9,
        },
        {
          query: 'Find active records',
          reasoning: 'Status field filter',
          confidence: 0.89,
        },
        {
          query: 'List items created last week',
          reasoning: 'Temporal field filter',
          confidence: 0.88,
        },
      ],
    },
    semantic: {
      examples: [
        {
          query: 'Find documents about authentication',
          reasoning: 'Concept-based search',
          confidence: 0.88,
        },
        {
          query: 'Items related to security',
          reasoning: 'Semantic concept search',
          confidence: 0.86,
        },
        {
          query: 'Show content regarding user management',
          reasoning: 'Abstract concept search',
          confidence: 0.85,
        },
      ],
    },
    hybrid: {
      examples: [
        {
          query: 'Show high priority items about security',
          reasoning: 'Structured + semantic',
          confidence: 0.91,
        },
        {
          query: 'Find active records related to performance',
          reasoning: 'Status filter + semantic concept',
          confidence: 0.89,
        },
      ],
    },
    aggregation: {
      examples: [
        {
          query: 'Count items by category',
          reasoning: 'Aggregation with grouping',
          confidence: 0.94,
        },
        {
          query: 'Total amount per region',
          reasoning: 'Sum aggregation with region grouping',
          confidence: 0.93,
        },
        {
          query: 'Average score by type',
          reasoning: 'Average metric grouped by type',
          confidence: 0.92,
        },
      ],
    },
  },
};
