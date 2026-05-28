/**
 * Activepieces Runtime Adapter
 *
 * Wraps an Activepieces piece npm module into our Connector interface
 * at runtime. Reuses the existing type-mapper.ts for metadata mapping
 * and context-translator.ts for execution context bridging.
 */

import type {
  Connector,
  ConnectorAction,
  ConnectorTrigger,
  ConnectorProperty,
  ConnectorPropertyType,
  ActionContext,
  DropdownOption,
  DropdownState,
  DynamicPropertiesState,
  DynamicSubField,
  ResolveOptionsContext,
  TriggerContext,
  TriggerRunContext,
} from '../../types.js';
import {
  mapAuth,
  mapProperty,
  wrapPieceValidate,
  type APPiece,
  type APAction,
  type APProperty,
  type APTrigger,
} from './type-mapper.js';
import { translateActionContext, normalizeAuthForAP, coerceParams } from './context-translator.js';
import { assertSafeFileUrl, MAX_FILE_BYTES } from '../../security.js';

/**
 * Check if an object looks like an AP piece definition.
 * AP pieces have displayName and actions (actions may be a function or object).
 */
function isPieceLike(val: unknown): boolean {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.displayName === 'string' && 'actions' in obj;
}

/**
 * Extract the piece definition from a dynamic import's module export.
 *
 * AP pieces (v0.40+) typically export:
 *   - A named export matching the piece name (e.g., `slack`, `github`, `jiraCloud`)
 *   - `default` wrapping the named exports as `{ slack: <piece> }`
 *
 * The piece object may also export non-piece objects (e.g., `openaiAuth`),
 * so we filter for objects that have `displayName` + `actions`.
 */
export function extractPieceFromExport(mod: unknown): APPiece {
  if (!mod || typeof mod !== 'object') {
    throw new Error('Invalid Activepieces piece module');
  }

  const moduleObj = mod as Record<string, unknown>;

  // 1. Check named exports first (skip internal interop keys)
  for (const key of Object.keys(moduleObj)) {
    if (key === '__esModule' || key === 'default' || key === 'module.exports') continue;
    const val = moduleObj[key];
    if (isPieceLike(val)) {
      return val as unknown as APPiece;
    }
  }

  // 2. Check inside default export (AP wraps named exports in default)
  if (moduleObj.default && typeof moduleObj.default === 'object') {
    const defaultObj = moduleObj.default as Record<string, unknown>;
    // If default itself is a piece
    if (isPieceLike(defaultObj)) {
      return defaultObj as unknown as APPiece;
    }
    // If default wraps pieces (e.g., { slack: <piece> })
    for (const key of Object.keys(defaultObj)) {
      const val = defaultObj[key];
      if (isPieceLike(val)) {
        return val as unknown as APPiece;
      }
    }
  }

  throw new Error('Could not find piece definition in module exports');
}

/**
 * Create a runtime-bound ConnectorAction from an AP action.
 * Unlike type-mapper's mapAction (build-time only), this version
 * wires up a real run() that translates context and calls the AP action.
 */
function safeMapProps(props: Record<string, APProperty>): ConnectorProperty[] {
  const mapped: ConnectorProperty[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object' || !prop.type) continue;
    try {
      mapped.push(mapProperty(name, prop));
    } catch {
      // Skip malformed properties rather than failing the entire action/connector
    }
  }
  return mapped;
}

/**
 * Translate our TriggerContext into AP's trigger context shape.
 * AP triggers expect { auth, store, webhookUrl, payload, propsValue }.
 */
function translateTriggerContext(ctx: TriggerContext | TriggerRunContext): Record<string, unknown> {
  const apStore = {
    async get<T>(key: string): Promise<T | null> {
      const value = await ctx.store.get<T>(key);
      return value ?? null;
    },
    async put<T>(key: string, value: T): Promise<void> {
      await ctx.store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      await ctx.store.delete(key);
    },
  };

  // Read propsValue from TriggerRunContext if available.
  // Coerce string-encoded JSON values (objects/arrays/booleans) so AP pieces
  // receive native types — e.g. Gmail label stored as JSON.stringify({id,name})
  // must arrive as an object so the trigger can read props.label.name.
  const rawPropsValue = 'propsValue' in ctx && ctx.propsValue ? ctx.propsValue : {};
  // Triggers use structured dropdown values (e.g. {owner,repo}) that are stored as
  // JSON strings by the UI — coerce them back to objects so AP pieces receive typed values.
  const propsValue = coerceParams(rawPropsValue as Record<string, unknown>, {
    coerceObjects: true,
  });

  const rawAuth = (ctx.auth ?? {}) as Record<string, unknown>;
  return {
    auth: normalizeAuthForAP(ctx.connectorName ?? '', rawAuth),
    store: apStore,
    webhookUrl: ctx.webhookUrl ?? '',
    propsValue,
    payload: {},
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
        if ('fileWriter' in ctx && typeof ctx.fileWriter === 'function') {
          return ctx.fileWriter(fileName, buf, resolvedMimeType);
        }
        // Fallback: base64 data URI (no external storage configured)
        const base64 = buf.toString('base64');
        return `data:${resolvedMimeType};name=${encodeURIComponent(fileName)};base64,${base64}`;
      },
    },
    ...('lastRunData' in ctx ? { lastRunContext: ctx.lastRunData } : {}),
  };
}

/**
 * Create a runtime-bound ConnectorTrigger from an AP trigger.
 * Unlike type-mapper's mapTrigger (build-time stubs), this version
 * wires real onEnable(), onDisable(), and run() to the AP trigger.
 */
function createRuntimeTrigger(apTrigger: APTrigger): ConnectorTrigger {
  const props = apTrigger.props && typeof apTrigger.props === 'object' ? apTrigger.props : {};

  // AP triggers have onEnable/onDisable/run/test as methods but the APTrigger
  // type doesn't declare them. Access via Record rather than a double cast.
  const triggerRecord = apTrigger as unknown as Record<string, unknown>;

  // Collect dropdown props with runtime options resolvers (same pattern as actions)
  const optionsResolvers = new Map<string, APDropdownOptionsFn>();
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    const fn = (prop as { options?: unknown }).options;
    if (
      typeof fn === 'function' &&
      (prop.type === 'DROPDOWN' || prop.type === 'MULTI_SELECT_DROPDOWN')
    ) {
      optionsResolvers.set(name, fn as APDropdownOptionsFn);
    }
  }

  // Collect DynamicProperties props
  const dynamicPropsResolvers = new Map<string, APDynamicPropsFn>();
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    const fn = (prop as { props?: unknown }).props;
    if (typeof fn === 'function' && (prop as { type?: string }).type === 'DYNAMIC') {
      dynamicPropsResolvers.set(name, fn as APDynamicPropsFn);
    }
  }

  const trigger: ConnectorTrigger = {
    name: apTrigger.name,
    displayName: apTrigger.displayName,
    description: apTrigger.description ?? '',
    triggerType:
      apTrigger.type === 'WEBHOOK' || apTrigger.type === 'APP_WEBHOOK' ? 'webhook' : 'cron',
    props: safeMapProps(props),
    sampleData: apTrigger.sampleData,

    async onEnable(ctx: TriggerContext): Promise<void> {
      if (typeof triggerRecord.onEnable === 'function') {
        const apCtx = translateTriggerContext(ctx);
        await (triggerRecord.onEnable as (ctx: unknown) => Promise<void>)(apCtx);
      }
    },

    async onDisable(ctx: TriggerContext): Promise<void> {
      if (typeof triggerRecord.onDisable === 'function') {
        const apCtx = translateTriggerContext(ctx);
        await (triggerRecord.onDisable as (ctx: unknown) => Promise<void>)(apCtx);
      }
    },

    async run(ctx: TriggerRunContext): Promise<unknown[]> {
      const apCtx = translateTriggerContext(ctx);

      // Prefer run(), fall back to test() for triggers that only implement test
      const runFn =
        typeof triggerRecord.run === 'function'
          ? (triggerRecord.run as (ctx: unknown) => Promise<unknown[]>)
          : typeof triggerRecord.test === 'function'
            ? (triggerRecord.test as (ctx: unknown) => Promise<unknown[]>)
            : null;
      if (!runFn) {
        return [];
      }

      const result = await runFn(apCtx);
      return Array.isArray(result) ? result : [result];
    },

    async testRun(ctx: TriggerRunContext): Promise<unknown[]> {
      // Sample-data resolution strategy (in priority order):
      //   1. Call AP test() — for POLLING triggers this hits the provider API
      //      and returns real items; for WEBHOOK/APP_WEBHOOK it usually returns
      //      [undefined] or [sampleData] as a placeholder.
      //   2. Filter out null/undefined items returned by step 1.
      //   3. If step 2 leaves us empty and the trigger ships static sampleData,
      //      use that — guarantees a schema for the expression builder.
      //   4. If test() throws (bad auth, network, etc.), still fall back to
      //      sampleData when available so the user never sees a blank suggestion.
      const apCtx = translateTriggerContext(ctx);
      const testFn =
        typeof triggerRecord.test === 'function'
          ? (triggerRecord.test as (ctx: unknown) => Promise<unknown[]>)
          : typeof triggerRecord.run === 'function'
            ? (triggerRecord.run as (ctx: unknown) => Promise<unknown[]>)
            : null;

      const sampleFallback: unknown[] = apTrigger.sampleData != null ? [apTrigger.sampleData] : [];

      if (!testFn) return sampleFallback;

      try {
        const result = await testFn(apCtx);
        const items = Array.isArray(result) ? result : [result];
        const valid = items.filter((item) => item != null);
        return valid.length > 0 ? valid : sampleFallback;
      } catch (err) {
        if (sampleFallback.length > 0) return sampleFallback;
        throw err;
      }
    },
  };

  if (optionsResolvers.size > 0) {
    trigger.resolveOptions = async (
      propName: string,
      ctx: ResolveOptionsContext,
    ): Promise<DropdownState> => {
      const fn = optionsResolvers.get(propName);
      if (!fn) {
        throw new Error(
          `Trigger '${apTrigger.name}' has no options resolver for prop '${propName}'`,
        );
      }

      const apStore = {
        async get<T>(key: string): Promise<T | null> {
          const value = await ctx.store.get<T>(key);
          return value ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          await ctx.store.set(key, value);
        },
        async delete(key: string): Promise<void> {
          await ctx.store.delete(key);
        },
      };

      const result = await fn(
        {
          auth: normalizeAuthForAP(
            ctx.connectorName ?? '',
            (ctx.auth ?? {}) as Record<string, unknown>,
          ),
          ...ctx.propsValue,
        },
        { searchValue: ctx.searchValue, store: apStore },
      );

      return {
        disabled: result.disabled ?? false,
        placeholder: result.placeholder,
        options: Array.isArray(result.options) ? result.options : [],
      };
    };
  }

  if (dynamicPropsResolvers.size > 0) {
    trigger.resolveDynamicProps = async (
      propName: string,
      ctx: ResolveOptionsContext,
    ): Promise<DynamicPropertiesState> => {
      const fn = dynamicPropsResolvers.get(propName);
      if (!fn) {
        throw new Error(
          `Trigger '${apTrigger.name}' has no dynamic props resolver for prop '${propName}'`,
        );
      }

      const rawResult = await fn({
        auth: normalizeAuthForAP(
          ctx.connectorName ?? '',
          (ctx.auth ?? {}) as Record<string, unknown>,
        ),
        ...ctx.propsValue,
      });

      const state: DynamicPropertiesState = {};
      for (const [name, apProp] of Object.entries(rawResult)) {
        if (!apProp) continue;
        state[name] = mapAPSubField(name, apProp);
      }
      return state;
    };
  }

  return trigger;
}

/**
 * AP `Property.Dropdown` exposes an async `options` function whose first
 * argument is `{ auth, ...refresherValues }` and whose second argument is
 * a context object with `searchValue` and an AP-style `store`.
 */
interface APDropdownOptionsFn {
  (
    args: { auth: unknown } & Record<string, unknown>,
    ctx: {
      searchValue?: string;
      store: {
        get<T>(key: string): Promise<T | null>;
        put<T>(key: string, value: T): Promise<void>;
        delete(key: string): Promise<void>;
      };
    },
  ): Promise<{
    disabled?: boolean;
    placeholder?: string;
    options?: DropdownOption[];
  }>;
}

/**
 * AP `Property.DynamicProperties` exposes an async `props` function whose
 * first argument is `{ auth, ...refresherValues }`. It returns a map of
 * AP property definitions with `type`, `displayName`, `required`, and
 * (for static dropdowns) a pre-resolved `options` object.
 */
interface APDynamicPropsFn {
  (args: { auth: unknown } & Record<string, unknown>): Promise<
    Record<
      string,
      {
        type: string;
        displayName: string;
        required?: boolean;
        description?: string;
        options?: {
          disabled?: boolean;
          options?: Array<{ label: string; value: string | number }>;
        };
        /** Present on ARRAY sub-fields that declare a per-row properties schema */
        properties?: Record<string, APProperty>;
      } | null
    >
  >;
}

const AP_TYPE_MAP: Record<string, ConnectorPropertyType> = {
  SHORT_TEXT: 'string',
  LONG_TEXT: 'string',
  NUMBER: 'number',
  CHECKBOX: 'boolean',
  DROPDOWN: 'dropdown',
  STATIC_DROPDOWN: 'dropdown',
  MULTI_SELECT_DROPDOWN: 'multi_select_dropdown',
  STATIC_MULTI_SELECT_DROPDOWN: 'multi_select_dropdown',
  ARRAY: 'array',
  OBJECT: 'json',
  JSON: 'json',
  DATE_TIME: 'date',
  FILE: 'file',
};

function mapAPSubField(
  name: string,
  apProp: {
    type: string;
    displayName: string;
    required?: boolean;
    description?: string;
    options?: {
      disabled?: boolean;
      options?: Array<{ label: string; value: string | number }>;
    };
    properties?: Record<string, APProperty>;
  },
): DynamicSubField {
  const field: DynamicSubField = {
    name,
    displayName: apProp.displayName,
    type: AP_TYPE_MAP[apProp.type] ?? 'string',
    required: apProp.required ?? false,
  };

  if (apProp.description) field.description = apProp.description;

  const rawOptions = apProp.options?.options;
  if (Array.isArray(rawOptions) && rawOptions.length > 0) {
    field.options = rawOptions.map((o) => ({
      label: o.label,
      value: String(o.value),
    }));
  }

  // ARRAY sub-fields with a properties schema (e.g. Claude extract-structured-data
  // `schema.fields` in simple mode) — map sub-props so the UI can render rows.
  if (apProp.type === 'ARRAY' && apProp.properties && typeof apProp.properties === 'object') {
    field.properties = Object.entries(apProp.properties).map(([subName, subProp]) =>
      mapProperty(subName, subProp),
    );
  }

  return field;
}

/**
 * Fetch a URL and return the AP file shape that pieces expect.
 *
 * `base64` is a lazy getter — it is only computed the first time a piece reads
 * it. Pieces that use only `.data` (Slack, Whisper, Discord, Pipedrive, HubSpot,
 * S3) never trigger the encoding, so peak heap stays at 1× the file size instead
 * of 2.33×. Pieces that do read `.base64` (Jira, Gmail, Salesforce, Google Drive)
 * pay the cost only once and only at the moment they need it.
 */
async function fetchUrlAsApFile(
  url: string,
): Promise<{ data: Buffer; filename: string; extension: string; base64: string }> {
  assertSafeFileUrl(url);

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch file from URL (HTTP ${response.status}): ${url}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_BYTES) {
    throw new Error(`File too large: ${contentLength} bytes exceeds the 25 MB limit`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `File too large after download: ${buffer.byteLength} bytes exceeds the 25 MB limit`,
    );
  }

  let filename = 'file';
  const contentDisposition = response.headers.get('content-disposition');
  if (contentDisposition) {
    const m = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (m) filename = m[1].replace(/^["']|["']$/g, '');
  } else {
    try {
      const segment = new URL(url).pathname.split('/').pop();
      if (segment) filename = decodeURIComponent(segment);
    } catch {
      // keep default
    }
  }

  const extension = filename.includes('.')
    ? (filename.split('.').pop() ?? '')
    : (response.headers.get('content-type')?.split('/').pop()?.split(';')[0] ?? '');

  let _base64: string | undefined;
  return {
    data: buffer,
    filename,
    extension,
    get base64(): string {
      if (_base64 === undefined) _base64 = buffer.toString('base64');
      return _base64;
    },
  };
}

/**
 * Type-driven param coercion — replaces heuristic coerceParams for action execution.
 *
 * AP pieces declare exact property types (FILE, NUMBER, CHECKBOX, ARRAY, JSON, etc.).
 * The UI stores everything as strings. This function reads the AP prop type for each
 * key and converts the value to the shape the piece actually expects:
 *
 *   FILE   + URL string  → { data: Buffer, filename, extension, base64 }
 *   NUMBER + "42"        → 42
 *   CHECKBOX + "true"    → true
 *   ARRAY / JSON /
 *   OBJECT + JSON string → parsed value
 *   MULTI_SELECT_DROPDOWN + JSON string → parsed array
 *   everything else      → string as-is
 *
 * Async because FILE resolution fetches remote bytes.
 */
async function coerceParamsByType(
  propsValue: Record<string, unknown>,
  actionProps: Record<string, APProperty>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...propsValue };

  for (const [name, prop] of Object.entries(actionProps)) {
    if (!prop || typeof prop !== 'object') continue;
    const apType = (prop as { type?: string }).type ?? '';
    const val = result[name];

    // Already the correct type (e.g. already coerced upstream) — skip.
    if (val === undefined || val === null || val === '') continue;

    switch (apType) {
      case 'FILE': {
        if (typeof val === 'string' && val.startsWith('http')) {
          result[name] = await fetchUrlAsApFile(val);
        }
        break;
      }
      case 'NUMBER': {
        if (typeof val === 'string' && val !== '') {
          const n = Number(val);
          if (!Number.isNaN(n)) result[name] = n;
        }
        break;
      }
      case 'CHECKBOX': {
        if (typeof val === 'string') {
          if (val === 'true') result[name] = true;
          else if (val === 'false') result[name] = false;
        }
        break;
      }
      case 'ARRAY': {
        // Parse JSON string → array first
        let arr = val;
        if (typeof val === 'string') {
          const trimmed = val.trim();
          if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
              arr = JSON.parse(trimmed);
            } catch {
              break;
            }
          }
        }
        // If the ARRAY prop declares a per-row properties schema (e.g. Gmail attachments
        // has { file: FILE, name: SHORT_TEXT }), recurse into each row and coerce
        // nested FILE/NUMBER/CHECKBOX fields too — otherwise FILE URLs inside rows
        // stay as strings and the piece reads undefined for .base64 / .data.
        const subProps = (prop as { properties?: Record<string, APProperty> }).properties;
        if (Array.isArray(arr) && subProps && typeof subProps === 'object') {
          result[name] = await Promise.all(
            arr.map((row) => {
              if (!row || typeof row !== 'object') return row;
              return coerceParamsByType(row as Record<string, unknown>, subProps);
            }),
          );
        } else {
          result[name] = arr;
        }
        break;
      }
      case 'JSON':
      case 'OBJECT':
      case 'MULTI_SELECT_DROPDOWN':
      case 'STATIC_MULTI_SELECT_DROPDOWN': {
        if (typeof val === 'string') {
          const trimmed = val.trim();
          if (
            (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
            (trimmed.startsWith('{') && trimmed.endsWith('}'))
          ) {
            try {
              result[name] = JSON.parse(trimmed);
            } catch {
              // Not valid JSON — keep as string; piece will error with a clear message
            }
          }
        }
        break;
      }
      // SHORT_TEXT, LONG_TEXT, DROPDOWN, STATIC_DROPDOWN, DYNAMIC, DATE_TIME:
      // string pass-through is correct.
    }
  }

  return result;
}

function createRuntimeAction(apAction: APAction, pieceName: string): ConnectorAction {
  const props = apAction.props && typeof apAction.props === 'object' ? apAction.props : {};

  // Collect dropdown props that declare a runtime `options` resolver so the
  // action can answer `resolveOptions(propName, ctx)` without re-walking
  // the raw AP property bag on every call.
  const optionsResolvers = new Map<string, APDropdownOptionsFn>();
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    const fn = (prop as { options?: unknown }).options;
    if (
      typeof fn === 'function' &&
      (prop.type === 'DROPDOWN' || prop.type === 'MULTI_SELECT_DROPDOWN')
    ) {
      optionsResolvers.set(name, fn as APDropdownOptionsFn);
    }
  }

  // Collect DynamicProperties props — they have a `props` async function
  // that returns a map of field definitions rather than a flat options list.
  const dynamicPropsResolvers = new Map<string, APDynamicPropsFn>();
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    const fn = (prop as { props?: unknown }).props;
    if (typeof fn === 'function' && (prop as { type?: string }).type === 'DYNAMIC') {
      dynamicPropsResolvers.set(name, fn as APDynamicPropsFn);
    }
  }

  const action: ConnectorAction = {
    name: apAction.name,
    displayName: apAction.displayName,
    description: apAction.description ?? '',
    props: safeMapProps(props),
    async run(ctx: ActionContext): Promise<unknown> {
      const apCtx = translateActionContext(ctx);

      // Type-driven coercion: convert each param to the shape the AP piece expects
      // based on its declared property type (FILE→Buffer, NUMBER→number, etc.).
      // FILE props with URL values are fetched here; base64 is computed lazily.
      apCtx.propsValue = await coerceParamsByType(apCtx.propsValue, props);

      // AP actions expect a run(context) signature
      const runFn = (apAction as unknown as { run: (ctx: unknown) => Promise<unknown> }).run;
      if (typeof runFn !== 'function') {
        throw new Error(`Activepieces action '${apAction.name}' has no run function`);
      }

      return runFn(apCtx);
    },
  };

  if (optionsResolvers.size > 0) {
    action.resolveOptions = async (
      propName: string,
      ctx: ResolveOptionsContext,
    ): Promise<DropdownState> => {
      const fn = optionsResolvers.get(propName);
      if (!fn) {
        throw new Error(`Action '${apAction.name}' has no options resolver for prop '${propName}'`);
      }

      // AP's store wrapper uses `put`/`get`/`delete` with `null` (not undefined)
      // for missing keys — mirror context-translator's wrapStore() contract.
      const apStore = {
        async get<T>(key: string): Promise<T | null> {
          const value = await ctx.store.get<T>(key);
          return value ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          await ctx.store.set(key, value);
        },
        async delete(key: string): Promise<void> {
          await ctx.store.delete(key);
        },
      };

      const result = await fn(
        {
          auth: normalizeAuthForAP(
            ctx.connectorName ?? '',
            (ctx.auth ?? {}) as Record<string, unknown>,
          ),
          ...ctx.propsValue,
        },
        { searchValue: ctx.searchValue, store: apStore },
      );

      return {
        disabled: result.disabled ?? false,
        placeholder: result.placeholder,
        options: Array.isArray(result.options) ? result.options : [],
      };
    };
  }

  if (dynamicPropsResolvers.size > 0) {
    action.resolveDynamicProps = async (
      propName: string,
      ctx: ResolveOptionsContext,
    ): Promise<DynamicPropertiesState> => {
      const fn = dynamicPropsResolvers.get(propName);
      if (!fn) {
        throw new Error(
          `Action '${apAction.name}' has no dynamic props resolver for prop '${propName}'`,
        );
      }

      const rawResult = await fn({
        auth: normalizeAuthForAP(
          ctx.connectorName ?? '',
          (ctx.auth ?? {}) as Record<string, unknown>,
        ),
        ...ctx.propsValue,
      });

      const state: DynamicPropertiesState = {};
      for (const [name, apProp] of Object.entries(rawResult)) {
        if (!apProp) continue;
        state[name] = mapAPSubField(name, apProp);
      }
      return state;
    };
  }

  return action;
}

/**
 * Wrap an Activepieces piece npm module into our Connector interface.
 *
 * @param pieceName - Short name (without @activepieces/piece- prefix)
 * @param pieceExport - The module export from `await import('@activepieces/piece-xyz')`
 */
export function wrapActivepiecesPiece(pieceName: string, pieceExport: unknown): Connector {
  const piece = extractPieceFromExport(pieceExport);

  // AP v0.40+ pieces use lazy getter methods for actions/triggers.
  // Call them with correct `this` context (they access `this._actions` internally).
  const rawActions =
    typeof piece.actions === 'function'
      ? (piece.actions as unknown as () => Record<string, APAction>).call(piece)
      : (piece.actions ?? {});
  const rawTriggers =
    typeof piece.triggers === 'function'
      ? (piece.triggers as unknown as () => Record<string, APTrigger>).call(piece)
      : (piece.triggers ?? {});

  // Structural auth shape is built from the build-time-safe mapAuth. Runtime
  // hooks that hold closures (the piece's auth.validate "test-connection")
  // are attached here, alongside action.run / trigger.run — a single seam
  // for everything that can't be JSON-serialised.
  const structuralAuth = mapAuth(piece.auth);
  const validateAuth = wrapPieceValidate(piece.auth);

  return {
    name: pieceName,
    displayName: piece.displayName,
    version: piece.version ?? '0.0.0',
    description: piece.description ?? '',
    auth: validateAuth ? { ...structuralAuth, validateAuth } : structuralAuth,
    actions: Object.values(rawActions).map((a) => createRuntimeAction(a, pieceName)),
    triggers: Object.values(rawTriggers).map(createRuntimeTrigger),
  };
}
