import { describe, expect, it } from 'vitest';
import { buildBlueprintDocumentArtifact } from '@/lib/arch-ai/blueprint-document';

describe('blueprint document artifact', () => {
  it('renders a 17-section blueprint document from session topology metadata', () => {
    const artifact = buildBlueprintDocumentArtifact({
      metadata: {
        specification: {
          projectName: 'EcomSupport',
          description: 'Support ecommerce order, return, shipping, and escalation requests.',
          channels: ['Web Chat', 'Email'],
          language: 'English',
          conversationNotes: ['Reduce routing errors', 'Escalate human-only cases cleanly'],
        },
      },
      topology: {
        pattern: 'hub_spoke',
        entryPoint: 'SupportRouter',
        agents: [
          {
            name: 'SupportRouter',
            role: 'Entry triage',
            executionMode: 'hybrid',
            description: 'Routes customer requests',
            tools: ['classify_request'],
            gatherFields: ['customer_email'],
            flowStepSeeds: ['normalize_request', 'route_request'],
            suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'HANDOFF'],
          },
          {
            name: 'ShippingDeliverySpecialist',
            role: 'Shipping support',
            executionMode: 'reasoning',
            description: 'Handles delivery questions',
            tools: ['lookup_order_status'],
            gatherFields: ['order_number'],
            flowStepSeeds: ['lookup_status', 'explain_delivery_state'],
            suggestedConstructs: ['GATHER', 'TOOLS', 'COMPLETE'],
          },
        ],
        edges: [
          {
            from: 'SupportRouter',
            to: 'ShippingDeliverySpecialist',
            type: 'delegate',
            condition: 'issue_type == "shipping_delivery"',
            expectReturn: true,
          },
        ],
      },
    });

    expect(artifact.sectionCount).toBe(17);
    expect(artifact.agentCount).toBe(2);
    expect(artifact.handoffCount).toBe(1);
    expect(artifact.status).toBe('draft');
    expect(artifact.markdown.match(/^## \d+\./gm)).toHaveLength(17);
    expect(artifact.markdown).toContain('# EcomSupport Blueprint');
    expect(artifact.markdown).toContain('## 17. Configuration Checklist');
    expect(artifact.markdown).toContain('SupportRouter -> ShippingDeliverySpecialist');
    expect(artifact.markdown).toContain('| SupportRouter | hybrid | Routes customer requests');
    expect(artifact.markdown).toContain('Tools: classify_request');
    expect(artifact.markdown).toContain('Inputs: customer_email');
    expect(artifact.markdown).toContain('lookup_order_status');
    expect(artifact.markdown).toContain('SupportRouter flow: normalize_request -> route_request');
    expect(artifact.markdown).toContain('returns to source');
  });

  it('carries source document architecture details into the blueprint', () => {
    const artifact = buildBlueprintDocumentArtifact({
      metadata: {
        specification: {
          projectName: 'Mercury Bank',
          description: 'Banking assistant from uploaded SOP.',
        },
        sourceArchitectureContract: {
          sourceFiles: ['mercury-bank-sop.md'],
          entryAgent: 'Banking_Supervisor',
          channels: ['Web', 'Voice', 'WhatsApp'],
          requiredMcpServers: ['Mercury Banking Server'],
          sharedMemoryVariables: ['customer_id'],
          universalRules: ['Never ask for customer_id more than once.'],
          guardrails: ['Prompt-injection protection'],
          optionalExternalAgents: [],
          confidence: 0.95,
          declaredAgents: [
            {
              name: 'Banking_Supervisor',
              role: 'Top-level greeter and intent router.',
              tools: [],
              memoryVariables: ['customer_id'],
              limitations: [],
              provenance: { fileName: 'mercury-bank-sop.md', section: 'Agents in the system' },
            },
            {
              name: 'Credit_Card_Payment_Agent',
              role: 'Outstanding dues, billing history, payment history, payments.',
              tools: ['get_credit_card_summary', 'initiate_payment'],
              memoryVariables: ['customer_id'],
              limitations: [],
              provenance: { fileName: 'mercury-bank-sop.md', section: '4.7 Tools' },
            },
          ],
          tools: [
            {
              name: 'initiate_payment',
              signature: '(account_id, amount) -> {success}',
              description: 'Pay a credit-card bill.',
              provenance: { fileName: 'mercury-bank-sop.md', section: 'Tool Catalog' },
            },
          ],
        },
      },
      topology: {
        pattern: 'hub_spoke',
        entryPoint: 'Banking_Supervisor',
        agents: [
          {
            name: 'Banking_Supervisor',
            role: 'Top-level greeter and intent router.',
            executionMode: 'hybrid',
            description: 'Routes banking customers.',
          },
          {
            name: 'Credit_Card_Payment_Agent',
            role: 'Credit-card payments.',
            executionMode: 'hybrid',
            description: 'Handles payments.',
            tools: ['get_credit_card_summary', 'initiate_payment'],
            gatherFields: ['customer_id'],
          },
        ],
        edges: [
          {
            from: 'Banking_Supervisor',
            to: 'Credit_Card_Payment_Agent',
            type: 'delegate',
            condition: 'credit_card_payment_intent == true',
          },
        ],
      },
    });

    expect(artifact.sourceArchitectureContract?.declaredAgents).toHaveLength(2);
    expect(artifact.markdown).toContain('Source coverage:');
    expect(artifact.markdown).toContain('Agents: 2/2 source-declared agents captured');
    expect(artifact.markdown).toContain('| Required MCP/tools | Mercury Banking Server |');
    expect(artifact.markdown).toContain('Session memory must preserve source-declared variables');
    expect(artifact.markdown).toContain('Source-declared tool catalog');
    expect(artifact.markdown).toContain('initiate_payment');
  });
});
