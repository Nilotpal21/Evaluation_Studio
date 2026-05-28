/**
 * Activepieces -> ConnectorSDK Type Mapper
 *
 * Maps Activepieces piece metadata (auth, properties, actions, triggers)
 * to our ConnectorSDK type system at BUILD TIME.
 *
 * This runs during `pnpm connectors:import` -- NOT at runtime.
 */

import type {
  ConnectorAuth,
  ConnectorProperty,
  ConnectorPropertyType,
  ConnectorAction,
  ConnectorTrigger,
} from '../../types.js';

// ---- Activepieces type definitions (subset for mapping) ----

export interface APPieceAuth {
  type: 'OAUTH2' | 'SECRET_TEXT' | 'BASIC_AUTH' | 'CUSTOM_AUTH' | 'NONE';
  description?: string;
  required?: boolean;
  displayName?: string;
  props?: Record<string, APProperty>;
  /** OAuth2 fields (present when type === 'OAUTH2') */
  authUrl?: string;
  tokenUrl?: string;
  scope?: string[];
  /**
   * Optional "test connection" hook that pieces wire via Activepieces'
   * `BasePieceAuthSchema.validate`. Surface kept loose (`unknown`-ish) here
   * because we wrap it before exposing on `ConnectorAuth.validateAuth`.
   */
  validate?: (input: {
    auth: unknown;
    server: { apiUrl: string; publicUrl: string };
  }) => Promise<{ valid: true } | { valid: false; error: string }>;
}

export interface APProperty {
  type:
    | 'SHORT_TEXT'
    | 'LONG_TEXT'
    | 'NUMBER'
    | 'CHECKBOX'
    | 'DROPDOWN'
    | 'STATIC_DROPDOWN'
    | 'MULTI_SELECT_DROPDOWN'
    | 'STATIC_MULTI_SELECT_DROPDOWN'
    | 'DYNAMIC'
    | 'ARRAY'
    | 'OBJECT'
    | 'JSON'
    | 'DATE_TIME'
    | 'FILE';
  displayName: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  options?: { label: string; value: string }[];
  /**
   * Only populated by `Property.Dropdown` / `Property.MultiSelectDropdown`.
   * Lists sibling prop names whose values are needed to resolve options.
   */
  refreshers?: string[];
  /**
   * Present on Activepieces `Property.DynamicProperties` — the async function
   * that resolves the field map given { auth, ...refresherValues }.
   * Absent on all other property types.
   */
  props?: unknown;
  /**
   * Present on Activepieces `Property.Array` when sub-field schemas are
   * declared (e.g. Extract Structured Data's `params` prop). Keys are field
   * names; values describe each sub-field.
   */
  properties?: Record<string, APProperty>;
}

export interface APAction {
  name: string;
  displayName: string;
  description: string;
  props: Record<string, APProperty>;
  requireAuth?: boolean;
}

export interface APTrigger {
  name: string;
  displayName: string;
  description: string;
  type: 'WEBHOOK' | 'APP_WEBHOOK' | 'POLLING';
  props: Record<string, APProperty>;
  sampleData?: Record<string, unknown>;
}

export interface APPiece {
  name: string;
  displayName: string;
  description: string;
  version: string;
  /**
   * Most pieces export a single auth method. Newer AP pieces (e.g. google-sheets)
   * export an array of auth methods — typically [OAuth2, CustomAuth service-account].
   * We collapse arrays to a single method in `mapAuth()` by preferring OAuth2.
   */
  auth?: APPieceAuth | APPieceAuth[];
  actions: Record<string, APAction>;
  triggers: Record<string, APTrigger>;
}

const CUSTOM_AUTH_AUTH_PROFILE_UNSUPPORTED_MESSAGE =
  "Activepieces CUSTOM_AUTH cannot be bridged to auth profiles. Auth profiles only support header-based 'custom_header', not arbitrary connector credential fields.";

/**
 * Guard connector -> auth-profile bridge attempts so CUSTOM_AUTH fails with an
 * explicit product error instead of a downstream Zod discriminator rejection.
 */
export function assertActivepiecesAuthProfileBridgeSupported(auth: ConnectorAuth): void {
  if (auth.type === 'custom') {
    throw new Error(CUSTOM_AUTH_AUTH_PROFILE_UNSUPPORTED_MESSAGE);
  }
}

/**
 * Maps Activepieces auth type -> our ConnectorAuth.
 *
 * Pure structural mapping. Runtime hooks (e.g. the piece's `auth.validate`)
 * are attached separately by `wrapActivepiecesPiece` in runtime-adapter.ts —
 * this keeps `mapAuth` safely shareable with the build-time codegen path
 * (importer.ts) where embedding closures isn't meaningful.
 */
export function mapAuth(apAuth?: APPieceAuth | APPieceAuth[]): ConnectorAuth {
  // Dual-auth pieces export an array like [OAuth2, CustomAuth]. Prefer OAuth2
  // so those connectors show up in the catalog with the richer auth mode.
  // Fall back to the first entry if OAuth2 isn't present.
  if (Array.isArray(apAuth)) {
    if (apAuth.length === 0) {
      return { type: 'none' };
    }
    const preferred = apAuth.find((a) => a.type === 'OAUTH2') ?? apAuth[0];
    return mapAuth(preferred);
  }

  if (!apAuth || apAuth.type === 'NONE') {
    return { type: 'none' };
  }

  switch (apAuth.type) {
    case 'OAUTH2':
      return {
        type: 'oauth2',
        oauth2:
          apAuth.authUrl && apAuth.tokenUrl
            ? {
                authorizationUrl: apAuth.authUrl,
                tokenUrl: apAuth.tokenUrl,
                scopes: apAuth.scope ?? [],
              }
            : undefined,
      };
    case 'SECRET_TEXT':
      return {
        type: 'api_key',
        fields: [
          {
            name: 'apiKey',
            displayName: apAuth.displayName ?? 'API Key',
            required: true,
            sensitive: true,
          },
        ],
      };
    case 'BASIC_AUTH':
      return {
        type: 'basic',
        fields: [
          { name: 'username', displayName: 'Username', required: true, sensitive: false },
          { name: 'password', displayName: 'Password', required: true, sensitive: true },
        ],
      };
    case 'CUSTOM_AUTH':
      return {
        type: 'custom',
        fields: apAuth.props
          ? Object.entries(apAuth.props).map(([name, prop]) => ({
              name,
              displayName: prop.displayName,
              required: prop.required ?? false,
              sensitive: true,
            }))
          : [],
      };
    default:
      return { type: 'none' };
  }
}

/**
 * Wraps the underlying piece's `validate` hook into our ConnectorAuthValidator
 * shape. Catches thrown errors and coerces them into the
 * `{ valid: false, error }` envelope so route handlers never see a raw
 * provider exception. Returns `undefined` when the piece declares no hook.
 *
 * Exposed for use by `wrapActivepiecesPiece`, which attaches the result to
 * the runtime `Connector.auth.validateAuth` field.
 */
export function wrapPieceValidate(
  apAuth?: APPieceAuth | APPieceAuth[],
): ConnectorAuth['validateAuth'] | undefined {
  if (!apAuth) return undefined;
  // For dual-auth pieces (e.g. google-sheets: [OAuth2, CUSTOM_AUTH service-account])
  // prefer an entry that actually declares a validate function — the validate hook
  // may live on a non-OAuth2 entry while the OAuth2 entry has none. Fall back to
  // OAuth2-preferred (consistent with mapAuth) only when no entry has validate.
  if (Array.isArray(apAuth)) {
    if (apAuth.length === 0) return undefined;
    // Prefer OAUTH2+validate, then any entry with validate, then OAUTH2, then first.
    const oauthWithValidate = apAuth.find(
      (a) => a.type === 'OAUTH2' && typeof a.validate === 'function',
    );
    if (oauthWithValidate) return wrapPieceValidate(oauthWithValidate);
    const withValidate = apAuth.find((a) => typeof a.validate === 'function');
    if (withValidate) return wrapPieceValidate(withValidate);
    const preferred = apAuth.find((a) => a.type === 'OAUTH2') ?? apAuth[0];
    return wrapPieceValidate(preferred);
  }
  if (typeof apAuth.validate !== 'function') return undefined;
  const fn = apAuth.validate;
  return async (input) => {
    try {
      return await fn({ auth: input.auth, server: input.server });
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * Maps Activepieces property type -> our ConnectorPropertyType.
 *
 * Our type system supports: string, number, boolean, dropdown,
 * dynamic_dropdown, json, date, file. Types without a direct
 * equivalent are mapped to the closest match.
 */
export function mapPropertyType(apType: APProperty['type']): ConnectorPropertyType {
  switch (apType) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
      return 'string';
    case 'NUMBER':
      return 'number';
    case 'CHECKBOX':
      return 'boolean';
    case 'DROPDOWN':
    case 'STATIC_DROPDOWN':
      return 'dropdown';
    case 'MULTI_SELECT_DROPDOWN':
    case 'STATIC_MULTI_SELECT_DROPDOWN':
      return 'multi_select_dropdown';
    case 'DYNAMIC':
      return 'dynamic_dropdown';
    case 'ARRAY':
      return 'array';
    case 'OBJECT':
    case 'JSON':
      return 'json';
    case 'DATE_TIME':
      return 'date';
    case 'FILE':
      return 'file';
    default:
      return 'string';
  }
}

/** Maps a single Activepieces property -> ConnectorProperty */
export function mapProperty(name: string, apProp: APProperty): ConnectorProperty {
  const prop: ConnectorProperty = {
    name,
    displayName: apProp.displayName,
    type: mapPropertyType(apProp.type),
    required: apProp.required ?? false,
  };

  if (apProp.description) {
    prop.description = apProp.description;
  }

  if (apProp.defaultValue !== undefined) {
    prop.defaultValue = apProp.defaultValue;
  }

  if (
    apProp.options &&
    (apProp.type === 'DROPDOWN' ||
      apProp.type === 'STATIC_DROPDOWN' ||
      apProp.type === 'MULTI_SELECT_DROPDOWN')
  ) {
    prop.options = apProp.options;
  }

  // DynamicProperties and Dropdown both serialize to type: 'DYNAMIC' in AP.
  // Distinguish them by the presence of a `props` function (DynamicProperties)
  // vs an `options` function (Dropdown). Set the correct type and always copy refreshers.
  if (apProp.type === 'DYNAMIC') {
    const hasPropsFn = typeof apProp.props === 'function';
    prop.type = hasPropsFn ? 'dynamic_properties' : 'dynamic_dropdown';
    prop.refreshers = Array.isArray(apProp.refreshers) ? apProp.refreshers : [];
  }

  // `Property.Dropdown` / `Property.MultiSelectDropdown` carry a `refreshers` array.
  // We expose `refreshers` on the catalog so Studio knows the dropdown is dynamic;
  // the resolver itself is wired up in runtime-adapter.
  if (
    Array.isArray(apProp.refreshers) &&
    apProp.type !== 'DYNAMIC' &&
    (apProp.type === 'DROPDOWN' || apProp.type === 'MULTI_SELECT_DROPDOWN')
  ) {
    prop.refreshers = apProp.refreshers;
  }

  // `Property.Array` with a `properties` map declares a per-row sub-field schema.
  // Map sub-props recursively so Studio can render a structured row editor.
  if (apProp.type === 'ARRAY' && apProp.properties && typeof apProp.properties === 'object') {
    prop.properties = Object.entries(apProp.properties).map(([subName, subProp]) =>
      mapProperty(subName, subProp),
    );
  }

  return prop;
}

/** Maps Activepieces action -> ConnectorAction */
export function mapAction(apAction: APAction): ConnectorAction {
  const props = apAction.props && typeof apAction.props === 'object' ? apAction.props : {};
  return {
    name: apAction.name,
    displayName: apAction.displayName,
    description: apAction.description ?? '',
    props: Object.entries(props).map(([name, prop]) => mapProperty(name, prop)),
    run: async () => {
      throw new Error(`Action ${apAction.name} requires runtime binding`);
    },
  };
}

/** Maps Activepieces trigger -> ConnectorTrigger */
export function mapTrigger(apTrigger: APTrigger): ConnectorTrigger {
  const props = apTrigger.props && typeof apTrigger.props === 'object' ? apTrigger.props : {};
  return {
    name: apTrigger.name,
    displayName: apTrigger.displayName,
    description: apTrigger.description ?? '',
    triggerType:
      apTrigger.type === 'WEBHOOK' || apTrigger.type === 'APP_WEBHOOK' ? 'event' : 'cron',
    props: Object.entries(props).map(([name, prop]) => mapProperty(name, prop)),
    sampleData: apTrigger.sampleData,
    onEnable: async () => {},
    onDisable: async () => {},
    run: async () => [],
  };
}

/** Maps a full Activepieces piece -> our Connector definition */
export function mapPieceToConnector(piece: APPiece) {
  // AP v0.40+ pieces use lazy getter methods — call with correct `this` context
  const actions: Record<string, APAction> =
    typeof piece.actions === 'function'
      ? (piece.actions as unknown as () => Record<string, APAction>).call(piece)
      : (piece.actions ?? {});
  const triggers: Record<string, APTrigger> =
    typeof piece.triggers === 'function'
      ? (piece.triggers as unknown as () => Record<string, APTrigger>).call(piece)
      : (piece.triggers ?? {});
  return {
    name: piece.name,
    displayName: piece.displayName,
    version: piece.version,
    description: piece.description ?? '',
    // CUSTOM_AUTH stays connector-only. Any future connector -> auth-profile
    // bridge must guard with assertActivepiecesAuthProfileBridgeSupported().
    auth: mapAuth(piece.auth),
    actions: Object.values(actions).map(mapAction),
    triggers: Object.values(triggers).map(mapTrigger),
  };
}
