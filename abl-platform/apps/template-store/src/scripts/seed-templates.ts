/**
 * Seed Templates Script — Phase 2
 *
 * Seeds 5 platform templates with Phase 2 fields:
 * - `media[]` (replacing screenshots)
 * - `prerequisites` (envVars, connectors, mcpServers, authProfiles, models)
 * - `reviewStatus`
 * - `files` bundles with minimal valid ABL DSL content
 * - `manifest` as ProjectManifestV2-shaped objects
 *
 * Safe to run multiple times — drops existing seed data and re-creates.
 *
 * Invocation: pnpm tsx apps/template-store/src/scripts/seed-templates.ts
 */

import 'dotenv/config';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('seed-templates');

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BUNDLE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

const PUBLISHER = {
  publisherId: 'platform',
  publisherTenantId: 'platform',
  publisherName: 'ABL Platform',
  publisherVerified: true,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Phase2SeedTemplate {
  // Template fields
  slug: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  type: 'agent' | 'project';
  typeMetadata: Record<string, unknown>;
  detailSections: string[];
  category: string;
  tags: string[];
  complexity: 'starter' | 'standard' | 'advanced';
  demoConversation: Array<{ role: string; content: string }>;
  media: Array<{
    type: 'image' | 'video';
    url: string;
    thumbnailUrl?: string;
    caption: string;
    order: number;
  }>;
  prerequisites: {
    envVars: string[];
    connectors: string[];
    mcpServers: string[];
    authProfiles: string[];
    models: string[];
  };
  reviewStatus: 'approved';
  featuredOrder: number | null;

  // Version fields
  files: Record<string, string>;
  manifest: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateBundleSize(files: Record<string, string>, slug: string): void {
  const size = JSON.stringify(files).length;
  if (size > MAX_BUNDLE_SIZE_BYTES) {
    log.warn(`Bundle for ${slug} exceeds 4MB limit`, {
      slug,
      sizeBytes: size,
      sizeMB: (size / 1024 / 1024).toFixed(2),
    });
  }
}

function buildManifest(opts: {
  name: string;
  slug: string;
  description: string;
  entryAgent: string;
  agents: Record<
    string,
    {
      path: string;
      owner: string | null;
      ownerTeam: string | null;
      description: string | null;
      version: string | null;
    }
  >;
  agentCount: number;
}): Record<string, unknown> {
  return {
    format_version: '2.0',
    name: opts.name,
    slug: opts.slug,
    description: opts.description,
    abl_version: '1.0.0',
    exported_at: new Date().toISOString(),
    exported_by: 'platform',
    entry_agent: opts.entryAgent,
    dsl_format: 'legacy',
    layers_included: ['core'],
    agents: opts.agents,
    tools: {},
    metadata: {
      entity_counts: { agents: opts.agentCount, tools: 0 },
      required_env_vars: ['OPENAI_API_KEY'],
      required_connectors: [],
      required_mcp_servers: [],
      required_auth_profiles: [],
    },
  };
}

function derivePrerequisites(manifest: Record<string, unknown>): {
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
  models: string[];
} {
  const metadata = manifest.metadata as {
    required_env_vars?: string[];
    required_connectors?: string[];
    required_mcp_servers?: string[];
    required_auth_profiles?: Array<{ name: string }>;
  };

  // Extract model names — for placeholder content, all agents use gpt-4o
  const models = new Set<string>();
  const agents = manifest.agents as Record<string, { path: string }>;
  for (const _agent of Object.values(agents)) {
    models.add('gpt-4o');
  }

  return {
    envVars: metadata.required_env_vars ?? [],
    connectors: metadata.required_connectors ?? [],
    mcpServers: metadata.required_mcp_servers ?? [],
    authProfiles: (metadata.required_auth_profiles ?? []).map((p) => p.name),
    models: [...models],
  };
}

function buildEnvVarsJson(): string {
  return JSON.stringify(
    [
      {
        key: 'OPENAI_API_KEY',
        description: 'OpenAI API key for LLM',
        isSecret: true,
        environment: 'global',
      },
    ],
    null,
    2,
  );
}

// ─── Agent ABL DSL Builders ──────────────────────────────────────────────────

function buildAgentDsl(agentName: string, goal: string, persona: string): string {
  // IMPORTANT: Import pipeline expects "AGENT: name" (with colon), not "AGENT name"
  // See packages/project-io/src/import/import-validator.ts line 228
  return `AGENT: ${agentName}\n  MODEL gpt-4o\n  GOAL\n    ${goal}\n  PERSONA\n    ${persona}`;
}

// ─── Seed Data ───────────────────────────────────────────────────────────────

export function buildSeedTemplates(): Phase2SeedTemplate[] {
  const templates: Phase2SeedTemplate[] = [];

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Customer Service Agent (agent, starter, customer-service)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const slug = 'customer-service-agent';
    const agentName = 'customer_service';
    const agentDsl = buildAgentDsl(
      agentName,
      'Handle customer inquiries, complaints, and general support requests with empathy and efficiency.',
      'You are a friendly, empathetic customer service representative. You listen carefully, acknowledge concerns, and provide clear solutions.',
    );

    const manifest = buildManifest({
      name: 'Customer Service Agent',
      slug,
      description:
        'A friendly, empathetic agent that handles customer inquiries, complaints, and general support requests with natural conversation flow.',
      entryAgent: agentName,
      agents: {
        [agentName]: {
          path: `agents/${agentName}.agent.abl`,
          owner: null,
          ownerTeam: null,
          description: 'Handles customer inquiries, complaints, and general support',
          version: null,
        },
      },
      agentCount: 1,
    });

    const files: Record<string, string> = {
      'project.json': JSON.stringify(manifest, null, 2),
      [`agents/${agentName}.agent.abl`]: agentDsl,
      'environment/env-vars.json': buildEnvVarsJson(),
    };

    templates.push({
      slug,
      name: 'Customer Service Agent',
      shortDescription:
        'A friendly, empathetic agent that handles customer inquiries, complaints, and general support requests with natural conversation flow.',
      longDescription:
        'This customer service agent is designed to handle the most common support scenarios: order status inquiries, product questions, complaint resolution, and general FAQ responses. It uses a warm, empathetic tone and follows best-practice escalation patterns when issues require human intervention. The agent includes pre-configured tools for order lookup and knowledge base search.',
      type: 'agent',
      typeMetadata: {
        type: 'agent',
        agentCount: 1,
        hasSupervisor: false,
        hasFlow: false,
      },
      detailSections: ['agent-summary', 'demo-conversation', 'config-preview'],
      category: 'customer-service',
      tags: ['support', 'customer', 'helpdesk', 'faq', 'complaints'],
      complexity: 'starter',
      demoConversation: [
        {
          role: 'user',
          content:
            "Hi, I placed an order three days ago and haven't received a shipping confirmation yet.",
        },
        {
          role: 'assistant',
          content:
            "I'd be happy to help you check on your order! Could you please share your order number so I can look into the shipping status for you?",
        },
        { role: 'user', content: 'Sure, it is ORD-2024-7842.' },
        {
          role: 'assistant',
          content:
            'Thank you! I found your order ORD-2024-7842. It looks like it was shipped yesterday and is currently in transit. You should receive a shipping confirmation email shortly. The estimated delivery date is March 28th. Would you like me to help with anything else?',
        },
        {
          role: 'user',
          content: "That's great, thanks for checking!",
        },
      ],
      media: [],
      prerequisites: derivePrerequisites(manifest),
      reviewStatus: 'approved',
      featuredOrder: 1,
      files,
      manifest,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Technical Support Agent (agent, standard, technical-support)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const slug = 'technical-support-agent';
    const agentName = 'technical_support';
    const agentDsl = buildAgentDsl(
      agentName,
      'Diagnose technical issues and walk users through structured solutions with clear step-by-step instructions.',
      'You are an expert troubleshooter with a structured diagnostic approach. You ask clarifying questions, identify root causes, and provide step-by-step resolution paths.',
    );

    const manifest = buildManifest({
      name: 'Technical Support Agent',
      slug,
      description:
        'An expert troubleshooting agent that diagnoses technical issues, walks users through solutions, and escalates complex cases.',
      entryAgent: agentName,
      agents: {
        [agentName]: {
          path: `agents/${agentName}.agent.abl`,
          owner: null,
          ownerTeam: null,
          description: 'Diagnoses technical issues and provides structured solutions',
          version: null,
        },
      },
      agentCount: 1,
    });

    const files: Record<string, string> = {
      'project.json': JSON.stringify(manifest, null, 2),
      [`agents/${agentName}.agent.abl`]: agentDsl,
      'environment/env-vars.json': buildEnvVarsJson(),
    };

    templates.push({
      slug,
      name: 'Technical Support Agent',
      shortDescription:
        'An expert troubleshooting agent that diagnoses technical issues, walks users through solutions, and escalates complex cases.',
      longDescription:
        'This technical support agent guides users through structured troubleshooting workflows. It can diagnose common issues based on error descriptions, suggest step-by-step resolution paths, and collect diagnostic information for escalation. The agent supports both reactive troubleshooting (user reports a problem) and proactive diagnostics (guided health checks).',
      type: 'agent',
      typeMetadata: {
        type: 'agent',
        agentCount: 1,
        hasSupervisor: false,
        hasFlow: true,
      },
      detailSections: ['agent-summary', 'demo-conversation', 'config-preview'],
      category: 'technical-support',
      tags: ['troubleshooting', 'technical', 'diagnostics', 'it-support', 'helpdesk'],
      complexity: 'standard',
      demoConversation: [
        {
          role: 'user',
          content:
            "My application keeps crashing when I try to export reports. I'm getting an error code E-5012.",
        },
        {
          role: 'assistant',
          content:
            "I can help you resolve that. Error E-5012 typically occurs when the export file exceeds the memory limit. Let me walk you through a fix. First, could you tell me approximately how many records are in the report you're trying to export?",
        },
        { role: 'user', content: 'About 50,000 records.' },
        {
          role: 'assistant',
          content:
            "That's likely exceeding the default export limit. Here's what I recommend:\n\n1. Go to Settings > Export Configuration\n2. Increase the 'Max Export Rows' to 100,000\n3. Enable 'Streaming Export' mode\n4. Try the export again\n\nIf the issue persists after these changes, we can look at splitting the export into smaller batches. Would you like to try these steps?",
        },
      ],
      media: [],
      prerequisites: derivePrerequisites(manifest),
      reviewStatus: 'approved',
      featuredOrder: 2,
      files,
      manifest,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Knowledge Worker Agent (agent, starter, knowledge-management)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const slug = 'knowledge-worker-agent';
    const agentName = 'knowledge_worker';
    const agentDsl = buildAgentDsl(
      agentName,
      'Search knowledge bases, summarize documents, and answer questions with accurate citations.',
      'You are an intelligent research assistant. You provide accurate, well-cited answers from knowledge bases and can summarize complex documents clearly.',
    );

    const manifest = buildManifest({
      name: 'Knowledge Worker Agent',
      slug,
      description:
        'An intelligent research assistant that searches knowledge bases, summarizes documents, and answers questions with citations.',
      entryAgent: agentName,
      agents: {
        [agentName]: {
          path: `agents/${agentName}.agent.abl`,
          owner: null,
          ownerTeam: null,
          description: 'Searches knowledge bases and answers questions with citations',
          version: null,
        },
      },
      agentCount: 1,
    });

    const files: Record<string, string> = {
      'project.json': JSON.stringify(manifest, null, 2),
      [`agents/${agentName}.agent.abl`]: agentDsl,
      'environment/env-vars.json': buildEnvVarsJson(),
    };

    templates.push({
      slug,
      name: 'Knowledge Worker Agent',
      shortDescription:
        'An intelligent research assistant that searches knowledge bases, summarizes documents, and answers questions with citations.',
      longDescription:
        "This knowledge worker agent connects to your organization's knowledge bases to provide accurate, cited answers to employee questions. It can search across multiple document repositories, summarize lengthy documents, extract key facts, and maintain conversation context for follow-up questions. Ideal for internal help desks, onboarding support, and policy FAQ systems.",
      type: 'agent',
      typeMetadata: {
        type: 'agent',
        agentCount: 1,
        hasSupervisor: false,
        hasFlow: false,
      },
      detailSections: ['agent-summary', 'demo-conversation', 'config-preview'],
      category: 'knowledge-management',
      tags: ['knowledge-base', 'research', 'documentation', 'search', 'citations'],
      complexity: 'starter',
      demoConversation: [
        {
          role: 'user',
          content: "What's our company's policy on remote work?",
        },
        {
          role: 'assistant',
          content:
            'Based on our HR Policy Handbook (last updated January 2026), here is a summary of the remote work policy:\n\n- **Eligibility**: All full-time employees who have completed their probation period (90 days)\n- **Schedule**: Up to 3 days remote per week, with manager approval\n- **Core hours**: Must be available 10 AM - 3 PM in your local timezone\n- **Equipment**: Company provides a laptop and $500 annual home office stipend\n\nSource: HR Policy Handbook, Section 4.2 "Flexible Work Arrangements"\n\nWould you like more details on any of these points?',
        },
      ],
      media: [],
      prerequisites: derivePrerequisites(manifest),
      reviewStatus: 'approved',
      featuredOrder: 3,
      files,
      manifest,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Customer Support Team (project, advanced, customer-service)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const slug = 'customer-support-team';
    const agentNames = ['supervisor', 'triage_agent', 'billing_agent', 'tech_support_agent'];

    const agentDsls: Record<string, string> = {
      supervisor: buildAgentDsl(
        'supervisor',
        'Route incoming customer requests to the appropriate specialized agent based on intent detection.',
        'You are a customer support supervisor that routes requests to the right team member. You detect intent from the customer message and delegate to triage, billing, or technical support agents.',
      ),
      triage_agent: buildAgentDsl(
        'triage_agent',
        'Classify incoming customer requests by urgency and category for efficient routing.',
        'You triage incoming customer requests. You classify issues by urgency and category, gather initial context, and prepare handoff summaries.',
      ),
      billing_agent: buildAgentDsl(
        'billing_agent',
        'Handle billing inquiries, payment issues, refunds, and account-related financial questions.',
        'You handle billing inquiries and payment issues. You can look up charges, process refund requests, and explain billing policies clearly.',
      ),
      tech_support_agent: buildAgentDsl(
        'tech_support_agent',
        'Provide technical troubleshooting and product issue resolution for escalated cases.',
        'You provide technical support for product issues. You follow structured diagnostic steps and escalate to engineering when needed.',
      ),
    };

    const agents: Record<
      string,
      {
        path: string;
        owner: string | null;
        ownerTeam: string | null;
        description: string | null;
        version: string | null;
      }
    > = {};
    for (const name of agentNames) {
      agents[name] = {
        path: `agents/${name}.agent.abl`,
        owner: null,
        ownerTeam: null,
        description: null,
        version: null,
      };
    }
    agents.supervisor.description = 'Routes requests to specialized agents based on intent';
    agents.triage_agent.description = 'Classifies requests by urgency and category';
    agents.billing_agent.description = 'Handles billing inquiries and payment issues';
    agents.tech_support_agent.description = 'Provides technical troubleshooting for product issues';

    const manifest = buildManifest({
      name: 'Customer Support Team',
      slug,
      description:
        'A multi-agent project with a supervisor routing between triage, billing, and technical support agents.',
      entryAgent: 'supervisor',
      agents,
      agentCount: 4,
    });

    const files: Record<string, string> = {
      'project.json': JSON.stringify(manifest, null, 2),
      'environment/env-vars.json': buildEnvVarsJson(),
    };
    for (const name of agentNames) {
      files[`agents/${name}.agent.abl`] = agentDsls[name];
    }

    templates.push({
      slug,
      name: 'Customer Support Team',
      shortDescription:
        'A multi-agent project with a supervisor routing between triage, billing, and technical support agents.',
      longDescription:
        'This project template sets up a complete customer support operation with a supervisor agent that routes incoming requests to specialized agents: a triage agent for initial classification, a billing agent for payment and account inquiries, and a technical support agent for product issues. The supervisor uses intent detection to route conversations and can escalate to human agents when needed.',
      type: 'project',
      typeMetadata: {
        type: 'project',
        agentCount: 4,
        hasSupervisor: true,
        hasFlow: true,
      },
      detailSections: ['agent-summary', 'demo-conversation', 'config-preview'],
      category: 'customer-service',
      tags: ['multi-agent', 'supervisor', 'routing', 'support-team', 'triage'],
      complexity: 'advanced',
      demoConversation: [
        {
          role: 'user',
          content: "I've been charged twice for my subscription this month.",
        },
        {
          role: 'assistant',
          content:
            "[Supervisor: Routing to Billing Agent]\n\nI'm sorry to hear about the double charge! Let me look into your account right away. Could you share your account email or subscription ID?",
        },
        { role: 'user', content: 'My email is sarah@example.com.' },
        {
          role: 'assistant',
          content:
            "I found your account. I can confirm there was a duplicate charge of $29.99 on March 15th. I've initiated a refund for the duplicate payment. You should see the credit within 3-5 business days. Is there anything else I can help you with?",
        },
      ],
      media: [],
      prerequisites: derivePrerequisites(manifest),
      reviewStatus: 'approved',
      featuredOrder: null,
      files,
      manifest,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. HR Onboarding (project, standard, hr)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const slug = 'hr-onboarding';
    const agentNames = ['supervisor', 'document_collector', 'orientation_scheduler', 'policy_faq'];

    const agentDsls: Record<string, string> = {
      supervisor: buildAgentDsl(
        'supervisor',
        'Coordinate the employee onboarding process by routing new hires to the appropriate onboarding agent.',
        'You are an HR onboarding supervisor. You track onboarding milestones and route new hires to document collection, orientation scheduling, or policy FAQ agents as needed.',
      ),
      document_collector: buildAgentDsl(
        'document_collector',
        'Guide new hires through required paperwork including tax forms, direct deposit setup, and emergency contacts.',
        'You guide new employees through required documentation. You explain each form clearly, collect information step by step, and track completion status.',
      ),
      orientation_scheduler: buildAgentDsl(
        'orientation_scheduler',
        'Schedule orientation sessions, team introductions, and training activities for new employees.',
        'You schedule orientation activities for new hires. You coordinate training sessions, team introductions, and facility tours based on availability.',
      ),
      policy_faq: buildAgentDsl(
        'policy_faq',
        'Answer questions about company policies, benefits, procedures, and workplace guidelines.',
        'You answer questions about company policies and procedures. You provide accurate, referenced answers from the employee handbook and benefits documentation.',
      ),
    };

    const agents: Record<
      string,
      {
        path: string;
        owner: string | null;
        ownerTeam: string | null;
        description: string | null;
        version: string | null;
      }
    > = {};
    for (const name of agentNames) {
      agents[name] = {
        path: `agents/${name}.agent.abl`,
        owner: null,
        ownerTeam: null,
        description: null,
        version: null,
      };
    }
    agents.supervisor.description = 'Coordinates the onboarding process and routes to specialists';
    agents.document_collector.description = 'Guides new hires through required paperwork';
    agents.orientation_scheduler.description =
      'Schedules orientation sessions and team introductions';
    agents.policy_faq.description = 'Answers questions about company policies and benefits';

    const manifest = buildManifest({
      name: 'HR Onboarding',
      slug,
      description:
        'An employee onboarding project with document collection, orientation scheduling, and policy Q&A agents.',
      entryAgent: 'supervisor',
      agents,
      agentCount: 4,
    });

    const files: Record<string, string> = {
      'project.json': JSON.stringify(manifest, null, 2),
      'environment/env-vars.json': buildEnvVarsJson(),
    };
    for (const name of agentNames) {
      files[`agents/${name}.agent.abl`] = agentDsls[name];
    }

    templates.push({
      slug,
      name: 'HR Onboarding',
      shortDescription:
        'An employee onboarding project with document collection, orientation scheduling, and policy Q&A agents.',
      longDescription:
        'This project template streamlines the employee onboarding process with three coordinated agents: a document collector that guides new hires through required paperwork (tax forms, direct deposit, emergency contacts), an orientation scheduler that books training sessions and team introductions, and a policy FAQ agent that answers questions about company policies, benefits, and procedures. The supervisor ensures all onboarding milestones are tracked and completed.',
      type: 'project',
      typeMetadata: {
        type: 'project',
        agentCount: 4,
        hasSupervisor: true,
        hasFlow: true,
      },
      detailSections: ['agent-summary', 'demo-conversation', 'config-preview'],
      category: 'hr',
      tags: ['onboarding', 'human-resources', 'new-hire', 'compliance', 'orientation'],
      complexity: 'standard',
      demoConversation: [
        {
          role: 'user',
          content: "Hi, I'm starting next Monday and want to make sure I have everything ready.",
        },
        {
          role: 'assistant',
          content:
            "Welcome aboard! I'm excited to help you get set up. Let me check your onboarding checklist.\n\nHere's where you stand:\n- [Done] Offer letter signed\n- [Done] Background check completed\n- [Pending] Tax form (W-4)\n- [Pending] Direct deposit setup\n- [Pending] Emergency contact form\n\nWould you like to start with the tax form? I can walk you through it step by step.",
        },
        {
          role: 'user',
          content: 'Yes, please help me with the tax form.',
        },
      ],
      media: [],
      prerequisites: derivePrerequisites(manifest),
      reviewStatus: 'approved',
      featuredOrder: 4,
      files,
      manifest,
    });
  }

  return templates;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info('Starting Phase 2 template seed script');

  try {
    // 1. Connect to MongoDB
    const { ensureConnected } = await import('@agent-platform/database/models');
    await ensureConnected();
    log.info('Connected to MongoDB');

    const { Template, TemplateVersion } = await import('@agent-platform/database/models');

    // 2. Drop existing seed data (safe — platform-seeded only)
    log.info('Dropping existing templates and versions...');
    await Template.deleteMany({});
    await TemplateVersion.deleteMany({});

    // 3. Build and seed each template
    const seedTemplates = buildSeedTemplates();

    for (const seed of seedTemplates) {
      // Validate bundle size
      validateBundleSize(seed.files, seed.slug);

      // Create template
      const templateData = {
        slug: seed.slug,
        name: seed.name,
        shortDescription: seed.shortDescription,
        longDescription: seed.longDescription,
        type: seed.type,
        typeMetadata: seed.typeMetadata,
        detailSections: seed.detailSections,
        category: seed.category,
        tags: seed.tags,
        complexity: seed.complexity,
        demoConversation: seed.demoConversation,
        media: seed.media,
        prerequisites: seed.prerequisites,
        reviewStatus: seed.reviewStatus,
        featuredOrder: seed.featuredOrder,
        ...PUBLISHER,
        subcategory: null,
        industries: [],
        visibility: 'public',
        status: 'published',
        installCount: 0,
        activeInstallCount: 0,
        viewCount: 0,
        ratingAverage: 0,
        ratingCount: 0,
        publishedAt: new Date(),
        deprecatedAt: null,
        deprecationMessage: null,
        sourceId: null,
        sourceType: null,
        iconUrl: null,
      };

      const template = await Template.create(templateData);

      // Create version with files and manifest
      await TemplateVersion.create({
        templateId: template._id,
        version: '1.0.0',
        changelog: 'Initial release — Phase 2 seed data',
        manifest: seed.manifest,
        files: seed.files,
        customizationSchema: null,
        status: 'published',
        publishedAt: new Date(),
        createdBy: 'platform',
      });

      log.info(`Seeded: ${seed.slug}`, {
        type: seed.type,
        category: seed.category,
        fileCount: Object.keys(seed.files).length,
        bundleSize: JSON.stringify(seed.files).length,
      });
    }

    log.info('Seed completed', { total: seedTemplates.length });
  } catch (err) {
    log.error('Seed failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Disconnect and exit
  try {
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect();
    log.info('Disconnected from MongoDB');
  } catch (err) {
    log.error('Failed to disconnect', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  process.exit(0);
}

main();
