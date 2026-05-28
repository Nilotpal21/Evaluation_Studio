import { describe, expect, it } from 'vitest';
import { RICH_CONTENT_SUPPORT_SPECS } from '@agent-platform/web-sdk';
import {
  TEMPLATE_CATEGORIES,
  getCatalogByCategory,
  isTemplateInsertable,
  searchCatalog,
  templateCatalog,
} from '@/lib/template-catalog';

describe('templateCatalog', () => {
  it('includes every shared rich-content type plus the raw actions preview entry', () => {
    const catalogTypes = new Set(templateCatalog.map((entry) => entry.type));

    for (const spec of RICH_CONTENT_SUPPORT_SPECS) {
      expect(catalogTypes.has(spec.type)).toBe(true);
    }

    expect(catalogTypes.has('actions')).toBe(true);
  });

  it('keeps support modes aligned with the shared web-sdk support matrix', () => {
    const supportByType = new Map(RICH_CONTENT_SUPPORT_SPECS.map((spec) => [spec.type, spec]));

    for (const entry of templateCatalog) {
      const support = supportByType.get(entry.type);
      if (!support) {
        expect(entry.type).toBe('actions');
        expect(entry.webRenderMode).toBe('native');
        expect(entry.studioPreviewMode).toBe('native');
        continue;
      }

      expect(entry.webRenderMode).toBe(support.webRenderMode);
      expect(entry.studioPreviewMode).toBe(support.studioPreviewMode);
    }
  });

  it('returns stable category and search results', () => {
    expect(TEMPLATE_CATEGORIES).toEqual(['Content', 'Media', 'Data', 'Input', 'Feedback']);

    expect(getCatalogByCategory('Input').map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['form', 'actions']),
    );

    expect(searchCatalog('slack').map((entry) => entry.type)).toContain('slack');
    expect(searchCatalog('safe fallback').map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['adaptive_card', 'slack', 'whatsapp']),
    );
  });

  it('tracks current DSL authoring support separately from preview support', () => {
    const quickReplies = templateCatalog.find((entry) => entry.type === 'quick_replies');
    const actions = templateCatalog.find((entry) => entry.type === 'actions');
    const markdown = templateCatalog.find((entry) => entry.type === 'markdown');
    const carousel = templateCatalog.find((entry) => entry.type === 'carousel');

    expect(quickReplies?.dslAuthoringMode).toBe('preview_only');
    expect(isTemplateInsertable(quickReplies!)).toBe(false);
    expect(quickReplies?.dslSnippet).toContain('Preview only in Studio today.');

    expect(actions?.dslAuthoringMode).toBe('partial');
    expect(isTemplateInsertable(actions!)).toBe(true);
    expect(actions?.dslSnippet).toContain('ACTIONS:');
    expect(actions?.dslSnippet).toContain('BUTTON: "Approve" -> approve');

    expect(markdown?.dslAuthoringMode).toBe('supported');
    expect(isTemplateInsertable(markdown!)).toBe(true);

    expect(carousel?.dslAuthoringMode).toBe('supported');
    expect(carousel?.dslSnippet).toContain('CAROUSEL:');
    expect(carousel?.dslSnippet).toContain('BUTTONS:');
  });
});
