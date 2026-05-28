// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  buildSharePreviewUrl,
  clearPersistedShareTokenFromBrowserSession,
  consumeShareTokenFromBrowserLocation,
  extractShareTokenFromUrl,
  stripShareTokenFromUrl,
} from '@/lib/share-preview-link';

describe('share-preview-link', () => {
  it('builds preview URLs with the share token in the fragment', () => {
    expect(buildSharePreviewUrl('https://studio.example.com', 'token-123')).toBe(
      'https://studio.example.com/preview#share_token=token-123',
    );
  });

  it('extracts share tokens from the fragment', () => {
    const url = new URL('https://studio.example.com/preview?mode=voice#share_token=token-123');
    expect(extractShareTokenFromUrl(url)).toEqual({ token: 'token-123', source: 'hash' });
  });

  it('ignores legacy query token parameters', () => {
    const url = new URL('https://studio.example.com/preview?mode=voice&token=legacy');
    expect(extractShareTokenFromUrl(url)).toEqual({ token: null, source: 'none' });
  });

  it('strips the fragment token while preserving non-secret params', () => {
    const url = new URL('https://studio.example.com/preview?mode=voice#share_token=token-123');
    expect(stripShareTokenFromUrl(url)).toBe('https://studio.example.com/preview?mode=voice');
  });

  it('consumes the fragment token, stores it for the current tab, and scrubs the URL', () => {
    window.sessionStorage.clear();
    window.history.replaceState(
      null,
      '',
      'http://localhost:3000/preview?mode=voice#share_token=token-123',
    );

    expect(consumeShareTokenFromBrowserLocation()).toEqual({
      token: 'token-123',
      source: 'hash',
    });
    expect(window.location.href).toBe('http://localhost:3000/preview?mode=voice');
    expect(consumeShareTokenFromBrowserLocation()).toEqual({
      token: 'token-123',
      source: 'sessionStorage',
    });
  });

  it('clears the persisted tab-local share token after a successful exchange', () => {
    window.sessionStorage.clear();
    window.history.replaceState(
      null,
      '',
      'http://localhost:3000/preview?mode=voice#share_token=token-123',
    );

    expect(consumeShareTokenFromBrowserLocation()).toEqual({
      token: 'token-123',
      source: 'hash',
    });

    clearPersistedShareTokenFromBrowserSession();

    expect(consumeShareTokenFromBrowserLocation()).toEqual({
      token: null,
      source: 'none',
    });
  });
});
