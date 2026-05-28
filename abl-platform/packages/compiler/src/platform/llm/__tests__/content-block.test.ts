import { describe, it, expect } from 'vitest';
import type { ContentBlock, ImageContent } from '../types.js';
import { isImageContent, isTextContent } from '../types.js';

describe('ContentBlock types', () => {
  it('accepts ImageContent with base64 source', () => {
    const block: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' },
      attachmentId: 'att-1',
    };
    expect(block.type).toBe('image');
  });

  it('accepts ImageContent with URL source', () => {
    const block: ContentBlock = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.png' },
      attachmentId: 'att-2',
    };
    expect(block.type).toBe('image');
  });

  it('ImageContent attachmentId is optional', () => {
    const block: ContentBlock = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.png' },
    };
    expect(block.type).toBe('image');
    expect((block as ImageContent).attachmentId).toBeUndefined();
  });

  it('isImageContent correctly identifies ImageContent', () => {
    const imgBlock: ContentBlock = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.png' },
      attachmentId: 'att-1',
    };
    expect(isImageContent(imgBlock)).toBe(true);
    expect(isTextContent(imgBlock)).toBe(false);
  });

  it('isImageContent rejects non-image blocks', () => {
    const textBlock: ContentBlock = { type: 'text', text: 'hello' };
    expect(isImageContent(textBlock)).toBe(false);
    expect(isTextContent(textBlock)).toBe(true);
  });

  it('isImageContent rejects tool_use blocks', () => {
    const toolBlock: ContentBlock = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'search',
      input: {},
    };
    expect(isImageContent(toolBlock)).toBe(false);
  });
});
