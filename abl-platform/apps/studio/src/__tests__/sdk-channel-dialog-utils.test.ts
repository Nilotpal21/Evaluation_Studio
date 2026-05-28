import { describe, expect, it } from 'vitest';
import { buildSDKChannelInput } from '../components/admin/sdk-channel-dialog-utils';

describe('buildSDKChannelInput', () => {
  it('omits environment on edit when an unpinned channel is saved without changing it', () => {
    expect(
      buildSDKChannelInput({
        name: 'Support Widget',
        projectId: 'project-1',
        environment: null,
        initialEnvironment: null,
        enabled: true,
        rateLimitRpm: '',
        allowedOrigins: '',
        isEditing: true,
      }),
    ).toEqual({
      name: 'Support Widget',
      projectId: 'project-1',
      enabled: true,
      rateLimitRpm: null,
      allowedOrigins: null,
    });
  });

  it('includes environment on edit when the user pins a channel to a concrete environment', () => {
    expect(
      buildSDKChannelInput({
        name: 'Support Widget',
        projectId: 'project-1',
        environment: 'dev',
        initialEnvironment: null,
        enabled: true,
        rateLimitRpm: '',
        allowedOrigins: '',
        isEditing: true,
      }),
    ).toEqual({
      name: 'Support Widget',
      projectId: 'project-1',
      environment: 'dev',
      enabled: true,
      rateLimitRpm: null,
      allowedOrigins: null,
    });
  });
});
