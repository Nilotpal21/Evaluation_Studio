import type { CreateChannelInput, UpdateChannelInput } from '../../../api/channels';
import type {
  ChannelEnvironment,
  CreateConnectionInput,
  UpdateConnectionInput,
} from '../../../api/channel-connections';

export interface ChannelBindingDraft {
  environment: string;
  followEnvironment: boolean;
  pinnedDeploymentId: string;
}

export function isWorkingCopyBinding(
  draft: Pick<ChannelBindingDraft, 'environment' | 'pinnedDeploymentId'>,
): boolean {
  return !draft.environment && !draft.pinnedDeploymentId;
}

export function buildSdkChannelBindingUpdate(draft: ChannelBindingDraft): UpdateChannelInput {
  if (draft.pinnedDeploymentId) {
    return {
      deploymentId: draft.pinnedDeploymentId,
      environment: null,
      followEnvironment: false,
    };
  }

  const environment = draft.environment || null;
  return {
    deploymentId: null,
    environment,
    followEnvironment: environment ? draft.followEnvironment : false,
  };
}

export function buildConnectionBindingUpdate(draft: ChannelBindingDraft): UpdateConnectionInput {
  if (draft.pinnedDeploymentId) {
    return {
      deployment_id: draft.pinnedDeploymentId,
      environment: null,
    };
  }

  return {
    deployment_id: null,
    environment: (draft.environment || null) as ChannelEnvironment | null,
  };
}

export function buildSdkChannelBindingCreate(
  draft: ChannelBindingDraft,
): Partial<CreateChannelInput> {
  if (draft.pinnedDeploymentId) {
    return {
      deploymentId: draft.pinnedDeploymentId,
    };
  }

  if (!draft.environment) {
    return {};
  }

  return {
    environment: draft.environment,
    followEnvironment: draft.followEnvironment,
  };
}

export function buildConnectionBindingCreate(
  draft: ChannelBindingDraft,
): Partial<CreateConnectionInput> {
  if (draft.pinnedDeploymentId) {
    return {
      deployment_id: draft.pinnedDeploymentId,
    };
  }

  if (!draft.environment) {
    return {};
  }

  return {
    environment: draft.environment as ChannelEnvironment,
  };
}
