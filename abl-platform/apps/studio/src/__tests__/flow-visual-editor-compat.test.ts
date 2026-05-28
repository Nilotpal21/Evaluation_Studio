import { describe, expect, it } from 'vitest';

import {
  analyzeFlowVisualEditorCompatibility,
  getFlowVisualEditorSaveBlockReason,
} from '../lib/abl/flow-visual-editor-compat';

describe('flow visual editor compatibility', () => {
  it('treats canonical step-level call_spec as compatible', () => {
    const issues = analyzeFlowVisualEditorCompatibility({
      flow: {
        steps: ['lookup_customer'],
        definitions: {
          lookup_customer: {
            call_spec: {
              tool: 'lookup_customer',
              with: {
                email: 'customer_email',
              },
              as: 'customer_record',
            },
            then: 'COMPLETE',
          },
        },
      },
    });

    expect(issues).toEqual([]);
  });

  it('flags structured call_spec WITH payloads that the visual editor cannot round-trip safely', () => {
    const issues = analyzeFlowVisualEditorCompatibility({
      flow: {
        steps: ['lookup_customer'],
        definitions: {
          lookup_customer: {
            call_spec: {
              tool: 'lookup_customer',
              with: {
                filters: {
                  plan: 'gold',
                },
              },
              as: 'customer_record',
            },
            then: 'COMPLETE',
          },
        },
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepName: 'lookup_customer',
          path: 'call_spec.with.filters',
        }),
      ]),
    );
  });

  it('flags unsupported advanced execution blocks that would be lost on visual save', () => {
    const issues = analyzeFlowVisualEditorCompatibility({
      flow: {
        steps: ['triage'],
        definitions: {
          triage: {
            respond: 'Let me help',
            on_input: [{ then: 'next' }],
            digressions: [{ intent: 'help', respond: 'Sure' }],
            sub_intents: [{ intent: 'change_plan', respond: 'Okay' }],
            on_action: [{ action_id: 'choose_plan', respond: 'Locked in' }],
          },
        },
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepName: 'triage',
          path: 'on_input',
        }),
        expect.objectContaining({
          stepName: 'triage',
          path: 'digressions',
        }),
        expect.objectContaining({
          stepName: 'triage',
          path: 'sub_intents',
        }),
        expect.objectContaining({
          stepName: 'triage',
          path: 'on_action',
        }),
      ]),
    );
  });

  it('flags unsupported rich step structures such as gather blocks', () => {
    const issues = analyzeFlowVisualEditorCompatibility({
      flow: {
        steps: ['collect_email'],
        definitions: {
          collect_email: {
            gather: {
              fields: [{ name: 'email', type: 'string', required: true }],
            },
            then: 'COMPLETE',
          },
        },
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepName: 'collect_email',
          path: 'gather',
        }),
      ]),
    );
  });

  it('blocks flow visual saves only when flow is dirty and a full DSL replacement is not in play', () => {
    const issues = analyzeFlowVisualEditorCompatibility({
      flow: {
        steps: ['triage'],
        definitions: {
          triage: {
            on_input: [{ then: 'next' }],
          },
        },
      },
    });

    expect(getFlowVisualEditorSaveBlockReason(new Set(['identity']), issues)).toBeNull();
    expect(getFlowVisualEditorSaveBlockReason(new Set(['flow']), issues)).toContain(
      'cannot safely save this FLOW definition',
    );
    expect(getFlowVisualEditorSaveBlockReason(new Set(['definition', 'flow']), issues)).toBeNull();
  });
});
