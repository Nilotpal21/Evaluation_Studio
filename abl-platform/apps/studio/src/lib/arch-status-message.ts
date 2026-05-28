import type { ArchStatus } from '@/lib/arch-ai/store/arch-config-store';

const ARCH_STATUS_SETUP_GUIDANCE =
  'Open Admin → Arch to choose Model Hub, use platform credits, or add a direct API key.';

export function getNonAdminArchStatusMessage(status: ArchStatus | null | undefined): string {
  switch (status?.requestedSource) {
    case 'platform':
      return `Saved Platform Credits aren't available. ${ARCH_STATUS_SETUP_GUIDANCE}`;
    case 'model_hub':
      return `Saved Model Hub setup isn't available. ${ARCH_STATUS_SETUP_GUIDANCE}`;
    case 'direct_api_key':
      return `Saved direct API key isn't available. ${ARCH_STATUS_SETUP_GUIDANCE}`;
    case 'auth_profile':
      return `Saved auth profile isn't available. ${ARCH_STATUS_SETUP_GUIDANCE}`;
    default:
      return `Arch could not find a usable model. ${ARCH_STATUS_SETUP_GUIDANCE}`;
  }
}
