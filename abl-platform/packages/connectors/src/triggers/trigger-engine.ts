/**
 * Trigger Engine Orchestrator
 *
 * Composes WebhookHandler, PollingScheduler, and CronScheduler.
 * Routes trigger registration/deregistration to the correct handler
 * based on trigger type.
 */

import { createLogger } from '../logger.js';
import type { ConnectorRegistry } from '../registry.js';
import type { ConnectorTrigger, KeyValueStore, TriggerContext } from '../types.js';
import type {
  TriggerRegistrationModel,
  RestateIngressClient,
  TriggerQueue,
  DecryptSecretFn,
  TriggerRedisClient,
  RegistrationTriggerType,
} from './types.js';
import {
  registerPollingTrigger,
  deregisterPollingTrigger,
  type PollingSchedulerDeps,
} from './polling-scheduler.js';
import {
  registerCronTrigger,
  deregisterCronTrigger,
  type CronSchedulerDeps,
} from './cron-scheduler.js';
import {
  DEFAULT_POLLING_INTERVAL_MS,
  DESIGN_TIME_TEST_TIMEOUT_MS,
  MAX_SAMPLE_PAYLOAD_BYTES,
} from './constants.js';
import { CONNECTOR_POLLING_DEFAULTS_MS } from './polling-defaults.js';

const log = createLogger('trigger-engine');

/** Build the public webhook URL used by external providers to POST events. */
function buildWebhookUrl(baseUrl: string, connectorName: string, registrationId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/api/v1/webhooks/connector/${encodeURIComponent(connectorName)}/${encodeURIComponent(registrationId)}`;
}

/** Resolves connection credentials for a webhook trigger's onEnable/onDisable call. */
export interface WebhookAuthResolver {
  resolveConnectionAuth(opts: {
    tenantId: string;
    projectId: string;
    connectionId: string;
  }): Promise<Record<string, unknown>>;
}

/** Dependencies for the TriggerEngine */
export interface TriggerEngineDeps {
  registry: ConnectorRegistry;
  registrationModel: TriggerRegistrationModel;
  restateClient: RestateIngressClient;
  redis: TriggerRedisClient;
  pollingQueue: TriggerQueue;
  cronQueue: TriggerQueue;
  decryptSecret: DecryptSecretFn;
  storeFactory: (connectionId: string) => KeyValueStore;
  /**
   * Resolves auth credentials for webhook lifecycle calls (onEnable/onDisable).
   * Required for webhook-strategy triggers that register subscriptions with
   * external providers (e.g. GitHub repo webhooks, Slack Events API).
   */
  authResolver?: WebhookAuthResolver;
  /**
   * Public base URL of the workflow-engine used to construct webhook URLs
   * passed to `trigger.onEnable({ webhookUrl })`. Providers POST to this URL
   * when an event fires. Example: "https://<host>" — final URL becomes
   * `${webhookBaseUrl}/api/v1/webhooks/connector/${connectorName}/${registrationId}`.
   */
  webhookBaseUrl?: string;
  /**
   * Optional field-level encryption for design-time sample payloads. When
   * provided, `testSample` encrypts the JSON-serialized sample before storing.
   * Omit only in test environments that do not initialise the DEK facade.
   */
  encryptSample?: (plaintext: string, tenantId: string) => Promise<string>;
}

/** Input for registering a trigger */
export interface RegisterTriggerInput {
  registrationId: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersionId?: string;
  environment?: string;
  connectorName: string;
  triggerName: string;
  connectionId: string;
  config: Record<string, unknown>;
  cronExpression?: string;
  pollingIntervalMs?: number;
  /**
   * User-configured trigger parameters (e.g. GitHub `repository`, Slack `channel`).
   * Forwarded as `propsValue` to `trigger.onEnable()` so webhook triggers can
   * register against the correct resource.
   */
  triggerParams?: Record<string, unknown>;
}

export class TriggerEngine {
  private readonly pollingDeps: PollingSchedulerDeps;
  private readonly cronDeps: CronSchedulerDeps;

  constructor(private readonly deps: TriggerEngineDeps) {
    this.pollingDeps = {
      registry: deps.registry,
      registrationModel: deps.registrationModel,
      restateClient: deps.restateClient,
      queue: deps.pollingQueue,
      storeFactory: deps.storeFactory,
    };

    this.cronDeps = {
      registrationModel: deps.registrationModel,
      restateClient: deps.restateClient,
      queue: deps.cronQueue,
    };
  }

  /**
   * Register a trigger — routes to webhook/cron/event based on connector trigger type.
   * Event triggers are passive (push-based via the webhook route, no scheduled jobs).
   */
  async registerTrigger(input: RegisterTriggerInput): Promise<{ triggerType: string }> {
    const trigger = await this.deps.registry.getTrigger(input.connectorName, input.triggerName);
    if (!trigger) {
      throw new Error(`Unknown trigger: ${input.connectorName}/${input.triggerName}`);
    }

    const triggerType = trigger.triggerType;

    switch (triggerType) {
      case 'event':
        // Event triggers are passive — they don't need scheduled jobs.
        // The webhook route handles incoming POSTs directly.
        return { triggerType: 'event' };

      case 'webhook': {
        // Webhook triggers are push-based: the inbound webhook route handles
        // POSTs. But for AP-style providers (GitHub, Slack, Stripe…) we must
        // call `trigger.onEnable()` so the connector subscribes with the
        // provider, receiving back a webhook ID it stores via `ctx.store`.
        if (!this.deps.authResolver) {
          log.warn('Webhook trigger registered without authResolver — onEnable skipped', {
            registrationId: input.registrationId,
            connectorName: input.connectorName,
            triggerName: input.triggerName,
          });
          return { triggerType: 'webhook' };
        }
        if (!this.deps.webhookBaseUrl) {
          log.warn('Webhook trigger registered without webhookBaseUrl — onEnable skipped', {
            registrationId: input.registrationId,
            connectorName: input.connectorName,
            triggerName: input.triggerName,
          });
          return { triggerType: 'webhook' };
        }

        const auth = await this.deps.authResolver.resolveConnectionAuth({
          tenantId: input.tenantId,
          projectId: input.projectId,
          connectionId: input.connectionId,
        });
        const store = this.deps.storeFactory(input.registrationId);
        const webhookUrl = buildWebhookUrl(
          this.deps.webhookBaseUrl,
          input.connectorName,
          input.registrationId,
        );

        const ctx: TriggerContext & { propsValue?: Record<string, unknown> } = {
          auth,
          tenantId: input.tenantId,
          projectId: input.projectId,
          connectionId: input.connectionId,
          store,
          webhookUrl,
          propsValue: input.triggerParams ?? {},
        };

        try {
          await trigger.onEnable(ctx);
        } catch (err) {
          log.error('Webhook trigger onEnable failed', {
            registrationId: input.registrationId,
            connectorName: input.connectorName,
            triggerName: input.triggerName,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        log.info('Webhook trigger registered', {
          registrationId: input.registrationId,
          connectorName: input.connectorName,
          triggerName: input.triggerName,
          webhookUrl,
        });
        return { triggerType: 'webhook' };
      }

      case 'polling': {
        // AP polling triggers use pollingHelper.onEnable() to seed the store
        // with the initial lastPoll timestamp. Without this, the first run()
        // call throws "lastPoll doesn't exist in the store."
        await this.runOnEnable(trigger, input);
        await registerPollingTrigger(
          {
            _id: input.registrationId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            connectorName: input.connectorName,
            triggerName: input.triggerName,
            connectionId: input.connectionId,
            pollingIntervalMs:
              input.pollingIntervalMs ?? trigger.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
          },
          this.pollingDeps,
        );
        return { triggerType: 'polling' };
      }

      case 'cron':
        // Cron triggers include both cron-expression and polling-interval jobs.
        if (input.cronExpression) {
          await registerCronTrigger(
            {
              _id: input.registrationId,
              tenantId: input.tenantId,
              projectId: input.projectId,
              workflowId: input.workflowId,
              connectorName: input.connectorName,
              triggerName: input.triggerName,
              connectionId: input.connectionId,
              cronExpression: input.cronExpression,
              workflowVersionId: input.workflowVersionId,
              environment: input.environment,
            },
            this.cronDeps,
          );
        } else {
          // Polling-style cron: use interval-based repeatable job.
          // Must call onEnable first to seed AP pollingHelper store state.
          await this.runOnEnable(trigger, input);
          await registerPollingTrigger(
            {
              _id: input.registrationId,
              tenantId: input.tenantId,
              projectId: input.projectId,
              connectorName: input.connectorName,
              triggerName: input.triggerName,
              connectionId: input.connectionId,
              pollingIntervalMs:
                input.pollingIntervalMs ??
                trigger.pollingIntervalMs ??
                CONNECTOR_POLLING_DEFAULTS_MS[input.connectorName] ??
                DEFAULT_POLLING_INTERVAL_MS,
              workflowVersionId: input.workflowVersionId,
              environment: input.environment,
            },
            this.pollingDeps,
          );
        }
        return { triggerType: 'cron' };

      default: {
        const _exhaustive: never = triggerType;
        throw new Error(`Unknown trigger type: ${_exhaustive}`);
      }
    }
  }

  /**
   * Call trigger.onEnable() for polling/cron triggers to seed AP store state.
   * Skipped silently if no authResolver is configured (e.g. tests without auth).
   */
  private async runOnEnable(trigger: ConnectorTrigger, input: RegisterTriggerInput): Promise<void> {
    if (!this.deps.authResolver) {
      log.warn('Polling trigger onEnable skipped — no authResolver configured', {
        registrationId: input.registrationId,
        connectorName: input.connectorName,
        triggerName: input.triggerName,
      });
      return;
    }
    try {
      const auth = await this.deps.authResolver.resolveConnectionAuth({
        tenantId: input.tenantId,
        projectId: input.projectId,
        connectionId: input.connectionId,
      });
      const store = this.deps.storeFactory(input.registrationId);
      const ctx: TriggerContext & { propsValue?: Record<string, unknown> } = {
        auth,
        tenantId: input.tenantId,
        projectId: input.projectId,
        connectionId: input.connectionId,
        store,
        webhookUrl: '',
        connectorName: input.connectorName,
        propsValue: input.triggerParams ?? {},
      };
      await trigger.onEnable(ctx as TriggerContext);
    } catch (err) {
      log.error('Polling trigger onEnable failed', {
        registrationId: input.registrationId,
        connectorName: input.connectorName,
        triggerName: input.triggerName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Deregister a trigger — removes scheduled jobs for polling/cron,
   * and calls `onDisable` for webhook triggers so the connector unsubscribes
   * with the upstream provider.
   */
  async deregisterTrigger(
    registrationId: string,
    triggerType: 'webhook' | 'polling' | 'cron' | 'event',
    config?: {
      pollingIntervalMs?: number;
      cronExpression?: string;
      connectorName?: string;
      triggerName?: string;
      tenantId?: string;
      projectId?: string;
      connectionId?: string;
      triggerParams?: Record<string, unknown>;
    },
  ): Promise<void> {
    switch (triggerType) {
      case 'event':
        // Event triggers are passive — nothing to clean up
        return;

      case 'webhook': {
        if (
          !this.deps.authResolver ||
          !config?.connectorName ||
          !config.triggerName ||
          !config.tenantId ||
          !config.projectId ||
          !config.connectionId
        ) {
          return;
        }
        const trigger = await this.deps.registry.getTrigger(
          config.connectorName,
          config.triggerName,
        );
        if (!trigger) return;

        try {
          const auth = await this.deps.authResolver.resolveConnectionAuth({
            tenantId: config.tenantId,
            projectId: config.projectId,
            connectionId: config.connectionId,
          });
          const store = this.deps.storeFactory(registrationId);
          const webhookUrl = this.deps.webhookBaseUrl
            ? buildWebhookUrl(this.deps.webhookBaseUrl, config.connectorName, registrationId)
            : '';

          const ctx: TriggerContext & { propsValue?: Record<string, unknown> } = {
            auth,
            tenantId: config.tenantId,
            projectId: config.projectId,
            connectionId: config.connectionId,
            store,
            webhookUrl,
            propsValue: config.triggerParams ?? {},
          };
          await trigger.onDisable(ctx);
        } catch (err) {
          log.warn('Webhook trigger onDisable failed — continuing deregister', {
            registrationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'polling':
        await deregisterPollingTrigger(
          registrationId,
          config?.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
          { queue: this.deps.pollingQueue },
        );
        return;

      case 'cron':
        if (config?.cronExpression) {
          await deregisterCronTrigger(registrationId, config.cronExpression, {
            queue: this.deps.cronQueue,
          });
        }
        if (config?.pollingIntervalMs !== undefined) {
          await deregisterPollingTrigger(registrationId, config.pollingIntervalMs, {
            queue: this.deps.pollingQueue,
          });
        }
        // If neither provided, attempt polling deregister with default interval
        if (!config?.cronExpression && config?.pollingIntervalMs === undefined) {
          await deregisterPollingTrigger(registrationId, DEFAULT_POLLING_INTERVAL_MS, {
            queue: this.deps.pollingQueue,
          });
        }
        return;

      default: {
        const _exhaustive: never = triggerType;
        throw new Error(`Unknown trigger type: ${_exhaustive}`);
      }
    }
  }

  /**
   * Pause a trigger — sets status to 'paused' and removes scheduled jobs.
   */
  async pauseTrigger(
    registrationId: string,
    tenantId: string,
    triggerType: RegistrationTriggerType,
    config?: { pollingIntervalMs?: number; cronExpression?: string },
  ): Promise<void> {
    await this.deps.registrationModel.findOneAndUpdate(
      { _id: registrationId, tenantId },
      { $set: { status: 'paused' } },
    );

    await this.deregisterTrigger(registrationId, triggerType, config);
  }

  /**
   * Run the trigger's test function using stored credentials to get sample data.
   * Saves the first item as samplePayload on the registration for future use.
   */
  async testSample(
    registrationId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{ sample: Record<string, unknown>; itemCount: number }> {
    const registration = await this.deps.registrationModel.findOne({
      _id: registrationId,
      tenantId,
      projectId,
    });
    if (!registration) throw new Error(`Trigger registration not found: ${registrationId}`);

    const connectorName =
      (registration.config?.connectorName as string | undefined) ?? registration.connectorName;
    const triggerName =
      (registration.config?.triggerName as string | undefined) ?? registration.triggerName;

    const trigger = await this.deps.registry.getTrigger(connectorName, triggerName);
    if (!trigger) throw new Error(`Unknown trigger: ${connectorName}/${triggerName}`);

    if (!this.deps.authResolver) throw new Error('Auth resolver not configured');

    const auth = await this.deps.authResolver.resolveConnectionAuth({
      tenantId,
      projectId,
      connectionId: registration.connectionId,
    });

    // Use a blank store so triggers that key off stored state (e.g. Gmail's
    // lastPoll) start from epoch 0, fetching the most recent items rather than
    // filtering to "new since onEnable".
    const blankStore: import('../types.js').KeyValueStore = {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
    };
    const ctx: import('../types.js').TriggerRunContext = {
      auth,
      tenantId,
      projectId,
      connectionId: registration.connectionId,
      store: blankStore,
      webhookUrl: '',
      connectorName,
      lastRunData: {},
      propsValue: (registration.config?.triggerParams as Record<string, unknown>) ?? {},
      // Design-time sample run: replace attachment binaries with a clearly
      // non-navigable placeholder URL instead of inlining the entire payload
      // as a base64 data URI. Keeps samplePayload small (avoids 16 MB Mongo
      // doc limit), preserves the URL-shape downstream expressions expect
      // (e.g. `attachments[0].url`), and uses a non-https scheme so nothing
      // accidentally tries to fetch from example.com.
      fileWriter: async (fileName: string) =>
        `placeholder://test-sample-attachment/${encodeURIComponent(fileName)}`,
    };

    // testRun() applies its own fallback chain: live test() → filter null/undefined
    // → static sampleData → []. So `items[0]` is either a real payload or the
    // AP-bundled sampleData; either way the schema is usable.
    const testTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Connector test timed out after ${DESIGN_TIME_TEST_TIMEOUT_MS / 1000}s`),
          ),
        DESIGN_TIME_TEST_TIMEOUT_MS,
      ),
    );
    const items = await Promise.race([(trigger.testRun ?? trigger.run)(ctx), testTimeout]);
    const first = items[0];
    const sample: Record<string, unknown> =
      first && typeof first === 'object' && !Array.isArray(first)
        ? (first as Record<string, unknown>)
        : {};

    // Cap the stored sample to MAX_SAMPLE_PAYLOAD_BYTES to prevent large connector
    // payloads (attachments, binary blobs) from exhausting Mongo storage.
    const sampleJson = JSON.stringify(sample);
    const cappedJson =
      Buffer.byteLength(sampleJson, 'utf8') > MAX_SAMPLE_PAYLOAD_BYTES
        ? JSON.stringify({ _truncated: true, _reason: 'payload exceeded 64 KB limit' })
        : sampleJson;
    const cappedSample: Record<string, unknown> = JSON.parse(cappedJson) as Record<string, unknown>;

    const encryptFn = this.deps.encryptSample;
    const storedValue = encryptFn ? await encryptFn(cappedJson, tenantId) : cappedJson;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.deps.registrationModel.findOneAndUpdate(
      { _id: registrationId, tenantId, projectId },
      { $set: { samplePayload: storedValue, samplePayloadExpiresAt: expiresAt } },
    );

    return { sample: cappedSample, itemCount: items.length };
  }
}
