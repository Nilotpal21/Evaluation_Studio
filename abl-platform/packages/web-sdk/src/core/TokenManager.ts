/**
 * TokenManager - bootstrap and refresh short-lived SDK session tokens.
 */

import type { SDKConfig, SDKSessionScope } from './types.js';
import { normalizeHttpEndpoint } from './endpoint.js';
import { validateSdkUserContext } from './sdk-user-context-validation.js';

interface SDKTokenResponse {
  token: string;
  expiresIn: number;
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  channelId: string;
  permissions: string[];
  showActivityUpdates: boolean;
}

const REFRESH_LEEWAY_MS = 60_000;

class TokenRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TokenRequestError';
    this.status = status;
  }
}

class TokenResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenResponseValidationError';
  }
}

export class TokenManager {
  readonly #config: SDKConfig;
  readonly #httpEndpoint: string;
  #token: string | null = null;
  #expiresAtMs: number | null = null;
  #scope: SDKSessionScope | null = null;
  #inflight: Promise<string> | null = null;

  constructor(config: SDKConfig) {
    this.#config = config;
    this.#httpEndpoint = normalizeHttpEndpoint(config.endpoint);
  }

  async getToken(): Promise<string> {
    if (this.#inflight) {
      return this.#inflight;
    }

    if (this.#token && !this.shouldRefresh()) {
      return this.#token;
    }

    this.#inflight = this.refreshOrInit().finally(() => {
      this.#inflight = null;
    });

    return this.#inflight;
  }

  getScope(): SDKSessionScope | null {
    if (!this.#scope) {
      return null;
    }

    return {
      ...this.#scope,
      permissions: [...this.#scope.permissions],
    };
  }

  invalidateToken(): void {
    this.clearToken();
  }

  private async refreshOrInit(): Promise<string> {
    if (!this.#token) {
      return this.initToken();
    }

    const currentToken = this.#token;

    try {
      return await this.refreshToken(currentToken);
    } catch (error) {
      if (error instanceof TokenResponseValidationError) {
        this.clearToken();
        throw error;
      }

      if (!this.isExpired() && !this.isUnauthorizedError(error)) {
        return currentToken;
      }

      this.clearToken();
      return this.initToken();
    }
  }

  private async initToken(): Promise<string> {
    const body: Record<string, unknown> = {};

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if ('bootstrapToken' in this.#config) {
      body.bootstrapToken = this.#config.bootstrapToken;
    } else {
      if (this.#config.channelId) {
        body.channelId = this.#config.channelId;
      } else if (this.#config.channelName) {
        body.channelName = this.#config.channelName;
      }
      if (this.#config.deploymentSlug) {
        body.deploymentSlug = this.#config.deploymentSlug;
      }
      if (this.#config.userContext) {
        validateSdkUserContext(this.#config.userContext);
        body.userContext = this.#config.userContext;
      }
      headers['X-Public-Key'] = this.#config.apiKey;
    }

    const response = await fetch(`${this.#httpEndpoint}/api/v1/sdk/init`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    return this.storeResponse(response, 'SDK init failed');
  }

  private async refreshToken(currentToken: string): Promise<string> {
    const response = await fetch(`${this.#httpEndpoint}/api/v1/sdk/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Token': currentToken,
      },
      body: '{}',
    });

    return this.storeResponse(response, 'SDK token refresh failed');
  }

  private async storeResponse(response: Response, fallbackMessage: string): Promise<string> {
    if (!response.ok) {
      const message = await response.text().catch(() => fallbackMessage);
      throw new TokenRequestError(response.status, message || fallbackMessage);
    }

    const payload = this.parseTokenResponse(await response.json(), fallbackMessage);
    this.#token = payload.token;
    this.#expiresAtMs = Date.now() + payload.expiresIn * 1000;
    this.#scope = this.resolveScope(payload);
    return payload.token;
  }

  private parseTokenResponse(payload: unknown, fallbackMessage: string): SDKTokenResponse {
    if (typeof payload !== 'object' || payload === null) {
      throw new TokenResponseValidationError(`${fallbackMessage}: invalid JSON payload.`);
    }

    const response = payload as Record<string, unknown>;
    const token = typeof response.token === 'string' ? response.token.trim() : '';
    if (!token) {
      throw new TokenResponseValidationError(
        `${fallbackMessage}: missing token in SDK session response.`,
      );
    }

    const expiresIn = response.expiresIn;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new TokenResponseValidationError(
        `${fallbackMessage}: invalid expiresIn in SDK session response.`,
      );
    }

    const tenantId = typeof response.tenantId === 'string' ? response.tenantId.trim() : '';
    const projectId = typeof response.projectId === 'string' ? response.projectId.trim() : '';
    const channelId = typeof response.channelId === 'string' ? response.channelId.trim() : '';
    if (!tenantId || !projectId || !channelId) {
      throw new TokenResponseValidationError(
        `${fallbackMessage}: Runtime must return tenantId, projectId, and channelId.`,
      );
    }

    const permissions = Array.isArray(response.permissions)
      ? response.permissions.filter(
          (permission): permission is string =>
            typeof permission === 'string' && permission.length > 0,
        )
      : [];
    if (permissions.length === 0) {
      throw new TokenResponseValidationError(
        `${fallbackMessage}: Runtime must return a non-empty permissions array.`,
      );
    }

    const showActivityUpdates = response.showActivityUpdates;
    if (typeof showActivityUpdates !== 'boolean') {
      throw new TokenResponseValidationError(
        `${fallbackMessage}: Runtime must return showActivityUpdates.`,
      );
    }

    return {
      token,
      expiresIn,
      tenantId,
      projectId,
      deploymentId:
        typeof response.deploymentId === 'string' && response.deploymentId.trim().length > 0
          ? response.deploymentId.trim()
          : undefined,
      channelId,
      permissions,
      showActivityUpdates,
    };
  }

  private resolveScope(payload: SDKTokenResponse): SDKSessionScope {
    const nextScope: SDKSessionScope = {
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      channelId: payload.channelId,
      deploymentId: payload.deploymentId,
      permissions: [...payload.permissions],
      showActivityUpdates: payload.showActivityUpdates,
    };

    if (nextScope.projectId !== this.#config.projectId) {
      throw new TokenResponseValidationError(
        'Runtime returned an SDK session for a different project than the SDK config.',
      );
    }

    if (this.#scope) {
      const permissionsMatch =
        this.#scope.permissions.length === nextScope.permissions.length &&
        this.#scope.permissions.every(
          (permission, index) => permission === nextScope.permissions[index],
        );

      if (
        this.#scope.tenantId !== nextScope.tenantId ||
        this.#scope.projectId !== nextScope.projectId ||
        this.#scope.channelId !== nextScope.channelId ||
        this.#scope.deploymentId !== nextScope.deploymentId ||
        this.#scope.showActivityUpdates !== nextScope.showActivityUpdates ||
        !permissionsMatch
      ) {
        throw new TokenResponseValidationError(
          'Runtime changed SDK session scope during refresh. Re-initialize the SDK session.',
        );
      }
    }

    return nextScope;
  }

  private shouldRefresh(): boolean {
    if (!this.#token || this.#expiresAtMs == null) {
      return true;
    }

    return this.#expiresAtMs - Date.now() <= REFRESH_LEEWAY_MS;
  }

  private isExpired(): boolean {
    return this.#expiresAtMs != null && this.#expiresAtMs <= Date.now();
  }

  private isUnauthorizedError(error: unknown): boolean {
    return error instanceof TokenRequestError && (error.status === 401 || error.status === 403);
  }

  private clearToken(): void {
    this.#token = null;
    this.#expiresAtMs = null;
    this.#scope = null;
  }
}
