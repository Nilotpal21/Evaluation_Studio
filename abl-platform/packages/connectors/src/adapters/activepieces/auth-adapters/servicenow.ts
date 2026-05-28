/**
 * ServiceNow OAuth Auth Adapter
 *
 * The unpatched @activepieces/piece-service-now uses Basic auth
 * (username + password). This adapter replaces createServiceNowClient in
 * common/props.js at runtime so that auth.props.accessToken is used with
 * Bearer token auth instead.
 *
 * All ServiceNow action files call createServiceNowClient via the module
 * export (props_1.createServiceNowClient), so replacing the export is
 * sufficient to cover the full action execution path.
 *
 * Must be called after localRequire('@activepieces/piece-service-now') so
 * the module is in the require cache.
 */

import { createLogger } from '../../../logger.js';

const log = createLogger('servicenow-auth-adapter');

interface ServiceNowAuth {
  props?: {
    instanceUrl?: string;
    accessToken?: string;
  };
}

interface ServiceNowClientOptions {
  instanceUrl: string;
  auth: { type: string; token?: string; username?: string; password?: string };
}

interface ServiceNowClientConstructor {
  new (opts: ServiceNowClientOptions): unknown;
}

interface ServiceNowCommonProps {
  createServiceNowClient: (auth: ServiceNowAuth) => unknown;
  [key: string]: unknown;
}

export function applyServiceNowAuthAdapter(localRequire: NodeRequire): void {
  const cacheKey = Object.keys(localRequire.cache).find(
    (k) => k.includes('piece-service-now') && k.includes('/common/') && k.endsWith('props.js'),
  );

  if (!cacheKey) {
    log.warn(
      'servicenow auth-adapter: common/props.js not found in require cache — OAuth not applied',
    );
    return;
  }

  const mod = localRequire.cache[cacheKey];
  if (!mod) {
    log.warn('servicenow auth-adapter: module entry is undefined — OAuth not applied');
    return;
  }

  const exp = mod.exports as ServiceNowCommonProps;
  const { ServiceNowClient } = localRequire(
    '@activepieces/piece-service-now/src/lib/common/client',
  ) as { ServiceNowClient: ServiceNowClientConstructor };

  exp.createServiceNowClient = function oauthCreateServiceNowClient(auth: ServiceNowAuth): unknown {
    const instanceUrl = auth.props?.instanceUrl;
    const accessToken = auth.props?.accessToken;

    if (!instanceUrl) throw new Error('ServiceNow: instanceUrl is required in auth profile');
    if (!accessToken) throw new Error('ServiceNow: accessToken is required in auth profile');

    return new ServiceNowClient({
      instanceUrl,
      auth: { type: 'bearer', token: accessToken },
    });
  };

  log.info('servicenow: OAuth auth adapter applied');
}
