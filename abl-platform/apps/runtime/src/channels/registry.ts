/**
 * Channel Registry
 *
 * Singleton registry of channel adapters.
 * Adapters are registered at startup and looked up by channel type.
 */

import type { ChannelAdapter, ChannelType } from './types.js';
import { createLogger } from '@abl/compiler/platform';
import { HttpAsyncAdapter } from './adapters/http-async-adapter.js';
import { SlackAdapter } from './adapters/slack-adapter.js';
import { LineAdapter } from './adapters/line-adapter.js';
import { EmailAdapter } from './adapters/email-adapter.js';
import { MSTeamsAdapter } from './adapters/msteams-adapter.js';
import { VxmlAdapter } from './adapters/vxml-adapter.js';
import { KorevgAdapter } from './adapters/korevg-adapter.js';
import { WhatsAppAdapter } from './adapters/whatsapp-adapter.js';
import { registerWhatsAppProvider } from './adapters/whatsapp-provider.js';
import { MetaCloudProvider } from './adapters/whatsapp-providers/meta-cloud-provider.js';
import { InfobipProvider } from './adapters/whatsapp-providers/infobip-provider.js';
import { GupshupProvider } from './adapters/whatsapp-providers/gupshup-provider.js';
import { NetcoreProvider } from './adapters/whatsapp-providers/netcore-provider.js';
import { MessengerAdapter } from './adapters/messenger-adapter.js';
import { InstagramAdapter } from './adapters/instagram-adapter.js';
import { TwilioSmsAdapter } from './adapters/twilio-sms-adapter.js';
import { AgUiAdapter } from './adapters/ag-ui-adapter.js';
import { AudioCodesAdapter } from './adapters/audiocodes-adapter.js';
import { ZendeskAdapter } from './adapters/zendesk-adapter.js';
import { TelegramAdapter } from './adapters/telegram-adapter.js';
import { GenesysAdapter } from './adapters/genesys-adapter.js';
import { AI4WAdapter } from './adapters/ai4w-adapter.js';

const log = createLogger('channel-registry');

export class ChannelRegistry {
  private adapters = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
    log.info('Channel adapter registered', { channelType: adapter.channelType });
  }

  get(channelType: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  has(channelType: ChannelType): boolean {
    return this.adapters.has(channelType);
  }

  getRegisteredTypes(): ChannelType[] {
    return Array.from(this.adapters.keys());
  }
}

// Singleton
let registryInstance: ChannelRegistry | null = null;

export function getChannelRegistry(): ChannelRegistry {
  if (!registryInstance) {
    registryInstance = new ChannelRegistry();
    registryInstance.register(new HttpAsyncAdapter());
    registryInstance.register(new SlackAdapter());
    registryInstance.register(new LineAdapter());
    registryInstance.register(new EmailAdapter());
    registryInstance.register(new MSTeamsAdapter());
    registryInstance.register(new VxmlAdapter());
    registryInstance.register(new KorevgAdapter());
    registerWhatsAppProvider(new MetaCloudProvider());
    registerWhatsAppProvider(new InfobipProvider());
    registerWhatsAppProvider(new GupshupProvider());
    registerWhatsAppProvider(new NetcoreProvider());
    registryInstance.register(new WhatsAppAdapter());
    registryInstance.register(new MessengerAdapter());
    registryInstance.register(new InstagramAdapter());
    registryInstance.register(new TwilioSmsAdapter());
    registryInstance.register(new AgUiAdapter());
    registryInstance.register(new AudioCodesAdapter());
    registryInstance.register(new ZendeskAdapter());
    registryInstance.register(new TelegramAdapter());
    registryInstance.register(new GenesysAdapter());
    registryInstance.register(new AI4WAdapter());
  }
  return registryInstance;
}
