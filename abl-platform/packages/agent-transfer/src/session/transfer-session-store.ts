/**
 * Transfer Session Store
 *
 * Redis-backed store for agent transfer sessions.
 * Manages the lifecycle of transfer sessions from creation to cleanup.
 *
 * Key layout:
 *   agent_transfer:{tenantId}:{contactId}:{channel}              HASH   - Session data
 *   at_by_provider:{provider}:{tenantId}:{providerSessionId}     STRING - Reverse lookup
 *   at_active_sessions                                            SET    - All active session keys
 *   at_pod:{hostname}                                             SET    - Sessions owned by pod
 */
import { runLuaScript, type RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import type { SessionFieldEncryptor } from '../security/session-field-encryption.js';
import {
  buildTransferRoutingContext,
  normalizeTransferChannel,
  resolveTransferOwnerId,
} from '../types.js';
import {
  SCRIPT_CREATE_SESSION,
  SCRIPT_END_SESSION,
  SCRIPT_CLAIM_SESSION,
  SCRIPT_UPDATE_SESSION,
  SCRIPT_EXTEND_TTL,
  SCRIPT_COMPLETE_ACW_IF_PENDING,
} from './lua-scripts.js';
import {
  CHANNEL_TTL_DEFAULTS,
  ACTIVE_SESSIONS_SET,
  sessionKey,
  providerIndexKey,
  podSessionsKey,
  type TransferSessionData,
  type CreateTransferSessionInput,
  type UpdateTransferSessionFields,
  type CreateSessionResult,
  type ClaimSessionResult,
} from './types.js';

const log = createLogger('transfer-session-store');

const REDIS_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Redis operation timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export class TransferSessionStore {
  private readonly redis: RedisClient;
  private readonly encryptor: SessionFieldEncryptor | null;

  constructor(redis: RedisClient, encryptor?: SessionFieldEncryptor) {
    this.redis = redis;
    this.encryptor = encryptor ?? null;
  }

  /**
   * Create a new transfer session atomically.
   * Fails if a session already exists for the same tenant+contact+channel.
   */
  async create(input: CreateTransferSessionInput): Promise<CreateSessionResult> {
    const now = Date.now();
    const normalizedChannel =
      input.routing?.normalizedTransferChannel ?? normalizeTransferChannel(input.channel);
    const ownerId = resolveTransferOwnerId({
      ownerId: input.ownerId,
      runtimeSessionId: input.routing?.runtimeSessionId,
      contactId: input.contactId,
    });
    const routing =
      input.routing ??
      buildTransferRoutingContext({
        runtimeSessionId: ownerId,
        resolvedContactId: input.contactId,
        channel: normalizedChannel,
      });
    const ttl = input.ttl ?? this.getChannelTtl(normalizedChannel);
    const key = sessionKey(input.tenantId, ownerId, normalizedChannel);
    const indexKey = providerIndexKey(input.provider, input.tenantId, input.providerSessionId);
    const podKey = podSessionsKey(input.ownerPod);
    let encryptedMetadata: string;
    let encryptedProviderData: string;
    let encryptedVoiceData: string | undefined;
    let routingJson: string;
    let contextSnapshotJson: string | undefined;

    try {
      encryptedMetadata = await this.encryptIfAvailable(
        JSON.stringify(input.metadata ?? {}),
        input.tenantId,
      );
      encryptedProviderData = await this.encryptIfAvailable(
        JSON.stringify(input.providerData ?? {}),
        input.tenantId,
      );
      routingJson = JSON.stringify(routing);
      if (input.contextSnapshot) {
        contextSnapshotJson = JSON.stringify(input.contextSnapshot);
      }
      if (input.voiceData) {
        encryptedVoiceData = await this.encryptIfAvailable(
          JSON.stringify(input.voiceData),
          input.tenantId,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to encrypt transfer session fields', {
        tenantId: input.tenantId,
        contactId: input.contactId,
        channel: input.channel,
        error: message,
      });
      return {
        success: false,
        error: {
          code: 'ENCRYPTION_ERROR',
          message,
        },
      };
    }

    const fields: [string, string][] = [
      ['tenantId', input.tenantId],
      ['ownerId', ownerId],
      ['contactId', input.contactId],
      ['channel', normalizedChannel],
      ['provider', input.provider],
      ['providerSessionId', input.providerSessionId],
      ['state', 'pending'],
      ['metadata', encryptedMetadata],
      ['providerData', encryptedProviderData],
      ['routing', routingJson],
      ['ownerPod', input.ownerPod],
      ['lastHeartbeat', String(now)],
      ['createdAt', String(now)],
      ['updatedAt', String(now)],
      ['ttl', String(ttl)],
    ];

    // Optional routing/queue fields
    if (contextSnapshotJson) fields.push(['contextSnapshot', contextSnapshotJson]);
    if (input.agentId) fields.push(['agentId', input.agentId]);
    if (input.projectId) fields.push(['projectId', input.projectId]);
    if (input.queue) fields.push(['queue', input.queue]);
    if (input.skills) fields.push(['skills', JSON.stringify(input.skills)]);
    if (input.priority !== undefined) fields.push(['priority', String(input.priority)]);
    if (input.postAgentConfig)
      fields.push(['postAgentConfig', JSON.stringify(input.postAgentConfig)]);
    if (encryptedVoiceData) fields.push(['voiceData', encryptedVoiceData]);

    // Flatten field pairs for ARGV (TTL is ARGV[1])
    const argv: (string | number)[] = [ttl];
    for (const [field, value] of fields) {
      argv.push(field, value);
    }

    try {
      // Single-key Lua: writes the session hash atomically with the
      // not-exists guard. Cross-slot index writes (provider lookup,
      // active-sessions SET, per-pod SET) run in a pipeline below.
      const result = await withTimeout(
        runLuaScript<number>(this.redis, SCRIPT_CREATE_SESSION, [key], argv),
        REDIS_TIMEOUT_MS,
      );

      if (result === 0) {
        return {
          success: false,
          error: {
            code: 'SESSION_EXISTS',
            message: `Transfer session already exists for ${input.contactId} on ${input.channel}`,
          },
        };
      }

      // Cross-slot index writes. ioredis Cluster's `pipeline()` requires all
      // keys in the same slot — that's incompatible with our index design
      // where each index lives on its own slot. Issue commands individually
      // via Promise.allSettled so each auto-routes to its node, and tolerate
      // partial failure (the session hash already exists; every index has a
      // TTL ≤ session TTL).
      const indexWrites: Array<Promise<unknown>> = [];
      if (input.providerSessionId && input.providerSessionId.length > 0) {
        indexWrites.push(
          ttl > 0 ? this.redis.set(indexKey, key, 'EX', ttl) : this.redis.set(indexKey, key),
        );
      }
      indexWrites.push(this.redis.sadd(ACTIVE_SESSIONS_SET, key));
      indexWrites.push(this.redis.sadd(podKey, key));
      const settled = await withTimeout(Promise.allSettled(indexWrites), REDIS_TIMEOUT_MS);
      const failed = settled.filter((s) => s.status === 'rejected');
      if (failed.length > 0) {
        log.warn('Transfer session index write partial failure', {
          tenantId: input.tenantId,
          contactId: input.contactId,
          channel: input.channel,
          failedCount: failed.length,
          firstError:
            failed[0].status === 'rejected'
              ? failed[0].reason instanceof Error
                ? failed[0].reason.message
                : String(failed[0].reason)
              : undefined,
        });
      }

      return { success: true, sessionKey: key };
    } catch (err) {
      log.error('Failed to create transfer session', {
        tenantId: input.tenantId,
        contactId: input.contactId,
        channel: input.channel,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: {
          code: 'REDIS_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Get a transfer session by its key.
   */
  async get(key: string): Promise<TransferSessionData | null> {
    try {
      const hash = await withTimeout(this.redis.hgetall(key), REDIS_TIMEOUT_MS);
      if (!hash || Object.keys(hash).length === 0) {
        return null;
      }
      if (this.encryptor) {
        const tenantId = hash.tenantId ?? '';
        if (hash.metadata && this.encryptor.isEncrypted(hash.metadata)) {
          hash.metadata = await this.encryptor.decryptField(hash.metadata, tenantId);
        }
        if (hash.providerData && this.encryptor.isEncrypted(hash.providerData)) {
          hash.providerData = await this.encryptor.decryptField(hash.providerData, tenantId);
        }
        if (hash.voiceData && this.encryptor.isEncrypted(hash.voiceData)) {
          hash.voiceData = await this.encryptor.decryptField(hash.voiceData, tenantId);
        }
      }
      return this.parseSessionHash(hash);
    } catch (err) {
      log.error('Failed to get transfer session', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Get multiple transfer sessions by their keys in a single Redis pipeline.
   * Eliminates N+1 sequential GET calls by batching HGETALL commands.
   * Returns an array aligned with the input keys (null for missing/expired sessions).
   */
  async getMany(keys: string[]): Promise<(TransferSessionData | null)[]> {
    if (keys.length === 0) return [];

    try {
      // Each session hash lives on its own slot in cluster mode, so we issue
      // HGETALLs individually via Promise.allSettled (ioredis Cluster
      // pipelines require same-slot keys).
      const settled = await withTimeout(
        Promise.allSettled(keys.map((key) => this.redis.hgetall(key))),
        REDIS_TIMEOUT_MS,
      );

      const sessions: (TransferSessionData | null)[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'rejected') {
          sessions.push(null);
          continue;
        }
        const hash = r.value as Record<string, string>;
        if (!hash || Object.keys(hash).length === 0) {
          sessions.push(null);
          continue;
        }

        try {
          if (this.encryptor) {
            const tenantId = hash.tenantId ?? '';
            if (hash.metadata && this.encryptor.isEncrypted(hash.metadata)) {
              hash.metadata = await this.encryptor.decryptField(hash.metadata, tenantId);
            }
            if (hash.providerData && this.encryptor.isEncrypted(hash.providerData)) {
              hash.providerData = await this.encryptor.decryptField(hash.providerData, tenantId);
            }
            if (hash.voiceData && this.encryptor.isEncrypted(hash.voiceData)) {
              hash.voiceData = await this.encryptor.decryptField(hash.voiceData, tenantId);
            }
          }
          sessions.push(this.parseSessionHash(hash));
        } catch (decryptErr) {
          log.error('Failed to decrypt session in getMany', {
            key: keys[i],
            error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
          });
          sessions.push(null);
        }
      }

      return sessions;
    } catch (err) {
      log.error('Failed to get multiple transfer sessions', {
        keyCount: keys.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return keys.map(() => null);
    }
  }

  /**
   * Update specific fields on a session.
   */
  async update(key: string, fields: UpdateTransferSessionFields): Promise<boolean> {
    try {
      const updates: string[] = [];
      // Push field-value pairs as flat array for Lua ARGV
      updates.push('updatedAt', String(Date.now()));
      if (fields.state !== undefined) updates.push('state', fields.state);
      if (fields.metadata !== undefined) {
        const jsonMeta = JSON.stringify(fields.metadata);
        updates.push(
          'metadata',
          await this.encryptIfAvailable(jsonMeta, this.extractTenantIdFromKey(key)),
        );
      }
      if (fields.providerData !== undefined) {
        const jsonData = JSON.stringify(fields.providerData);
        updates.push(
          'providerData',
          await this.encryptIfAvailable(jsonData, this.extractTenantIdFromKey(key)),
        );
      }
      if (fields.routing !== undefined) {
        updates.push('routing', JSON.stringify(fields.routing));
      }
      if (fields.contextSnapshot !== undefined) {
        updates.push('contextSnapshot', JSON.stringify(fields.contextSnapshot));
      }
      if (fields.voiceData !== undefined) {
        const jsonVoiceData = JSON.stringify(fields.voiceData);
        updates.push(
          'voiceData',
          await this.encryptIfAvailable(jsonVoiceData, this.extractTenantIdFromKey(key)),
        );
      }
      if (fields.lastHeartbeat !== undefined)
        updates.push('lastHeartbeat', String(fields.lastHeartbeat));
      if (fields.ownerPod !== undefined) updates.push('ownerPod', fields.ownerPod);
      if (fields.agentId !== undefined) updates.push('agentId', fields.agentId);
      if (fields.projectId !== undefined) updates.push('projectId', fields.projectId);
      if (fields.queue !== undefined) updates.push('queue', fields.queue);
      if (fields.skills !== undefined) updates.push('skills', JSON.stringify(fields.skills));
      if (fields.priority !== undefined) updates.push('priority', String(fields.priority));
      if (fields.postAgentConfig !== undefined)
        updates.push('postAgentConfig', JSON.stringify(fields.postAgentConfig));
      if (fields.csatSurveyType !== undefined)
        updates.push('csatSurveyType', fields.csatSurveyType);
      if (fields.csatDialogId !== undefined) updates.push('csatDialogId', fields.csatDialogId);
      if (fields.csatStartedAt !== undefined)
        updates.push('csatStartedAt', String(fields.csatStartedAt));
      if (fields.csatCompletedAt !== undefined)
        updates.push('csatCompletedAt', String(fields.csatCompletedAt));
      if (fields.dispositionCode !== undefined)
        updates.push('dispositionCode', fields.dispositionCode);
      if (fields.wrapUpNotes !== undefined) updates.push('wrapUpNotes', fields.wrapUpNotes);
      if (fields.acwEnabled !== undefined) updates.push('acwEnabled', String(fields.acwEnabled));
      if (fields.acwTimedOut !== undefined) updates.push('acwTimedOut', String(fields.acwTimedOut));
      if (fields.acwCloseReason !== undefined)
        updates.push('acwCloseReason', fields.acwCloseReason);
      if (fields.acwEndedAt !== undefined) updates.push('acwEndedAt', String(fields.acwEndedAt));
      if (fields.acwCompletedEmitted !== undefined)
        updates.push('acwCompletedEmitted', String(fields.acwCompletedEmitted));
      if (fields.acwExpected !== undefined) updates.push('acwExpected', String(fields.acwExpected));

      // Atomic check-and-update via Lua script (prevents TOCTOU race)
      const result = await withTimeout(
        runLuaScript<number>(this.redis, SCRIPT_UPDATE_SESSION, [key], updates),
        REDIS_TIMEOUT_MS,
      );
      return result === 1;
    } catch (err) {
      log.error('Failed to update transfer session', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Atomically mark ACW completed and persist its final fields exactly once.
   */
  async completeAcwIfPending(
    key: string,
    fields: Omit<UpdateTransferSessionFields, 'acwCompletedEmitted' | 'acwEnabled'>,
  ): Promise<boolean> {
    try {
      const updates: string[] = [
        'updatedAt',
        String(Date.now()),
        'acwEnabled',
        'true',
        'acwCompletedEmitted',
        'true',
      ];

      if (fields.acwTimedOut !== undefined) updates.push('acwTimedOut', String(fields.acwTimedOut));
      if (fields.acwCloseReason !== undefined)
        updates.push('acwCloseReason', fields.acwCloseReason);
      if (fields.acwEndedAt !== undefined) updates.push('acwEndedAt', String(fields.acwEndedAt));
      if (fields.dispositionCode !== undefined)
        updates.push('dispositionCode', fields.dispositionCode);
      if (fields.wrapUpNotes !== undefined) updates.push('wrapUpNotes', fields.wrapUpNotes);

      const result = await withTimeout(
        runLuaScript<number>(this.redis, SCRIPT_COMPLETE_ACW_IF_PENDING, [key], updates),
        REDIS_TIMEOUT_MS,
      );
      return result === 1;
    } catch (err) {
      log.error('Failed to complete ACW for transfer session', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * End a transfer session atomically.
   * Cleans up the session hash, provider index, and set memberships.
   *
   * The Lua script reads provider/providerSessionId/ownerPod from the hash
   * INSIDE the script before deleting, eliminating the TOCTOU race where
   * the session could expire between a preceding get() and the delete.
   */
  async end(key: string): Promise<boolean> {
    const tenantId = this.extractTenantIdFromKey(key);

    // Read provider alias info BEFORE the Lua DEL so we can clean up the
    // alias key (Kore orgId → session) — the Lua script only knows the
    // session hash, not the alias index. This HMGET races a concurrent
    // expiry; that's tolerated because failure means the alias key already
    // self-cleaned via TTL.
    let aliasKeyToDelete: string | undefined;
    try {
      const fields = await withTimeout(
        this.redis.hmget(key, 'provider', 'providerSessionId', 'providerData'),
        REDIS_TIMEOUT_MS,
      );
      const [provider, providerSessionId, providerDataRaw] = fields;
      if (provider && providerSessionId && providerDataRaw) {
        let pd: Record<string, unknown> = {};
        if (this.encryptor && this.encryptor.isEncrypted(providerDataRaw)) {
          const decrypted = await this.encryptor.decryptField(providerDataRaw, tenantId);
          pd = this.safeJsonParse(decrypted, {});
        } else {
          pd = this.safeJsonParse(providerDataRaw, {});
        }
        const koreOrgId = pd.orgId as string | undefined;
        if (koreOrgId && koreOrgId !== tenantId) {
          aliasKeyToDelete = providerIndexKey(provider, koreOrgId, providerSessionId);
        }
      }
    } catch (aliasErr) {
      log.warn('Failed to read provider alias info before session end', {
        key,
        error: aliasErr instanceof Error ? aliasErr.message : String(aliasErr),
      });
    }

    try {
      // Single-key Lua: atomically reads provider/providerSessionId/ownerPod
      // from the session hash, deletes the hash, returns the trio so the
      // caller can clean up the cross-slot indexes via pipeline().
      // Empty array = session was already gone.
      const result = await withTimeout(
        runLuaScript<string[] | null>(this.redis, SCRIPT_END_SESSION, [key], []),
        REDIS_TIMEOUT_MS,
      );

      if (!result || result.length === 0) {
        return false;
      }

      const [provider, providerSessionId, ownerPod] = result;

      // Cross-slot cleanup. Each command lives on its own slot in cluster
      // mode, so issue them individually via Promise.allSettled (ioredis
      // Cluster pipelines require same-slot keys). Partial failure is
      // tolerated — TTL self-cleans orphan entries.
      const cleanupOps: Array<Promise<unknown>> = [];
      if (provider && providerSessionId && tenantId) {
        cleanupOps.push(this.redis.del(providerIndexKey(provider, tenantId, providerSessionId)));
      }
      cleanupOps.push(this.redis.srem(ACTIVE_SESSIONS_SET, key));
      if (ownerPod) {
        cleanupOps.push(this.redis.srem(podSessionsKey(ownerPod), key));
      }
      if (aliasKeyToDelete) {
        cleanupOps.push(this.redis.del(aliasKeyToDelete));
      }
      await withTimeout(Promise.allSettled(cleanupOps), REDIS_TIMEOUT_MS);

      return true;
    } catch (err) {
      log.error('Failed to end transfer session', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Extend the TTL of a session atomically.
   * Called on every agent/user message to keep the session alive.
   *
   * Uses a Lua script to atomically check existence, extend TTL, and
   * update timestamps. If the session has expired between the caller's
   * intent and this call, returns false instead of creating ghost records.
   */
  async extendTTL(key: string, ttl?: number, channel?: string): Promise<boolean> {
    let resolvedChannel: string;
    let provider: string | undefined;
    let tenantId: string | undefined;
    let providerSessionId: string | undefined;

    if (channel) {
      // Channel hint provided: use targeted HMGET instead of full HGETALL
      resolvedChannel = channel;
      const fields = await withTimeout(
        this.redis.hmget(key, 'provider', 'tenantId', 'providerSessionId'),
        REDIS_TIMEOUT_MS,
      );
      if (!fields[0]) return false; // Session doesn't exist
      provider = fields[0];
      tenantId = fields[1] ?? '';
      providerSessionId = fields[2] ?? '';
    } else {
      const session = await this.get(key);
      if (!session) return false;
      resolvedChannel = session.channel;
      provider = session.provider;
      tenantId = session.tenantId;
      providerSessionId = session.providerSessionId;
    }

    const effectiveTtl = ttl ?? this.getChannelTtl(resolvedChannel);
    if (effectiveTtl <= 0) return true; // Voice: no timeout

    const indexKey =
      provider && tenantId && providerSessionId
        ? providerIndexKey(provider, tenantId, providerSessionId)
        : '';
    const now = String(Date.now());

    try {
      // Single-key Lua: EXPIRE + HMSET on the session hash atomically.
      // Provider-index TTL extension is a separate cross-slot operation
      // below — best-effort, partial failure tolerated.
      const result = await withTimeout(
        runLuaScript<number>(this.redis, SCRIPT_EXTEND_TTL, [key], [effectiveTtl, now, now]),
        REDIS_TIMEOUT_MS,
      );

      if (result === 1 && indexKey) {
        // Fire-and-forget — the index has its own TTL and will self-clean
        // if this fails.
        this.redis.expire(indexKey, effectiveTtl).catch((expireErr) => {
          log.warn('Failed to extend provider index TTL', {
            indexKey,
            error: expireErr instanceof Error ? expireErr.message : String(expireErr),
          });
        });
      }

      // Also extend TTL on provider alias key (Kore orgId → session) if it exists.
      // This is best-effort — the alias is a convenience index, not the primary key.
      if (result === 1 && provider && providerSessionId) {
        this.extendAliasKeyTtl(key, provider, tenantId ?? '', providerSessionId, effectiveTtl);
      }

      return result === 1;
    } catch (err) {
      log.error('Failed to extend TTL', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Best-effort TTL extension for the provider alias key.
   * Reads providerData from the session to find the Kore orgId,
   * then extends the alias key's TTL. Fire-and-forget to avoid
   * blocking the main extendTTL path.
   */
  private extendAliasKeyTtl(
    sessionKey: string,
    provider: string,
    tenantId: string,
    providerSessionId: string,
    ttlSeconds: number,
  ): void {
    this.redis
      .hget(sessionKey, 'providerData')
      .then(async (raw) => {
        if (!raw) return;
        let pd: Record<string, unknown> = {};
        if (this.encryptor && this.encryptor.isEncrypted(raw)) {
          const decrypted = await this.encryptor.decryptField(raw, tenantId);
          pd = this.safeJsonParse(decrypted, {});
        } else {
          pd = this.safeJsonParse(raw, {});
        }
        const koreOrgId = pd.orgId as string | undefined;
        if (koreOrgId && koreOrgId !== tenantId) {
          const aliasKey = providerIndexKey(provider, koreOrgId, providerSessionId);
          await this.redis.expire(aliasKey, ttlSeconds);
        }
      })
      .catch(() => {
        // Best-effort — alias TTL extension failure is not critical
      });
  }

  /**
   * Look up a session by its provider-specific session ID.
   * Uses the reverse index to find the session key, then loads the session.
   * Requires tenantId to ensure tenant isolation.
   */
  async getByProvider(
    provider: string,
    tenantId: string,
    providerSessionId: string,
  ): Promise<TransferSessionData | null> {
    const indexKey = providerIndexKey(provider, tenantId, providerSessionId);
    try {
      const key = await withTimeout(this.redis.get(indexKey), REDIS_TIMEOUT_MS);
      if (!key) return null;
      return this.get(key);
    } catch (err) {
      log.error('Failed to get session by provider', {
        provider,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Create an additional provider index alias so a session can be found
   * via an alternative tenantId (e.g. the external provider's orgId instead
   * of the ABL tenantId). The alias key has the same TTL as the session
   * so it auto-expires even if `end()` only cleans up the primary index.
   */
  async addProviderAlias(
    provider: string,
    aliasTenantId: string,
    providerSessionId: string,
    key: string,
    ttl?: number,
  ): Promise<void> {
    if (!providerSessionId) return;
    const aliasKey = providerIndexKey(provider, aliasTenantId, providerSessionId);
    try {
      const effectiveTtl = ttl ?? (await this.getSessionTtl(key));
      if (effectiveTtl > 0) {
        await withTimeout(this.redis.set(aliasKey, key, 'EX', effectiveTtl), REDIS_TIMEOUT_MS);
      } else {
        await withTimeout(this.redis.set(aliasKey, key), REDIS_TIMEOUT_MS);
      }
    } catch (err) {
      log.error('Failed to create provider alias index', {
        aliasKey,
        sessionKey: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get the TTL of an existing session key from Redis (in seconds).
   * Returns -1 if no expiry, -2 if key doesn't exist, or the TTL value.
   */
  private async getSessionTtl(key: string): Promise<number> {
    try {
      const ttl = await this.redis.ttl(key);
      return ttl > 0 ? ttl : 0;
    } catch {
      return 1800; // Default to 30 min
    }
  }

  /**
   * Get active session keys, optionally scoped to a tenant.
   * When tenantId is provided, uses SSCAN with MATCH to filter by tenant prefix.
   * When tenantId is omitted, returns all active sessions.
   */
  async getActiveSessions(tenantId?: string): Promise<string[]> {
    if (!tenantId) {
      return this.redis.smembers(ACTIVE_SESSIONS_SET);
    }

    const matchPattern = `agent_transfer:${tenantId}:*`;
    const results: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.sscan(
        ACTIVE_SESSIONS_SET,
        cursor,
        'MATCH',
        matchPattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      results.push(...keys);
    } while (cursor !== '0');

    return results;
  }

  /**
   * Get active session keys with cursor-based pagination.
   * Returns a page of keys and the cursor for the next page.
   * When nextCursor is '0', there are no more results.
   */
  async getActiveSessionsPaginated(
    tenantId: string,
    opts: { cursor?: string; count?: number } = {},
  ): Promise<{ keys: string[]; nextCursor: string }> {
    const { cursor = '0', count = 50 } = opts;
    const matchPattern = `agent_transfer:${tenantId}:*`;

    try {
      const [nextCursor, keys] = await withTimeout(
        this.redis.sscan(ACTIVE_SESSIONS_SET, cursor, 'MATCH', matchPattern, 'COUNT', count),
        REDIS_TIMEOUT_MS,
      );
      return { keys, nextCursor };
    } catch (err) {
      log.error('Failed to scan active sessions', {
        tenantId,
        cursor,
        error: err instanceof Error ? err.message : String(err),
      });
      return { keys: [], nextCursor: '0' };
    }
  }

  /**
   * Get session keys owned by a specific pod.
   */
  async getSessionsByPod(hostname: string): Promise<string[]> {
    return this.redis.smembers(podSessionsKey(hostname));
  }

  /**
   * Atomically claim an orphaned session via CAS on ownerPod.
   * Used during pod-crash recovery to prevent race conditions.
   */
  async claimOrphanedSession(
    key: string,
    oldHostname: string,
    newHostname: string,
  ): Promise<ClaimSessionResult> {
    const oldPodKey = podSessionsKey(oldHostname);
    const newPodKey = podSessionsKey(newHostname);
    const now = String(Date.now());

    try {
      // Single-key Lua: CAS on ownerPod + HSET ownerPod/timestamps on the
      // session hash. Pod-set membership swaps are pipelined below — they
      // sit on different slots in cluster mode and are best-effort.
      const result = await withTimeout(
        runLuaScript<number>(
          this.redis,
          SCRIPT_CLAIM_SESSION,
          [key],
          [oldHostname, newHostname, now],
        ),
        REDIS_TIMEOUT_MS,
      );

      if (result === 0) {
        return { success: false };
      }

      // Cross-slot pod-set swap: oldPodKey and newPodKey are different keys
      // and live on different slots in cluster mode. Issue individually.
      await withTimeout(
        Promise.allSettled([this.redis.srem(oldPodKey, key), this.redis.sadd(newPodKey, key)]),
        REDIS_TIMEOUT_MS,
      );

      const session = await this.get(key);
      return { success: true, session: session ?? undefined };
    } catch (err) {
      log.error('Failed to claim orphaned session', {
        key,
        oldHostname,
        newHostname,
        error: err instanceof Error ? err.message : String(err),
      });
      return { success: false };
    }
  }

  /**
   * Get the default TTL for a channel type.
   */
  private getChannelTtl(channel: string): number {
    return CHANNEL_TTL_DEFAULTS[channel] ?? CHANNEL_TTL_DEFAULTS.default;
  }

  /**
   * Parse a Redis hash into a TransferSessionData object.
   */
  private parseSessionHash(hash: Record<string, string>): TransferSessionData {
    const routing = hash.routing
      ? this.safeJsonParse(hash.routing, undefined as TransferSessionData['routing'])
      : undefined;
    const ownerId = hash.ownerId || routing?.runtimeSessionId || hash.contactId || '';
    const voiceData = hash.voiceData
      ? this.safeJsonParse(hash.voiceData, undefined as TransferSessionData['voiceData'])
      : undefined;

    const data: TransferSessionData = {
      tenantId: hash.tenantId ?? '',
      ownerId,
      contactId: hash.contactId ?? '',
      channel: hash.channel ?? '',
      provider: hash.provider ?? '',
      providerSessionId: hash.providerSessionId ?? '',
      state: (hash.state as TransferSessionData['state']) ?? 'pending',
      metadata: this.safeJsonParse(hash.metadata, {}),
      providerData: this.safeJsonParse(hash.providerData, {}),
      ownerPod: hash.ownerPod ?? '',
      lastHeartbeat: parseInt(hash.lastHeartbeat || '0', 10),
      createdAt: parseInt(hash.createdAt || '0', 10),
      updatedAt: parseInt(hash.updatedAt || '0', 10),
      ttl: parseInt(hash.ttl || '0', 10),
    };

    data.routing =
      routing ??
      buildTransferRoutingContext({
        runtimeSessionId: ownerId,
        resolvedContactId: hash.contactId ?? undefined,
        channel: hash.channel,
        voice: voiceData
          ? {
              callSid: voiceData.callSid,
              sipCallId: voiceData.sipCallId,
            }
          : undefined,
      });

    if (hash.contextSnapshot) {
      data.contextSnapshot = this.safeJsonParse(
        hash.contextSnapshot,
        undefined as TransferSessionData['contextSnapshot'],
      );
    }

    // Optional routing/queue fields
    if (hash.agentId) data.agentId = hash.agentId;
    if (hash.projectId) data.projectId = hash.projectId;
    if (hash.queue) data.queue = hash.queue;
    if (hash.skills) data.skills = this.safeJsonParse<string[]>(hash.skills, []);
    if (hash.priority) data.priority = parseInt(hash.priority, 10);

    // Post-agent and CSAT fields
    if (hash.postAgentConfig)
      data.postAgentConfig = this.safeJsonParse(hash.postAgentConfig, { action: 'end' });
    if (hash.csatSurveyType) data.csatSurveyType = hash.csatSurveyType;
    if (hash.csatDialogId) data.csatDialogId = hash.csatDialogId;
    if (hash.csatStartedAt) data.csatStartedAt = parseInt(hash.csatStartedAt, 10);
    if (hash.csatCompletedAt) data.csatCompletedAt = parseInt(hash.csatCompletedAt, 10);

    // Disposition fields
    if (hash.dispositionCode) data.dispositionCode = hash.dispositionCode;
    if (hash.wrapUpNotes) data.wrapUpNotes = hash.wrapUpNotes;
    if (voiceData) data.voiceData = voiceData;

    // ACW fields
    if (hash.acwEnabled) data.acwEnabled = hash.acwEnabled === 'true';
    if (hash.acwTimedOut) data.acwTimedOut = hash.acwTimedOut === 'true';
    if (hash.acwCloseReason)
      data.acwCloseReason = hash.acwCloseReason as 'timeout' | 'agent_closed';
    if (hash.acwEndedAt) data.acwEndedAt = parseInt(hash.acwEndedAt, 10);
    if (hash.acwCompletedEmitted) data.acwCompletedEmitted = hash.acwCompletedEmitted === 'true';
    if (hash.acwExpected) data.acwExpected = hash.acwExpected === 'true';

    return data;
  }

  private async encryptIfAvailable(plaintext: string, tenantId: string): Promise<string> {
    if (!this.encryptor) return plaintext;
    return this.encryptor.encryptField(plaintext, tenantId);
  }

  private extractTenantIdFromKey(key: string): string {
    // Key format: agent_transfer:{tenantId}:{ownerId}:{channel}
    const parts = key.split(':');
    return parts[1] ?? '';
  }

  private safeJsonParse<T>(raw: string | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}
