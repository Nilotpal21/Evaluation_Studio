import { describe, expect, it } from 'vitest';

import {
  analyzeLifecycleVisualEditorCompatibility,
  getLifecycleVisualEditorSaveBlockReason,
} from '../lib/abl/lifecycle-visual-editor-compat';

describe('lifecycle visual editor compatibility', () => {
  it('flags unsupported ON_START shapes that the visual editor cannot preserve', () => {
    const issues = analyzeLifecycleVisualEditorCompatibility({
      on_start: {
        respond: 'Welcome!',
        delegate: 'welcome_flow',
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'onStart',
          path: 'delegate',
        }),
      ]),
    );
  });

  it('flags structured ON_START call_spec WITH payloads that would be serialized lossy', () => {
    const issues = analyzeLifecycleVisualEditorCompatibility({
      on_start: {
        call_spec: {
          tool: 'preload_member',
          with: {
            profile: {
              tier: 'gold',
            },
          },
          as: 'member_profile',
        },
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'onStart',
          path: 'call_spec.with.profile',
        }),
      ]),
    );
  });

  it('does not flag default_handler once the editor can preserve it', () => {
    const issues = analyzeLifecycleVisualEditorCompatibility({
      error_handling: {
        handlers: [{ type: 'timeout', respond: 'Try again', then: 'retry' }],
        default_handler: {
          type: 'default',
          then: 'continue',
        },
      },
    });

    expect(issues).toEqual([]);
  });

  it('does not flag structured ON_ERROR and COMPLETE fields that now round-trip safely', () => {
    const issues = analyzeLifecycleVisualEditorCompatibility({
      error_handling: {
        handlers: [
          {
            type: 'timeout',
            respond: 'Try again',
            then: 'continue',
            subtypes: ['transient'],
            retry: 2,
            retry_delay_ms: 2500,
            retry_backoff: 'exponential',
            retry_max_delay_ms: 10000,
            voice_config: {
              plain_text: 'Try again',
            },
            rich_content: {
              markdown: '### Try again',
            },
            actions: {
              elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
            },
          },
        ],
      },
      completion: {
        conditions: [
          {
            when: 'done == true',
            respond: 'Done',
            voice_config: {
              plain_text: 'Done',
            },
            rich_content: {
              markdown: '### Done',
            },
            actions: {
              elements: [{ id: 'done', type: 'button', label: 'Done' }],
            },
            store: '{done} -> user.last_status',
          },
        ],
      },
    });

    expect(issues).toEqual([]);
  });

  it('does not flag hook bodies because section-scoped lifecycle saves no longer rewrite HOOKS', () => {
    const issues = analyzeLifecycleVisualEditorCompatibility({
      hooks: {
        before_turn: {
          call_spec: {
            tool: 'audit_turn',
            with: {
              turnId: 'session.turn_id',
            },
          },
        },
      },
    });

    expect(issues).toEqual([]);
  });

  it('blocks saves only for the dirty lifecycle subsection', () => {
    const issues = analyzeLifecycleVisualEditorCompatibility({
      on_start: {
        delegate: 'welcome_flow',
      },
      error_handling: {
        handlers: [{ type: 'timeout', then: 'continue', unsupported_flag: true }],
      },
    });

    expect(getLifecycleVisualEditorSaveBlockReason(new Set(['completion']), issues)).toBeNull();
    expect(getLifecycleVisualEditorSaveBlockReason(new Set(['onStart']), issues)).toContain(
      'cannot safely save this ON_START definition',
    );
    expect(getLifecycleVisualEditorSaveBlockReason(new Set(['errorHandling']), issues)).toContain(
      'cannot safely save this ON_ERROR definition',
    );
    expect(
      getLifecycleVisualEditorSaveBlockReason(new Set(['definition', 'onStart']), issues),
    ).toBeNull();
  });
});
