import { createLogger } from '@abl/compiler/platform';
import { AgentTransferConfigSchema, type AgentTransferConfig } from './schema.js';

const log = createLogger('config-reloader');
const RELOAD_CHANNEL = 'at_config_reload';

export interface RedisSubscriber {
  subscribe(channel: string): Promise<void>;
  on(event: 'message', handler: (channel: string, message: string) => void): void;
  unsubscribe(channel: string): Promise<void>;
}

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

export type ConfigReloadCallback = (config: AgentTransferConfig) => void | Promise<void>;

export class AgentTransferConfigReloader {
  private readonly subscriber: RedisSubscriber;
  private readonly onReload: ConfigReloadCallback;
  private started = false;

  constructor(subscriber: RedisSubscriber, onReload: ConfigReloadCallback) {
    this.subscriber = subscriber;
    this.onReload = onReload;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.subscriber.subscribe(RELOAD_CHANNEL);
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== RELOAD_CHANNEL) return;
      void this.handleReload(message);
    });
    this.started = true;
    log.info('Config reloader started', { channel: RELOAD_CHANNEL });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.subscriber.unsubscribe(RELOAD_CHANNEL);
    this.started = false;
    log.info('Config reloader stopped');
  }

  private async handleReload(message: string): Promise<void> {
    try {
      const raw = JSON.parse(message);
      const config = AgentTransferConfigSchema.parse(raw);
      await this.onReload(config);
      log.info('Config reloaded successfully');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn('Config reload failed, keeping current config', {
        error: errorMsg,
      });
    }
  }

  static async triggerReload(
    publisher: RedisPublisher,
    config: AgentTransferConfig,
  ): Promise<void> {
    await publisher.publish(RELOAD_CHANNEL, JSON.stringify(config));
    log.info('Config reload triggered');
  }
}
