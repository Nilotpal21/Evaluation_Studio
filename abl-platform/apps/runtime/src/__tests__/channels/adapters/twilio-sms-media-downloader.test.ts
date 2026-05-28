import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  downloadTwilioMedia,
  type TwilioMediaReference,
} from '../../../channels/adapters/twilio-sms-media-downloader.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ACCOUNT_SID = 'AC1234567890abcdef1234567890abcdef';
const AUTH_TOKEN = 'test_auth_token_secret_123';
const BASE_OPTIONS = { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN };

const IMAGE_REF: TwilioMediaReference = {
  url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
  contentType: 'image/jpeg',
  index: 0,
};

function makeSuccessResponse(
  contentType = 'image/jpeg',
  contentLength = '2048',
): Record<string, unknown> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return contentType;
        if (name === 'content-length') return contentLength;
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  };
}

describe('downloadTwilioMedia', () => {
  it('downloads from Twilio API with Basic Auth and returns a readable stream', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());

    const result = await downloadTwilioMedia(IMAGE_REF, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.filename).toMatch(/^twilio_mms_0_\d+\.jpeg$/);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(2048);
    }

    // Should use Basic Auth header
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callHeaders = mockFetch.mock.calls[0][1]?.headers;
    const expectedAuth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    expect(callHeaders.Authorization).toBe(`Basic ${expectedAuth}`);
  });

  it('generates correct filename using media index', async () => {
    const ref: TwilioMediaReference = {
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME001',
      contentType: 'video/mp4',
      index: 2,
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('video/mp4', '10000'));

    const result = await downloadTwilioMedia(ref, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toMatch(/^twilio_mms_2_\d+\.mp4$/);
      expect(result.mimeType).toBe('video/mp4');
    }
  });

  it('handles mime types with parameters', async () => {
    const ref: TwilioMediaReference = {
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME002',
      contentType: 'audio/ogg',
      index: 0,
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('audio/ogg; codecs=opus', '5000'));

    const result = await downloadTwilioMedia(ref, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('audio/ogg');
      expect(result.filename).toMatch(/\.ogg$/);
    }
  });

  it('uses "bin" extension for unknown mime types', async () => {
    const ref: TwilioMediaReference = {
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME003',
      contentType: 'application/x-custom',
      index: 0,
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('application/x-custom', '1000'));

    const result = await downloadTwilioMedia(ref, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filename).toMatch(/\.bin$/);
    }
  });

  // ── SSRF host allowlist ───────────────────────────────────────────────

  it('blocks download from non-Twilio host', async () => {
    const maliciousRef: TwilioMediaReference = {
      url: 'http://169.254.169.254/latest/meta-data/',
      contentType: 'image/jpeg',
      index: 0,
    };

    const result = await downloadTwilioMedia(maliciousRef, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not an allowed Twilio domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks download from lookalike domain', async () => {
    const lookalike: TwilioMediaReference = {
      url: 'https://evil-twilio.com/exploit.jpg',
      contentType: 'image/jpeg',
      index: 0,
    };

    const result = await downloadTwilioMedia(lookalike, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not an allowed Twilio domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows download from api.twilio.com', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse());
    const result = await downloadTwilioMedia(IMAGE_REF, BASE_OPTIONS);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows download from subdomain of twilio.com', async () => {
    const ref: TwilioMediaReference = {
      url: 'https://media.twilio.com/AC123/Messages/SM456/Media/ME789',
      contentType: 'image/png',
      index: 0,
    };
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('image/png', '3000'));
    const result = await downloadTwilioMedia(ref, BASE_OPTIONS);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('blocks download with invalid URL', async () => {
    const badRef: TwilioMediaReference = {
      url: 'not-a-url',
      contentType: 'image/jpeg',
      index: 0,
    };
    const result = await downloadTwilioMedia(badRef, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not an allowed Twilio domain');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────────────────

  it('returns error when URL is missing', async () => {
    const noUrlRef: TwilioMediaReference = { url: '', contentType: 'image/jpeg', index: 0 };
    const result = await downloadTwilioMedia(noUrlRef, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing media URL');
    }
  });

  it('returns error when HTTP response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
    });

    const result = await downloadTwilioMedia(IMAGE_REF, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('403');
      expect(result.error).toContain('Forbidden');
    }
  });

  it('returns error when file exceeds max size', async () => {
    mockFetch.mockResolvedValueOnce(makeSuccessResponse('image/jpeg', '200000000'));

    const result = await downloadTwilioMedia(IMAGE_REF, {
      ...BASE_OPTIONS,
      maxSizeBytes: 100_000_000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exceeds');
    }
  });

  it('returns error when response has no body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/jpeg';
          if (name === 'content-length') return '100';
          return null;
        },
      },
      body: null,
    });

    const result = await downloadTwilioMedia(IMAGE_REF, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no body');
    }
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await downloadTwilioMedia(IMAGE_REF, BASE_OPTIONS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Network error');
    }
  });

  it('defaults to application/octet-stream when both headers and ref contentType are empty', async () => {
    const refNoType: TwilioMediaReference = {
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
      contentType: '',
      index: 0,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: () => null,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    });

    const result = await downloadTwilioMedia(refNoType, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.filename).toMatch(/\.bin$/);
    }
  });

  it('sets sizeBytes to 0 when content-length header is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'image/png';
          return null;
        },
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    });

    const result = await downloadTwilioMedia(IMAGE_REF, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.sizeBytes).toBe(0);
    }
  });

  it('falls back to mediaRef.contentType when response has no content-type', async () => {
    const ref: TwilioMediaReference = {
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
      contentType: 'image/gif',
      index: 0,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-length') return '500';
          return null;
        },
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    });

    const result = await downloadTwilioMedia(ref, BASE_OPTIONS);
    expect(result.success).toBe(true);
    if (result.success) {
      // The downloader falls back to mediaRef.contentType before application/octet-stream
      expect(result.mimeType).toBe('image/gif');
      expect(result.filename).toMatch(/\.gif$/);
    }
  });
});
