import { describe, expect, it } from 'vitest';

import {
  analyzeGatherVisualEditorCompatibility,
  getGatherVisualEditorSaveBlockReason,
} from '../lib/abl/gather-visual-editor-compat';

describe('gather visual editor compatibility', () => {
  it('treats pii_type and supported semantics keys as compatible, while still flagging unsupported metadata', () => {
    const issues = analyzeGatherVisualEditorCompatibility({
      gather: {
        fields: [
          {
            name: 'contact_info',
            prompt: 'How should we reach you?',
            type: 'string',
            required: true,
            pii_type: 'email',
            default: 'test@example.com',
            semantics: {
              lookup: 'contact_methods',
              locale: 'en-US',
            },
          },
        ],
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'contact_info',
          path: 'default',
          label: 'default value',
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'pii_type' }),
        expect.objectContaining({ path: 'semantics.locale' }),
      ]),
    );
  });

  it('ignores gather metadata that the current visual editor can preserve', () => {
    const issues = analyzeGatherVisualEditorCompatibility({
      gather: {
        fields: [
          {
            name: 'email',
            prompt: 'Email?',
            type: 'string',
            required: true,
            infer: true,
            extraction_hints: ['work email'],
            validation: {
              type: 'pattern',
              rule: '.+@.+',
              error_message: 'Invalid email',
            },
            semantics: {
              lookup: 'email_domains',
            },
            sensitive: true,
            sensitive_display: 'mask',
            mask_config: { show_first: 1, show_last: 2, char: '*' },
            transient: true,
            extraction_pattern: '.+',
            extraction_group: 0,
            enum_values: [],
          },
        ],
      },
    });

    expect(issues).toEqual([]);
  });

  it('blocks visual saves only when gather is dirty and a full DSL replacement is not in play', () => {
    const issues = analyzeGatherVisualEditorCompatibility({
      gather: {
        fields: [
          {
            name: 'contact_info',
            prompt: 'Contact info',
            type: 'string',
            required: true,
            default: 'test@example.com',
          },
        ],
      },
    });

    expect(getGatherVisualEditorSaveBlockReason(new Set(['identity']), issues)).toBeNull();
    expect(getGatherVisualEditorSaveBlockReason(new Set(['gather']), issues)).toContain(
      'cannot safely save this GATHER definition',
    );
    expect(
      getGatherVisualEditorSaveBlockReason(new Set(['definition', 'gather']), issues),
    ).toBeNull();
  });
});
