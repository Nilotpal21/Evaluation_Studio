import { describe, expect, it } from 'vitest';

import {
  buildConnectionBindingCreate,
  buildConnectionBindingUpdate,
  buildSdkChannelBindingCreate,
  buildSdkChannelBindingUpdate,
  isWorkingCopyBinding,
} from '../../components/deployments/channels/channel-binding-utils';

describe('channel binding utils', () => {
  it('treats empty deployment and environment as working copy', () => {
    expect(
      isWorkingCopyBinding({
        pinnedDeploymentId: '',
        environment: '',
      }),
    ).toBe(true);
  });

  it('clears stale SDK deployment state when switching to working copy', () => {
    expect(
      buildSdkChannelBindingUpdate({
        pinnedDeploymentId: '',
        environment: '',
        followEnvironment: true,
      }),
    ).toEqual({
      deploymentId: null,
      environment: null,
      followEnvironment: false,
    });
  });

  it('pins channel connections to a selected deployment during create', () => {
    expect(
      buildConnectionBindingCreate({
        pinnedDeploymentId: 'dep-123',
        environment: '',
        followEnvironment: true,
      }),
    ).toEqual({
      deployment_id: 'dep-123',
    });
  });

  it('builds environment-following SDK create payloads without a pinned deployment', () => {
    expect(
      buildSdkChannelBindingCreate({
        pinnedDeploymentId: '',
        environment: 'staging',
        followEnvironment: true,
      }),
    ).toEqual({
      environment: 'staging',
      followEnvironment: true,
    });
  });

  it('clears pinned channel connection deployments when saving working copy', () => {
    expect(
      buildConnectionBindingUpdate({
        pinnedDeploymentId: '',
        environment: '',
        followEnvironment: true,
      }),
    ).toEqual({
      deployment_id: null,
      environment: null,
    });
  });
});
