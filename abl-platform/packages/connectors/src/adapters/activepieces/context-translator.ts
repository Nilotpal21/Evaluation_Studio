/**
 * Activepieces Context Translator
 *
 * Bridges our ActionContext/TriggerContext into the shape that
 * Activepieces piece actions and triggers expect at runtime.
 */

import type {
  ActionContext,
  AzureDocumentIntelligenceServices,
  KeyValueStore,
} from '../../types.js';
import { bridgeAzureDIAuth } from './auth-adapters/azure-document-intelligence.js';
import { ConnectorConfigError } from './context-translator-errors.js';

// `ConnectorConfigError` is re-exported here for backward compatibility with
// existing callers that imported it from `context-translator.js`. The class
// itself lives in `context-translator-errors.js` to break a circular import
// with the per-connector auth-adapter modules.
export { ConnectorConfigError };

/** Minimal AP store interface that pieces expect.
 *
 * `put` accepts an optional `ttlMs` argument — extending the upstream AP shape
 * (`put<T>(key, value): Promise<void>`) so ABL pieces that need durable TTLs
 * (e.g. Azure DI's `operation-location` stash, LLD §3 Phase 3 Task 3.5 step 7)
 * can request expiry without bypassing the standard store interface. Stock AP
 * pieces don't pass the 3rd arg and continue to work unchanged.
 */
interface APStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Minimal AP server context (pieces rarely use this) */
interface APServerContext {
  apiUrl: string;
  publicUrl: string;
  token: string;
}

/**
 * ABL-specific extension passed to AP-format pieces that need workflow context
 * (tenant id, workflow execution id, step id, connection id) — e.g. the Azure
 * Document Intelligence piece composes its replay-safe store key from
 * `${workflowExecutionId}:${stepId}` and looks up its cost-cap doc by
 * `(tenantId, projectId, connectionId)`.
 *
 * Stock AP pieces ignore this field; ABL-authored pieces opt in by reading it
 * via `(ctx as { abl?: ABLPieceContext }).abl`.
 */
export interface ABLPieceContext {
  /** Tenant id of the calling workflow execution. */
  tenantId: string;
  /** Project id of the calling workflow execution. */
  projectId: string;
  /** Workflow `_id` (NOT `crypto.randomUUID()`). Absent when invoked outside a workflow step. */
  workflowExecutionId?: string;
  /** Step `id` within the workflow run. Absent when invoked outside a workflow step. */
  stepId?: string;
  /** Resolved `ConnectorConnection._id` for this invocation. Absent for unbound calls. */
  connectionId?: string;
  /**
   * Workflow-engine-injected Azure DI services bag (cost-cap counter + circuit
   * breaker). Populated only when the connector being invoked is
   * `azure-document-intelligence`. ABL Azure DI piece hard-fails with
   * `INTEGRATION_UNAVAILABLE` if absent.
   */
  azureDocumentIntelligence?: AzureDocumentIntelligenceServices;
  /**
   * Workflow-engine callback context — provides enqueueADIPollJob, callbackUrlBuilder,
   * encryptSecret, and getSharedRedisClient for async-parking connectors.
   * Absent when invoked outside a workflow step or when the feature flag is off.
   */
  callbackContext?: import('../../types.js').CallbackContext;
}

/** AP execution context shape expected by piece actions */
export interface APActionContext {
  propsValue: Record<string, unknown>;
  auth: unknown;
  store: APStore;
  server: APServerContext;
  files: APFilesService;
  run: {
    id: string;
    stop: () => void;
    pause: (options: { pauseMetadata: unknown }) => void;
  };
  /** ABL-specific extension — only populated when invoked through this adapter. */
  abl?: ABLPieceContext;
}

/** AP files service interface (stub — not yet supported) */
interface APFilesService {
  write(params: { fileName: string; data: Buffer }): Promise<string>;
}

/** Wrap our KeyValueStore into AP's store interface. */
function wrapStore(store: KeyValueStore): APStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = await store.get<T>(key);
      return value ?? null;
    },
    async put<T>(key: string, value: T, ttlMs?: number): Promise<void> {
      await store.set(key, value, ttlMs);
    },
    async delete(key: string): Promise<void> {
      await store.delete(key);
    },
  };
}

/**
 * Coerce string-encoded JSON values (arrays, objects, booleans) back into
 * their native JS types. Workflow params are stored as Record<string, string>
 * but AP pieces expect typed values (e.g., arrays for receiver/cc/bcc fields).
 *
 * Note: Numeric strings are NOT coerced to avoid corrupting IDs, phone numbers,
 * zip codes, etc. AP pieces that need numeric types should handle the conversion
 * themselves. Only JSON structures (arrays/objects) and booleans are coerced.
 */
export function coerceParams(
  params: Record<string, unknown>,
  options?: { coerceObjects?: boolean },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') {
      result[key] = value;
      continue;
    }
    // Coerce JSON arrays and booleans always.
    // Coerce JSON objects only when coerceObjects=true — action params may contain
    // free-form text blobs (e.g. stringified agent output used as email body) that
    // must stay as strings so downstream pieces (nodemailer, Buffer.from) don't crash.
    // Trigger propsValue (dropdown selections like {owner,repo}) should use coerceObjects=true.
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (options?.coerceObjects && trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      trimmed === 'true' ||
      trimmed === 'false'
    ) {
      try {
        result[key] = JSON.parse(trimmed);
        continue;
      } catch {
        // Not valid JSON — keep as string
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Nest dot-notation keys into nested objects.
 *
 * Sub-field params from DynamicProperties props are stored in the flat params
 * map as `parentProp.subField` (e.g. `issueFields.summary`). AP pieces expect
 * them as `{ issueFields: { summary: ... } }`.
 *
 * Only single-level dot notation is nested — deeper nesting (a.b.c) is not
 * used by any current AP DynamicProperties resolver.
 */
export function nestDotParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const dotIdx = key.indexOf('.');
    if (dotIdx === -1) {
      // Dot-notation children take priority: skip the flat key if an object
      // has already been built for this name by its dot-notation children.
      if (typeof result[key] !== 'object' || result[key] === null) {
        result[key] = value;
      }
      continue;
    }
    const parent = key.slice(0, dotIdx);
    const child = key.slice(dotIdx + 1);
    // Replace non-object parent slot (e.g. flat "" value) with a real object.
    if (typeof result[parent] !== 'object' || result[parent] === null) {
      result[parent] = {};
    }
    (result[parent] as Record<string, unknown>)[child] = value;
  }
  return result;
}

/**
 * Coerce string params to native types declared by the action/trigger prop
 * schema. Studio sends every form value as a string; AP pieces validate the
 * native type and crash deep inside (e.g. Buffer.from(undefined)) on type
 * mismatch.
 *
 * Shared by both the live action runner (connector-tool-executor) and the
 * design-time test endpoint (action-test-service) so test results match real
 * runs exactly. Pure function — no IO, no side-effects.
 *
 * Numeric strings are NOT coerced for `string`-type props to avoid corrupting
 * IDs, phone numbers, zip codes, etc.
 */
export function coerceParamsByProps(
  params: Record<string, unknown>,
  props: ReadonlyArray<{ name: string; type: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const prop of props) {
    const raw = out[prop.name];
    if (typeof raw !== 'string') continue;
    if (prop.type === 'number') {
      const n = Number(raw);
      if (!Number.isNaN(n)) out[prop.name] = n;
    } else if (prop.type === 'boolean') {
      if (raw === 'true') out[prop.name] = true;
      else if (raw === 'false') out[prop.name] = false;
    } else if (
      prop.type === 'dropdown' ||
      prop.type === 'multi_select_dropdown' ||
      prop.type === 'array' ||
      prop.type === 'json'
    ) {
      // DynamicDropdownField serializes object-valued options as JSON.stringify.
      // array/json prop values arrive JSON-encoded too. Parse them back so
      // pieces receive typed values (e.g. {owner, repo} or string[]).
      const trimmed = raw.trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          out[prop.name] = JSON.parse(trimmed);
        } catch {
          // not valid JSON — leave as string
        }
      }
    }
  }
  return out;
}

/**
 * Normalize our auth profile secrets to the shape Activepieces pieces expect.
 *
 * Dispatches by connector name to produce the correct auth object shape for
 * each AP piece. The default branch preserves the legacy `apiKey → secret_text`
 * shim for SecretText-based pieces (e.g. @activepieces/piece-claude).
 */
export function normalizeAuthForAP(
  connectorName: string,
  auth: Record<string, unknown>,
): Record<string, unknown> {
  // Auth profile resolver returns { ...config, ...secrets } so connectionConfig is top-level.
  // Fall back to auth.connection.connectionConfig for legacy / test shapes.
  const connectionConfig =
    (auth.connectionConfig as Record<string, unknown> | undefined) ??
    ((auth.connection as Record<string, unknown> | undefined)?.connectionConfig as
      | Record<string, unknown>
      | undefined);
  const subdomain =
    typeof connectionConfig?.subdomain === 'string' ? connectionConfig.subdomain : undefined;

  // Extract subdomain from a resolved OAuth URL (e.g. "https://kore-73896.zendesk.com/...")
  // when connectionConfig was not stored separately in the auth profile config.
  function extractSubdomainFromUrl(pattern: RegExp): string | undefined {
    for (const key of ['authorizationUrl', 'tokenUrl', 'refreshUrl'] as const) {
      const url = typeof auth[key] === 'string' ? (auth[key] as string) : undefined;
      if (!url) continue;
      const match = url.match(pattern);
      if (match?.[1] && !match[1].includes('${')) return match[1];
    }
    return undefined;
  }

  switch (connectorName) {
    case 'zendesk': {
      const accessToken =
        typeof auth.access_token === 'string'
          ? auth.access_token
          : typeof auth.apiKey === 'string'
            ? auth.apiKey
            : undefined;
      const resolvedSubdomain =
        subdomain ?? extractSubdomainFromUrl(/https:\/\/([^.]+)\.zendesk\.com/);
      if (!resolvedSubdomain)
        throw new ConnectorConfigError(
          'Zendesk connector requires connectionConfig.subdomain — set subdomain during auth profile creation',
        );
      if (!accessToken)
        throw new ConnectorConfigError(
          'Zendesk connector requires access_token or apiKey in auth credentials',
        );
      return { props: { subdomain: resolvedSubdomain, accessToken } };
    }
    case 'jira-cloud': {
      return auth;
    }
    case 'servicenow': {
      const accessToken =
        typeof auth.access_token === 'string'
          ? auth.access_token
          : typeof auth.apiKey === 'string'
            ? auth.apiKey
            : undefined;
      const resolvedSubdomain =
        subdomain ?? extractSubdomainFromUrl(/https:\/\/([^.]+)\.service-now\.com/);
      if (!resolvedSubdomain)
        throw new ConnectorConfigError(
          'ServiceNow connector requires connectionConfig.subdomain — set subdomain during auth profile creation',
        );
      if (!accessToken)
        throw new ConnectorConfigError(
          'ServiceNow connector requires access_token or apiKey in auth credentials',
        );
      return {
        props: { instanceUrl: `https://${resolvedSubdomain}.service-now.com`, accessToken },
      };
    }
    case 'amazon-s3': {
      const accessKeyId = typeof auth.accessKeyId === 'string' ? auth.accessKeyId : undefined;
      const secretAccessKey =
        typeof auth.secretAccessKey === 'string' ? auth.secretAccessKey : undefined;
      const region = typeof auth.region === 'string' ? auth.region : undefined;
      const bucket = typeof auth.bucket === 'string' ? auth.bucket : undefined;
      const endpoint = typeof auth.endpoint === 'string' ? auth.endpoint : undefined;
      if (!accessKeyId || !secretAccessKey || !region) {
        throw new ConnectorConfigError(
          'Amazon S3 connector requires accessKeyId, secretAccessKey, and region',
        );
      }
      if (!bucket) {
        throw new ConnectorConfigError(
          'Amazon S3 connector requires bucket — set bucket on the auth profile',
        );
      }
      return { props: { accessKeyId, secretAccessKey, region, bucket, endpoint } };
    }
    case 'amazon-ses':
    case 'amazon-sqs':
    case 'amazon-sns': {
      const accessKeyId = typeof auth.accessKeyId === 'string' ? auth.accessKeyId : undefined;
      const secretAccessKey =
        typeof auth.secretAccessKey === 'string' ? auth.secretAccessKey : undefined;
      const region = typeof auth.region === 'string' ? auth.region : undefined;
      if (!accessKeyId || !secretAccessKey || !region) {
        throw new ConnectorConfigError(
          `${connectorName} connector requires accessKeyId, secretAccessKey, and region`,
        );
      }
      return { props: { accessKeyId, secretAccessKey, region } };
    }
    case 'azure-blob-storage': {
      // AP piece uses BlobServiceClient.fromConnectionString(auth.connectionString).
      // Auth profile stores the storage account connection string as api_key.
      const connectionString = typeof auth.apiKey === 'string' ? auth.apiKey : undefined;
      if (!connectionString) {
        throw new ConnectorConfigError(
          'Azure Blob connector requires the storage account connection string in the API key field',
        );
      }
      return { connectionString };
    }
    case 'shopify': {
      // Shopify piece expects { props: { shopName, adminToken } }
      // shopName = subdomain from connectionConfig (e.g. "mystore" for mystore.myshopify.com)
      // adminToken = the API key / admin access token
      const adminToken =
        typeof auth.apiKey === 'string'
          ? auth.apiKey
          : typeof auth.access_token === 'string'
            ? auth.access_token
            : undefined;
      const shopName = subdomain ?? extractSubdomainFromUrl(/https:\/\/([^.]+)\.myshopify\.com/);
      if (!shopName)
        throw new ConnectorConfigError(
          'Shopify connector requires connectionConfig.subdomain — set the shop subdomain during auth profile creation',
        );
      if (!adminToken)
        throw new ConnectorConfigError(
          'Shopify connector requires apiKey (admin access token) in auth credentials',
        );
      return { props: { shopName, adminToken } };
    }
    case 'azure-document-intelligence': {
      // The Azure DI piece reads ctx.auth as a flat object (PieceAuth.CustomAuth
      // with `endpoint`, `apiKey`, `apiVersion` props; model is per-action). The auth
      // bridge lives in `auth-adapters/azure-document-intelligence.ts` so the
      // mapping is unit-testable in isolation (LLD §3 Phase 3 Task 3.7).
      return bridgeAzureDIAuth(auth);
    }
    default: {
      if (typeof auth.apiKey === 'string' && auth.secret_text === undefined) {
        return { ...auth, secret_text: auth.apiKey };
      }
      return auth;
    }
  }
}

/**
 * Normalise an auth-profile credential bundle into the shape an Activepieces
 * piece's `auth.validate` hook expects.
 *
 * This is NOT the same as the action-runtime shape produced by
 * `normalizeAuthForAP`. Two divergences exist today:
 *
 *  1. **CUSTOM_AUTH pieces** (e.g. Shopify) — at action time we pass
 *     `{ props: { ...credentialFields } }` because that's what the piece's
 *     `sendXyzRequest()` helpers consume. The piece's `validate` hook
 *     receives the credential fields directly (Activepieces convention:
 *     `validate({ auth: <PropsShape> })` where PropsShape is the flat object).
 *  2. **SECRET_TEXT pieces** (e.g. Linear) — at action time we surface
 *     `{ secret_text, apiKey, ... }`, but `validate` receives the raw
 *     credential **string**, not an object.
 *
 * Per-connector switch keeps this explicit and grep-able. Add a case here
 * when a new piece declares a `validate` hook whose expected auth shape
 * differs from `normalizeAuthForAP`'s output.
 */
export function normalizeAuthForPieceValidate(
  connectorName: string,
  auth: Record<string, unknown>,
): unknown {
  // Piece-validate is the test-connection / credential-only path. It must not
  // require resource-scoped fields like S3 `bucket` or Azure Blob container —
  // those are per-action parameters, not auth credentials. If normalizeAuthForAP
  // throws because a resource field is missing, fall back to the raw auth so
  // the piece's own validate hook can decide what counts as a failure
  // (ABLP-1123).
  let apShape: unknown;
  try {
    apShape = normalizeAuthForAP(connectorName, auth);
  } catch (err) {
    if (err instanceof ConnectorConfigError) {
      return auth;
    }
    throw err;
  }

  switch (connectorName) {
    // CUSTOM_AUTH pieces wrapped as `{ props: { ... } }` for the action runtime.
    // Activepieces pieces' validate hooks read the props directly.
    // ABLP-1123: amazon-* pieces share the same `{ props }` envelope at action
    // time but their validate hooks consume the credentials directly.
    case 'amazon-ses':
    case 'amazon-sqs':
    case 'amazon-sns':
    case 'shopify': {
      if (
        typeof apShape === 'object' &&
        apShape !== null &&
        'props' in apShape &&
        typeof (apShape as Record<string, unknown>).props === 'object' &&
        (apShape as Record<string, unknown>).props !== null
      ) {
        return (apShape as Record<string, unknown>).props;
      }
      return apShape;
    }

    // SECRET_TEXT pieces — the piece's validate hook expects the raw
    // credential string. Our action-runtime shape is `{ secret_text, apiKey, ... }`.
    case 'airtable':
    case 'openai':
    case 'stripe':
    case 'linear': {
      if (typeof apShape === 'object' && apShape !== null) {
        const value =
          (apShape as Record<string, unknown>).secret_text ??
          (apShape as Record<string, unknown>).apiKey;
        if (typeof value === 'string') return value;
      }
      return apShape;
    }

    // Azure DI: the piece's validate hook expects the flat PieceAuth.CustomAuth
    // shape ({ endpoint, apiKey, apiVersion }). Our stored auth profile carries
    // `apiKey` at top level and `endpoint, apiVersion` under `connectionConfig`
    // — same input shape `bridgeAzureDIAuth` consumes for the action runtime.
    // Reuse the bridge but swallow its missing-field error so the user gets a
    // `{ valid: false, error }` from the piece's hook (with friendlier messaging)
    // instead of a stack trace. Model lives on the action, not the profile.
    case 'azure-document-intelligence': {
      try {
        return bridgeAzureDIAuth(auth);
      } catch {
        const cc =
          (auth.connectionConfig as Record<string, unknown> | undefined) ??
          ((auth.connection as Record<string, unknown> | undefined)?.connectionConfig as
            | Record<string, unknown>
            | undefined) ??
          {};
        return {
          endpoint: typeof cc.endpoint === 'string' ? cc.endpoint : '',
          apiKey: typeof auth.apiKey === 'string' ? auth.apiKey : '',
          apiVersion: typeof cc.apiVersion === 'string' ? cc.apiVersion : '2024-11-30',
        };
      }
    }

    default:
      return apShape;
  }
}

/**
 * Translate our ActionContext into AP's execution context.
 */
export function translateActionContext(ctx: ActionContext): APActionContext {
  const rawAuth = (ctx.auth ?? {}) as Record<string, unknown>;
  return {
    propsValue: nestDotParams(coerceParams(ctx.params as Record<string, unknown>)),
    auth: normalizeAuthForAP(ctx.connectorName ?? '', rawAuth),
    store: wrapStore(ctx.store),
    server: {
      apiUrl: '',
      publicUrl: '',
      token: '',
    },
    // AP actions that produce attachments (e.g. Gmail Find Email, OneDrive
    // download-file, Outlook download-email-attachment) call
    // `context.files.write({fileName, data, mimeType})`. We delegate to the
    // tenant-bound fileWriter on our ActionContext — the same writer used by
    // triggers — so the action returns a real download URL instead of an empty
    // attachments array.
    files: {
      write: async ({
        fileName,
        data,
        mimeType,
      }: {
        fileName: string;
        data: Buffer | string;
        mimeType?: string;
      }) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string, 'binary');
        const resolvedMimeType = mimeType ?? 'application/octet-stream';
        if (ctx.fileWriter) {
          return ctx.fileWriter(fileName, buf, resolvedMimeType);
        }
        // Fallback: base64 data URI when no external storage is configured (dev/test).
        const base64 = buf.toString('base64');
        return `data:${resolvedMimeType};name=${encodeURIComponent(fileName)};base64,${base64}`;
      },
    },
    run: {
      id: ctx.executionId ?? 'unknown',
      stop: () => {},
      pause: () => {},
    },
    abl: {
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      ...(ctx.workflowExecutionId ? { workflowExecutionId: ctx.workflowExecutionId } : {}),
      ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
      ...(ctx.azureDocumentIntelligence
        ? { azureDocumentIntelligence: ctx.azureDocumentIntelligence }
        : {}),
      ...(ctx.callbackContext ? { callbackContext: ctx.callbackContext } : {}),
    },
  };
}
