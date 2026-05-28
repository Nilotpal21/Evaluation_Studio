import { describe, expect, it } from 'vitest';
import {
  archFileMatchesAccept,
  normalizeArchUploadMimeType,
  resolveAcceptedArchUploadMimeType,
} from '@/lib/arch-ai/file-mime';

describe('arch-ai file MIME helpers', () => {
  it('derives markdown and pdf MIME types from filenames when browser MIME is generic', () => {
    expect(normalizeArchUploadMimeType('brief.md', 'application/octet-stream')).toBe(
      'text/markdown',
    );
    expect(normalizeArchUploadMimeType('requirements.markdown', '')).toBe('text/markdown');
    expect(normalizeArchUploadMimeType('architecture.pdf', 'application/octet-stream')).toBe(
      'application/pdf',
    );
  });

  it('normalizes common declared MIME aliases', () => {
    expect(resolveAcceptedArchUploadMimeType('brief', 'text/x-markdown')).toBe('text/markdown');
    expect(resolveAcceptedArchUploadMimeType('diagram', 'application/x-pdf')).toBe(
      'application/pdf',
    );
  });

  it('matches accept patterns against canonical MIME type and extension', () => {
    expect(archFileMatchesAccept('brief.md', 'application/octet-stream', 'text/*')).toBe(true);
    expect(archFileMatchesAccept('brief.md', 'application/octet-stream', '.md')).toBe(true);
    expect(archFileMatchesAccept('brief.md', 'application/octet-stream', 'application/pdf')).toBe(
      false,
    );
  });
});
