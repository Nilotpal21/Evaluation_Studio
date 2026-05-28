import type {
  OAuthTokenRecord,
  OAuthTokenStore,
  SessionOAuthArtifactRecord,
  SessionOAuthArtifactStore,
} from './tool-oauth-service.js';

interface MongoOAuthTokenRecord {
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  scope?: string;
  expiresAt?: Date | null;
  sessionExpiresAt?: Date | null;
  sessionId?: string | null;
  // Legacy storage field; higher-level contracts expose `sessionId`.
  runtimeSessionId?: string | null;
  channelId?: string | null;
  authProfileId?: string | null;
  authProfileRef?: string | null;
  // EndUserOAuthToken also has a domain `_v` field, but Mongoose optimistic concurrency
  // still uses the schema `versionKey` (`__v`).
  __v?: number;
}

interface UpsertableTokenData {
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  scope: string;
  expiresAt?: Date | null;
}

const LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD = 'runtimeSessionId' as const;

type SessionArtifactWriteFields = {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope?: string;
  expiresAt: Date | null;
  sessionExpiresAt: Date;
  channelId: string | null;
  authProfileId: string | null;
  authProfileRef: string | null;
  refreshedAt: Date;
  consentedAt: Date;
} & Record<typeof LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD, string>;

function resolveSessionOAuthArtifactSessionId(record: MongoOAuthTokenRecord): string | null {
  if (typeof record.sessionId === 'string' && record.sessionId.length > 0) {
    return record.sessionId;
  }

  const legacySessionId = record[LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD];
  if (typeof legacySessionId === 'string' && legacySessionId.length > 0) {
    return legacySessionId;
  }

  return null;
}

function buildTokenWriteFields(
  token: UpsertableTokenData,
  userId: string,
  now: Date,
): {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope?: string;
  expiresAt: Date | null;
  refreshedAt: Date;
  revokedAt: null;
  providerUserId: string;
  consentedAt: Date;
} {
  return {
    encryptedAccessToken: token.encryptedAccessToken,
    encryptedRefreshToken: token.encryptedRefreshToken ?? null,
    scope: token.scope || undefined,
    expiresAt: token.expiresAt ?? null,
    refreshedAt: now,
    revokedAt: null,
    // ToolOAuthService does not currently resolve provider-subject metadata. Fall back to the
    // authenticated platform user id so token creation cannot violate the schema contract.
    providerUserId: userId,
    consentedAt: now,
  };
}

function buildSessionArtifactWriteFields(
  token: UpsertableTokenData & {
    sessionId: string;
    sessionExpiresAt: Date;
    channelId?: string;
    authProfileId?: string;
    authProfileRef?: string;
  },
  now: Date,
): SessionArtifactWriteFields {
  return {
    encryptedAccessToken: token.encryptedAccessToken,
    encryptedRefreshToken: token.encryptedRefreshToken ?? null,
    scope: token.scope || undefined,
    expiresAt: token.expiresAt ?? null,
    [LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD]: token.sessionId,
    sessionExpiresAt: token.sessionExpiresAt,
    channelId: token.channelId ?? null,
    authProfileId: token.authProfileId ?? null,
    authProfileRef: token.authProfileRef ?? null,
    refreshedAt: now,
    consentedAt: now,
  };
}

function toOAuthTokenRecord(record: MongoOAuthTokenRecord): OAuthTokenRecord {
  return {
    encryptedAccessToken: record.encryptedAccessToken,
    encryptedRefreshToken: record.encryptedRefreshToken ?? null,
    scope: typeof record.scope === 'string' ? record.scope : '',
    expiresAt: record.expiresAt ?? null,
    ...(typeof record.__v === 'number' ? { version: record.__v } : {}),
  };
}

function toSessionOAuthArtifactRecord(
  record: MongoOAuthTokenRecord,
): SessionOAuthArtifactRecord | null {
  const sessionId = resolveSessionOAuthArtifactSessionId(record);

  if (!(record.sessionExpiresAt instanceof Date) || !sessionId) {
    return null;
  }

  return {
    encryptedAccessToken: record.encryptedAccessToken,
    encryptedRefreshToken: record.encryptedRefreshToken ?? null,
    scope: typeof record.scope === 'string' ? record.scope : '',
    expiresAt: record.expiresAt ?? null,
    sessionId,
    ...(record.channelId !== undefined ? { channelId: record.channelId } : {}),
    ...(record.authProfileId !== undefined ? { authProfileId: record.authProfileId } : {}),
    ...(record.authProfileRef !== undefined ? { authProfileRef: record.authProfileRef } : {}),
    sessionExpiresAt: record.sessionExpiresAt,
    ...(typeof record.__v === 'number' ? { version: record.__v } : {}),
  };
}

export async function buildMongoOAuthTokenStore(): Promise<OAuthTokenStore> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');

  return {
    async findToken(tenantId, userId, provider) {
      const record = (await EndUserOAuthToken.findOne(
        { tenantId, userId, provider, revokedAt: null },
        {
          encryptedAccessToken: 1,
          encryptedRefreshToken: 1,
          scope: 1,
          expiresAt: 1,
          revokedAt: 1,
          __v: 1,
        },
      ).lean()) as MongoOAuthTokenRecord | null;
      if (!record) {
        return null;
      }

      return toOAuthTokenRecord(record);
    },

    async upsertToken(params) {
      const now = new Date();
      // Use findOne + save/create so the encryption plugin's pre-save hook fires.
      const existing = await EndUserOAuthToken.findOne({
        tenantId: params.tenantId,
        userId: params.userId,
        provider: params.provider,
      });
      if (existing) {
        const nextFields = buildTokenWriteFields(params, params.userId, now);
        existing.set('encryptedAccessToken', nextFields.encryptedAccessToken);
        existing.set('encryptedRefreshToken', nextFields.encryptedRefreshToken);
        if (nextFields.scope) {
          existing.set('scope', nextFields.scope);
        }
        existing.set('expiresAt', nextFields.expiresAt);
        existing.set('refreshedAt', nextFields.refreshedAt);
        existing.set('revokedAt', null);
        if (!existing.get('providerUserId')) {
          existing.set('providerUserId', nextFields.providerUserId);
        }
        if (!existing.get('consentedAt')) {
          existing.set('consentedAt', nextFields.consentedAt);
        }
        await existing.save();
        return;
      }

      const nextFields = buildTokenWriteFields(params, params.userId, now);
      await EndUserOAuthToken.create({
        tenantId: params.tenantId,
        userId: params.userId,
        provider: params.provider,
        ...nextFields,
      });
    },

    async compareAndSwapToken(params) {
      const now = new Date();
      if (params.expectedVersion == null) {
        if (params.next.kind === 'revoke') {
          return false;
        }

        const reactivated = await EndUserOAuthToken.updateOne(
          {
            tenantId: params.tenantId,
            userId: params.userId,
            provider: params.provider,
            revokedAt: { $ne: null },
          },
          {
            $set: buildTokenWriteFields(params.next.token, params.userId, now),
            $inc: { __v: 1 },
          },
        );
        if (reactivated.modifiedCount === 1) {
          return true;
        }

        try {
          const nextFields = buildTokenWriteFields(params.next.token, params.userId, now);
          await EndUserOAuthToken.create({
            tenantId: params.tenantId,
            userId: params.userId,
            provider: params.provider,
            ...nextFields,
          });
          return true;
        } catch (err) {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? (err as { code?: unknown }).code
              : undefined;
          if (code === 11000) {
            return false;
          }
          throw err;
        }
      }

      if (params.next.kind === 'upsert') {
        const result = await EndUserOAuthToken.updateOne(
          {
            tenantId: params.tenantId,
            userId: params.userId,
            provider: params.provider,
            revokedAt: null,
            __v: params.expectedVersion,
          },
          {
            $set: buildTokenWriteFields(params.next.token, params.userId, now),
            $inc: { __v: 1 },
          },
        );
        return result.modifiedCount === 1;
      }

      const result = await EndUserOAuthToken.updateOne(
        {
          tenantId: params.tenantId,
          userId: params.userId,
          provider: params.provider,
          revokedAt: null,
          __v: params.expectedVersion,
        },
        {
          $set: { revokedAt: now },
          $inc: { __v: 1 },
        },
      );
      return result.modifiedCount === 1;
    },

    async markRevoked(tenantId, userId, provider) {
      await EndUserOAuthToken.updateOne(
        { tenantId, userId, provider },
        { $set: { revokedAt: new Date() } },
      );
    },

    async updateLastUsed(tenantId, userId, provider) {
      await EndUserOAuthToken.updateOne(
        { tenantId, userId, provider },
        { $set: { lastUsedAt: new Date() } },
      );
    },
  };
}

export async function buildMongoSessionOAuthArtifactStore(): Promise<SessionOAuthArtifactStore> {
  const { SessionOAuthArtifact } = await import('@agent-platform/database/models');

  return {
    async findToken(params) {
      const record = (await SessionOAuthArtifact.findOne(
        {
          tenantId: params.tenantId,
          projectId: params.projectId,
          sessionPrincipal: params.sessionPrincipal,
          provider: params.provider,
        },
        {
          encryptedAccessToken: 1,
          encryptedRefreshToken: 1,
          scope: 1,
          expiresAt: 1,
          sessionExpiresAt: 1,
          sessionId: 1,
          [LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD]: 1,
          channelId: 1,
          authProfileId: 1,
          authProfileRef: 1,
          __v: 1,
        },
      ).lean()) as MongoOAuthTokenRecord | null;
      if (!record) {
        return null;
      }

      return toSessionOAuthArtifactRecord(record);
    },

    async upsertToken(params) {
      const now = new Date();
      const existing = await SessionOAuthArtifact.findOne({
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionPrincipal: params.sessionPrincipal,
        provider: params.provider,
      });
      if (existing) {
        const nextFields = buildSessionArtifactWriteFields(params, now);
        existing.set('encryptedAccessToken', nextFields.encryptedAccessToken);
        existing.set('encryptedRefreshToken', nextFields.encryptedRefreshToken);
        if (nextFields.scope) {
          existing.set('scope', nextFields.scope);
        }
        existing.set('expiresAt', nextFields.expiresAt);
        existing.set(
          LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD,
          nextFields[LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD],
        );
        existing.set('sessionExpiresAt', nextFields.sessionExpiresAt);
        existing.set('channelId', nextFields.channelId);
        existing.set('authProfileId', nextFields.authProfileId);
        existing.set('authProfileRef', nextFields.authProfileRef);
        existing.set('refreshedAt', nextFields.refreshedAt);
        if (!existing.get('consentedAt')) {
          existing.set('consentedAt', nextFields.consentedAt);
        }
        await existing.save();
        return;
      }

      const nextFields = buildSessionArtifactWriteFields(params, now);
      await SessionOAuthArtifact.create({
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionPrincipal: params.sessionPrincipal,
        provider: params.provider,
        ...nextFields,
      });
    },

    async compareAndSwapToken(params) {
      const now = new Date();
      const filter = {
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionPrincipal: params.sessionPrincipal,
        provider: params.provider,
      };

      if (params.expectedVersion == null) {
        if (params.next.kind === 'revoke') {
          return false;
        }

        try {
          const nextFields = buildSessionArtifactWriteFields(
            {
              ...params.next.token,
              sessionId: params.sessionId,
              sessionExpiresAt: params.sessionExpiresAt,
              channelId: params.channelId,
              authProfileId: params.authProfileId,
              authProfileRef: params.authProfileRef,
            },
            now,
          );
          await SessionOAuthArtifact.create({
            ...filter,
            ...nextFields,
          });
          return true;
        } catch (err) {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? (err as { code?: unknown }).code
              : undefined;
          if (code === 11000) {
            return false;
          }
          throw err;
        }
      }

      if (params.next.kind === 'upsert') {
        const result = await SessionOAuthArtifact.updateOne(
          {
            ...filter,
            __v: params.expectedVersion,
          },
          {
            $set: buildSessionArtifactWriteFields(
              {
                ...params.next.token,
                sessionId: params.sessionId,
                sessionExpiresAt: params.sessionExpiresAt,
                channelId: params.channelId,
                authProfileId: params.authProfileId,
                authProfileRef: params.authProfileRef,
              },
              now,
            ),
            $inc: { __v: 1 },
          },
        );
        return result.modifiedCount === 1;
      }

      const result = await SessionOAuthArtifact.deleteOne({
        ...filter,
        __v: params.expectedVersion,
      });
      return result.deletedCount === 1;
    },

    async deleteBySessionId(sessionId) {
      const result = await SessionOAuthArtifact.deleteMany({
        $or: [{ sessionId }, { [LEGACY_SESSION_OAUTH_ARTIFACT_SESSION_ID_FIELD]: sessionId }],
      });
      return result.deletedCount ?? 0;
    },

    async updateLastUsed(params) {
      await SessionOAuthArtifact.updateOne(
        {
          tenantId: params.tenantId,
          projectId: params.projectId,
          sessionPrincipal: params.sessionPrincipal,
          provider: params.provider,
        },
        {
          $set: { lastUsedAt: new Date() },
        },
      );
    },
  };
}
