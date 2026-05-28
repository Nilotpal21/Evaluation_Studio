export interface SeedExampleProject {
  dir: string;
  name: string;
  description: string;
}

/**
 * Curated dev-only examples.
 *
 * This is intentionally smaller than the full `examples/` directory. The goal
 * is to keep the default dev workspace useful without automatically seeding
 * every maintained demo into tenant bootstrap flows.
 */
export const CURATED_EXAMPLE_PROJECTS: SeedExampleProject[] = [
  {
    dir: 'travel',
    name: 'Travel Assistant',
    description: 'Multi-agent travel booking with voice and SDK optimization',
  },
  {
    dir: 'guardrails',
    name: 'Guardrails Demo',
    description: 'Agent with constraint guardrails',
  },
  {
    dir: 'saludsa',
    name: 'Saludsa Healthcare',
    description: 'Health insurance multi-agent supervisor with identity verification',
  },
  {
    dir: 'saludsa-production',
    name: 'Saludsa Production',
    description:
      'Production-grade 1:1 port of Saludsa Samy from Kore.ai - 16 specialist agents with real MCP tools',
  },
  {
    dir: 'DisputeTransaction',
    name: 'Dispute Transaction',
    description:
      'Multi-agent system for handling credit/debit card transaction disputes in financial services',
  },
  {
    dir: 'tool-bindings',
    name: 'Tool Bindings Demo',
    description: 'Demo of HTTP, sandbox, MCP, and lambda tool types',
  },
  {
    dir: 'airlines',
    name: 'Airlines Search',
    description: 'Airline search with analytics and policy advisor agents',
  },
  {
    dir: 'env-demo',
    name: 'Environment Demo',
    description: 'Demo of environment variable substitution in tool configs',
  },
  {
    dir: 'search-ai-strategies',
    name: 'Search AI Strategies',
    description: 'Knowledge retrieval, list queries, and aggregation patterns',
  },
  {
    dir: 'retail',
    name: 'Retail Commerce',
    description: 'Product advisory, sales, order tracking, and returns with rich SDK templates',
  },
  {
    dir: 'apple-care',
    name: 'Apple Customer Care',
    description: 'Device support, account help, repairs, and subscriptions for Apple products',
  },
];
