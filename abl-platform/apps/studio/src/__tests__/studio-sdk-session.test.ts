import { describe, expect, it } from 'vitest';

import {
  isStudioSdkSessionPermission,
  normalizeStudioSdkSessionPermissions,
  resolveStudioSdkSessionPermissions,
} from '@/lib/studio-sdk-session';

describe('studio SDK session permission normalization', () => {
  it('accepts session:read as a Studio SDK session permission', () => {
    expect(isStudioSdkSessionPermission('session:read')).toBe(true);
  });

  it('adds session:read when chat or voice permissions are present', () => {
    expect(normalizeStudioSdkSessionPermissions(['session:send_message'])).toEqual([
      'session:send_message',
      'session:read',
    ]);
    expect(normalizeStudioSdkSessionPermissions(['session:voice'])).toEqual([
      'session:voice',
      'session:read',
    ]);
  });

  it('does not grant interactive permissions from read-only or unknown values', () => {
    expect(normalizeStudioSdkSessionPermissions(['session:read', 'session:admin', null])).toEqual([
      'session:read',
    ]);
  });

  it('resolves widget permissions with Runtime-compatible read scope', () => {
    expect(resolveStudioSdkSessionPermissions({ chatEnabled: true, voiceEnabled: true })).toEqual([
      'session:send_message',
      'session:voice',
      'session:read',
    ]);
    expect(resolveStudioSdkSessionPermissions({ chatEnabled: false, voiceEnabled: false })).toEqual(
      [],
    );
  });
});
