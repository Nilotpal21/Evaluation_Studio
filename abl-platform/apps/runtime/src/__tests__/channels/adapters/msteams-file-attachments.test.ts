import { describe, it, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MSTeamsAdapter } from '../../../channels/adapters/msteams-adapter.js';

function makeMessageActivity(overrides?: {
  conversationType?: string;
  text?: string;
  locale?: string;
  attachments?: Array<Record<string, unknown>>;
}) {
  return {
    type: 'message',
    id: 'activity-1',
    timestamp: '2026-03-01T00:00:00.000Z',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    channelId: 'msteams',
    from: { id: 'user-1', name: 'User One' },
    conversation: {
      id: 'conv-1',
      conversationType: overrides?.conversationType ?? 'personal',
      tenantId: 'tenant-1',
    },
    recipient: { id: '28:app-123', name: 'Bot' },
    text: overrides?.text ?? '',
    locale: overrides?.locale,
    attachments: overrides?.attachments ?? [],
  };
}

describe('MSTeamsAdapter attachments', () => {
  const adapter = new MSTeamsAdapter();

  it('accepts personal file-only messages', () => {
    const payload = makeMessageActivity({
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: {
            downloadUrl: 'https://contoso.sharepoint.com/report.pdf',
            uniqueId: 'file-1',
            fileType: 'pdf',
          },
        },
      ],
    });

    expect(adapter.shouldProcess(payload)).toBe(true);
  });

  it('rejects non-personal file-only messages', () => {
    const payload = makeMessageActivity({
      conversationType: 'channel',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: {
            downloadUrl: 'https://contoso.sharepoint.com/report.pdf',
            uniqueId: 'file-1',
            fileType: 'pdf',
          },
        },
      ],
    });

    expect(adapter.shouldProcess(payload)).toBe(false);
  });

  it('extracts Teams file references in normalized metadata', () => {
    const payload = makeMessageActivity({
      text: 'Please review',
      locale: 'fr-FR',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: {
            downloadUrl: 'https://contoso.sharepoint.com/report.pdf',
            uniqueId: 'file-1',
            fileType: 'pdf',
          },
        },
        {
          contentType: 'image/png',
          name: 'diagram.png',
          contentUrl: 'https://files.teams.microsoft.com/diagram.png',
        },
      ],
    });

    const msg = adapter.buildNormalizedMessage(payload);
    const refs = msg.metadata?.teamsFileReferences as Array<Record<string, unknown>> | undefined;

    expect(msg.interactionContext).toEqual({
      language: 'fr',
      locale: 'fr-FR',
    });
    expect(refs).toBeDefined();
    expect(refs).toHaveLength(2);
    expect(refs?.[0]).toEqual({
      source: 'file_download_info',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      downloadUrl: 'https://contoso.sharepoint.com/report.pdf',
      fileType: 'pdf',
      uniqueId: 'file-1',
    });
    expect(refs?.[1]).toEqual({
      source: 'inline_image',
      name: 'diagram.png',
      mimeType: 'image/png',
      downloadUrl: 'https://files.teams.microsoft.com/diagram.png',
      requiresBotToken: true,
    });
  });

  it('still accepts text-only message activities', () => {
    const payload = makeMessageActivity({
      conversationType: 'channel',
      text: 'hello from channel',
      attachments: [],
    });
    expect(adapter.shouldProcess(payload)).toBe(true);
  });
});
