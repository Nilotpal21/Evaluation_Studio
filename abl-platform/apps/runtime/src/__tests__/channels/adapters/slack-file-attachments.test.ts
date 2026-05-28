/**
 * Slack File Attachments Tests
 *
 * Tests that SlackAdapter correctly handles file_share messages:
 * - shouldProcess accepts file_share messages with files but no text
 * - shouldProcess accepts file_share messages with both text and files
 * - buildNormalizedMessage includes slackFileReferences in metadata for file_share events
 * - buildNormalizedMessage skips files with file_access !== 'visible'
 * - buildNormalizedMessage has no slackFileReferences for regular text messages
 */

import { describe, it, expect } from 'vitest';
import { SlackAdapter } from '../../../channels/adapters/slack-adapter.js';

// Helper: build a minimal Slack event_callback with a file_share message
function makeFileSharePayload(overrides: {
  text?: string;
  files?: Array<Record<string, unknown>>;
  upload?: boolean;
}) {
  return {
    type: 'event_callback' as const,
    team_id: 'T123',
    event_id: 'Ev001',
    event_time: 1700000000,
    token: 'tok',
    api_app_id: 'A1',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel: 'C456',
      user: 'U789',
      text: overrides.text ?? '',
      ts: '1700000000.000100',
      event_ts: '1700000000.000100',
      channel_type: 'im',
      upload: overrides.upload ?? true,
      files: overrides.files ?? [],
    },
  };
}

function makeVisibleFile(id: string) {
  return {
    id,
    name: `file-${id}.pdf`,
    mimetype: 'application/pdf',
    filetype: 'pdf',
    size: 12345,
    url_private_download: `https://files.slack.com/files-pri/T123-${id}/download/file.pdf`,
    file_access: 'visible',
  };
}

function makeSnippetFile(id: string) {
  return {
    id,
    name: `snippet-${id}.txt`,
    mimetype: 'text/plain',
    filetype: 'text',
    size: 500,
    url_private_download: `https://files.slack.com/files-pri/T123-${id}/download/snippet.txt`,
    file_access: 'snippet_placeholder',
  };
}

describe('SlackAdapter file_share: shouldProcess', () => {
  const adapter = new SlackAdapter();

  it('accepts file_share messages with files but no text', () => {
    const body = makeFileSharePayload({
      text: '',
      files: [makeVisibleFile('F001')],
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts file_share messages with both text and files', () => {
    const body = makeFileSharePayload({
      text: 'Here is the report',
      files: [makeVisibleFile('F002')],
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('rejects file_share messages with no text and no files', () => {
    const body = makeFileSharePayload({
      text: '',
      files: [],
    });
    expect(adapter.shouldProcess(body)).toBe(false);
  });
});

describe('SlackAdapter file_share: buildNormalizedMessage', () => {
  const adapter = new SlackAdapter();

  it('includes slackFileReferences in metadata for file_share events', () => {
    const body = makeFileSharePayload({
      text: 'Check this out',
      files: [makeVisibleFile('F010'), makeVisibleFile('F011')],
    });

    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.text).toBe('Check this out');
    expect(msg.metadata?.slackFileReferences).toBeDefined();
    const refs = msg.metadata!.slackFileReferences as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      slackFileId: 'F010',
      name: 'file-F010.pdf',
      mimetype: 'application/pdf',
      filetype: 'pdf',
      size: 12345,
      downloadUrl: 'https://files.slack.com/files-pri/T123-F010/download/file.pdf',
    });
    expect(refs[1].slackFileId).toBe('F011');
  });

  it('skips files with file_access !== visible', () => {
    const body = makeFileSharePayload({
      text: 'Mixed files',
      files: [
        makeVisibleFile('F020'),
        makeSnippetFile('F021'),
        { ...makeVisibleFile('F022'), url_private_download: '' }, // empty URL
      ],
    });

    const msg = adapter.buildNormalizedMessage(body);
    const refs = msg.metadata!.slackFileReferences as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    expect(refs[0].slackFileId).toBe('F020');
  });

  it('has no slackFileReferences for regular text messages', () => {
    const body = {
      type: 'event_callback' as const,
      team_id: 'T123',
      event_id: 'Ev002',
      event_time: 1700000000,
      token: 'tok',
      api_app_id: 'A1',
      event: {
        type: 'message',
        channel: 'C456',
        user: 'U789',
        text: 'Hello agent',
        ts: '1700000000.000200',
        event_ts: '1700000000.000200',
        channel_type: 'im',
      },
    };

    const msg = adapter.buildNormalizedMessage(body);
    const refs = msg.metadata?.slackFileReferences as Array<Record<string, unknown>> | undefined;
    // For regular messages without files, slackFileReferences should be empty or absent
    expect(!refs || refs.length === 0).toBe(true);
  });
});
