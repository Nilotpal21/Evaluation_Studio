import type { ChannelConnectionDeleteOutcome } from '../api/channel-connections';
import type { InstanceSource, InstanceStatus } from '../components/deployments/channels/types';

export type ChannelDeleteAction = 'deactivate' | 'delete';

type ChannelDeleteSource = InstanceSource | 'channel_connection';
type ChannelDeleteStatus = InstanceStatus | 'active' | 'inactive' | 'error' | string;

interface ResolveChannelDeleteActionInput {
  source: ChannelDeleteSource;
  status?: ChannelDeleteStatus | null;
}

interface ResolveChannelDeleteOutcomeInput extends ResolveChannelDeleteActionInput {
  outcome?: ChannelConnectionDeleteOutcome;
}

export function resolveChannelDeleteAction({
  source,
  status,
}: ResolveChannelDeleteActionInput): ChannelDeleteAction {
  return source === 'channel_connection' && status !== 'inactive' ? 'deactivate' : 'delete';
}

export function resolveChannelDeleteOutcome({
  source,
  status,
  outcome,
}: ResolveChannelDeleteOutcomeInput): ChannelConnectionDeleteOutcome {
  if (outcome) {
    return outcome;
  }

  return resolveChannelDeleteAction({ source, status }) === 'deactivate'
    ? 'deactivated'
    : 'deleted';
}
