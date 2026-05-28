import type { Readable } from 'stream';

export interface DocumentParser {
  readonly name: string;

  parse(params: {
    fileStream: Readable;
    mimeType: string;
    filename: string;
    options?: { ocrEnabled?: boolean; language?: string };
  }): Promise<{
    text: string;
    pageCount?: number;
    language?: string;
    metadata?: Record<string, string>;
    engine: string;
  }>;

  supportedMimeTypes(): string[];
}
