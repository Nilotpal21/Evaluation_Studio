import type { ServerMessage } from '@/types';

export function formatQueuedRuntimeNotice(reason: string): string {
  if (reason === 'auth_gate_active') {
    return 'Your message is queued until the required authorization is completed.';
  }
  return 'Your message has been queued.';
}

function formatAuthRequiredNotice(
  pending: Array<{ connector?: string; authProfileRef?: string }>,
): string {
  const labels = pending
    .map((requirement) => requirement.connector || requirement.authProfileRef || '')
    .filter((label) => label.trim().length > 0);
  if (labels.length === 0) {
    return 'Authorization is required before the agent can continue.';
  }
  return `Authorization is required before the agent can continue: ${labels.join(', ')}.`;
}

function formatToolWarningsNotice(warnings: string[]): string {
  return warnings.length === 1
    ? `Tool warning: ${warnings[0]}`
    : `Tool warnings: ${warnings.join(' | ')}`;
}

function formatAuthChallengeNotice(
  challenge: Partial<{ profileName: string; prompt: string; authUrl: string }>,
): string {
  const prompt = challenge.prompt?.trim();
  const profileName = challenge.profileName?.trim();
  const authUrl = challenge.authUrl?.trim();

  let base =
    prompt && prompt.length > 0
      ? prompt
      : profileName && profileName.length > 0
        ? `Authorization required for ${profileName}.`
        : 'Authorization is required to continue.';

  if (authUrl && authUrl.length > 0) {
    base = `${base} Open: ${authUrl}`;
  }

  return base;
}

function formatSessionHealthNotice(health: Array<{ message: string }>): string {
  return health.map((entry) => entry.message).join(' | ');
}

export function buildRuntimeChatNotice(
  message: Pick<ServerMessage, 'type'> & Record<string, unknown>,
): string | null {
  switch (message.type) {
    case 'error':
      return typeof message.message === 'string' ? message.message : null;
    case 'message_queued':
      return formatQueuedRuntimeNotice((message.reason as string) || 'queued');
    case 'auth_required':
      return formatAuthRequiredNotice(
        Array.isArray(message.pending)
          ? (message.pending as Array<{ connector?: string; authProfileRef?: string }>)
          : [],
      );
    case 'auth_challenge':
      return formatAuthChallengeNotice({
        profileName: message.profileName as string | undefined,
        prompt: message.prompt as string | undefined,
        authUrl: message.authUrl as string | undefined,
      });
    case 'tool_warnings':
      return formatToolWarningsNotice(
        Array.isArray(message.warnings) ? (message.warnings as string[]) : [],
      );
    case 'session_health':
      return formatSessionHealthNotice(
        Array.isArray(message.health) ? (message.health as Array<{ message: string }>) : [],
      );
    default:
      return null;
  }
}
