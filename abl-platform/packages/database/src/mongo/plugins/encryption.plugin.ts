/**
 * Field-Level Encryption Plugin
 *
 * Encrypts specified fields before save and decrypts them after read using the
 * async TenantEncryptionFacade. Legacy metadata fields (`ire`, `cek`, `iv`,
 * `kmsKeyId`) are retained only so older documents can be detected, stripped
 * from API output, and surfaced as unsupported rather than silently routed
 * through legacy crypto branches.
 *
 * Schema option: { fieldsToEncrypt: ['apiKey', 'secret'] }
 */

import type { Schema } from 'mongoose';

// CONSOLE_WARN_EXCEPTION: packages/database cannot import createLogger from
// @abl/compiler/platform due to circular dependency (database → compiler → database).
// See also: kms-provider-pool.ts which has the same exception.
const log = {
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[encryption-plugin] ${msg}`, meta ?? ''),
};

// ─── Constants ───────────────────────────────────────────────────────────

// ─── Double-Encryption Guard ─────────────────────────────────────────────

function rejectIfAlreadyEncrypted(field: string, value: string, context: string): void {
  if (isAlreadyEncrypted(value)) {
    throw new Error(
      `[encryption-plugin] Double encryption rejected: field '${field}' already contains ` +
        `ciphertext (${context}). Callers must pass plaintext to plugin-managed fields.`,
    );
  }
}

// ─── Master Key Compatibility ────────────────────────────────────────────

let masterKeyBuffer: Buffer | null = null;

/**
 * Set the master encryption key.
 * Must be called before any encryption operations.
 *
 * @param masterKey - 64-character hex string (32 bytes)
 */
export function setMasterKey(masterKey: string): void {
  if (!/^[0-9a-f]{64}$/i.test(masterKey)) {
    throw new Error(
      'ENCRYPTION_MASTER_KEY must be exactly 64 hex characters (32 bytes). ' +
        `Got ${masterKey.length} characters.`,
    );
  }
  masterKeyBuffer = Buffer.from(masterKey, 'hex');
}

// ─── DEK Envelope Encryption Facade ──────────────────────────────────────

import type {
  TenantEncryptionAADContext,
  TenantEncryptionFacade,
} from '@agent-platform/shared-encryption';
import {
  getEncryptionFacade,
  isAlreadyEncrypted,
  setGlobalEncryptionFacade,
  clearGlobalEncryptionFacade,
} from '@agent-platform/shared-encryption';

let encryptionFacade: TenantEncryptionFacade | null = null;

/**
 * Set the DEK encryption facade (preferred encryption path).
 * Must be called at startup after DEKManager is initialized.
 *
 * Also sets globalThis.__encryptionFacade so EncryptionService.encryptForTenant()
 * and decryptForTenantAuto() can use the facade for sync DEK paths without
 * cross-package imports.
 */
export function setEncryptionFacade(facade: TenantEncryptionFacade): void {
  encryptionFacade = facade;
  setGlobalEncryptionFacade(facade);
}

function resolveEncryptionFacade(): TenantEncryptionFacade | null {
  return encryptionFacade ?? getEncryptionFacade() ?? null;
}

/**
 * Check if DEK facade-based encryption is available.
 * Reads from globalThis so all Turbopack module instances share the same answer.
 */
export function isFacadeEncryptionAvailable(): boolean {
  return resolveEncryptionFacade() != null;
}

/**
 * Reset all encryption state (master key + facade).
 * FOR TESTING ONLY — never call in production code.
 */
export function _resetEncryptionStateForTesting(): void {
  masterKeyBuffer = null;
  encryptionFacade = null;
  clearGlobalEncryptionFacade();
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Coerce a field value to a string for decryption.
 * Mongoose stores encrypted strings in Buffer-typed schema fields as BinData,
 * which comes back as a Binary/Buffer object on read. Convert it back to the
 * original encrypted string so the decryption pipeline can process it.
 *
 * Returns the string if coercible, or null if the value is not decryptable.
 */
function coerceToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  // Mongoose Binary objects (from BinData fields) have a .buffer property
  if (value && typeof value === 'object' && 'buffer' in value) {
    const buf = (value as { buffer: Buffer }).buffer;
    if (Buffer.isBuffer(buf)) return buf.toString('utf8');
  }
  return null;
}

function stringifyFieldValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseDecryptedFieldValue(schema: Schema, field: string, value: string): unknown {
  const path = schema.path(field);
  if (!path || path.instance === 'String' || path.instance === 'Buffer') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resolveCollectionName(doc: any, schema: Schema, fallbackCollectionName?: string): string {
  const collectionName =
    doc?.collection?.name ??
    doc?.constructor?.collection?.name ??
    fallbackCollectionName ??
    schema.options.collection;

  if (typeof collectionName === 'string' && collectionName.length > 0) {
    return collectionName;
  }

  throw new Error('[encryption-plugin] Unable to resolve collection name for AAD binding.');
}

function resolveFieldAADContext(
  doc: any,
  schema: Schema,
  field: string,
  fallbackCollectionName?: string,
): TenantEncryptionAADContext {
  return {
    resourceType: resolveCollectionName(doc, schema, fallbackCollectionName),
    fieldName: field,
  };
}

// ─── Plugin ──────────────────────────────────────────────────────────────

export interface EncryptionPluginOptions {
  /** Field names to encrypt on this model */
  fieldsToEncrypt: string[];
  /** Field name to read tenantId from (default: 'tenantId') */
  tenantIdField?: string;
  /** Skip tenant scoping and use the shared/system DEK scope (e.g. User model) */
  skipTenantScoping?: boolean;
  /** DEK scope level: 'tenant' (tenantId only) or 'project' (tenantId + projectId + environment). Optional for backward compat. */
  scope?: 'tenant' | 'project';
  /** Document field mappings for scope resolution. Used with DEK facade encrypt path. */
  scopeFields?: {
    /** Doc field name for tenantId (defaults to tenantIdField or 'tenantId') */
    tenantId?: string;
    /** Doc field name for projectId (project scope only) */
    projectId?: string;
    /** Doc field name for environment (optional — falls back to AsyncLocalStorage then '_shared') */
    environment?: string;
  };
}

/**
 * Resolve DEK scope from document fields and plugin options.
 * Environment resolution order (for project scope):
 *   1. scopeFields.environment configured and field exists on doc → use doc value
 *   2. Else → read from AsyncLocalStorage (set by middleware or BullMQ worker)
 *   3. Else → '_shared' (Decision 7)
 */
function resolveDEKScope(
  doc: any,
  opts: EncryptionPluginOptions,
): { tenantId: string; projectId: string; environment: string } {
  const tenantField = opts.scopeFields?.tenantId ?? opts.tenantIdField ?? 'tenantId';
  const tenantId: string = opts.skipTenantScoping ? 'system' : (doc[tenantField] as string);

  if (!tenantId && !opts.skipTenantScoping) {
    throw new Error(
      `[encryption-plugin] Encryption requires tenantId (field '${tenantField}') on document.`,
    );
  }

  if (!opts.scope || opts.scope === 'tenant') {
    return { tenantId, projectId: '_tenant', environment: '_tenant' };
  }

  // scope === 'project'
  const projectField = opts.scopeFields?.projectId ?? 'projectId';
  const projectId = doc[projectField] as string;
  if (!projectId) {
    // Allow tenant-level DEK fallback only when the document explicitly declares
    // itself as tenant-scoped (e.g., auth_profiles with doc.scope === 'tenant').
    // Without this check, a missing projectId on a project-scoped document would
    // silently downgrade to weaker encryption scope.
    if (doc.scope === 'tenant') {
      return { tenantId, projectId: '_tenant', environment: '_tenant' };
    }
    throw new Error(
      `[encryption-plugin] scope='project' requires '${projectField}' on document but it is missing.`,
    );
  }

  // Environment resolution: doc field → AsyncLocalStorage → '_shared'
  let environment = '_shared';
  if (opts.scopeFields?.environment) {
    const envVal = doc[opts.scopeFields.environment] as string;
    if (envVal) environment = envVal;
  }
  if (environment === '_shared') {
    try {
      const { getEncryptionEnvironment } = require('@agent-platform/shared-encryption');
      const alsEnv = getEncryptionEnvironment();
      if (alsEnv) environment = alsEnv;
    } catch {
      // shared-encryption not available — keep '_shared'
    }
  }

  return { tenantId, projectId, environment };
}

/**
 * Mongoose plugin for field-level encryption.
 *
 * Usage:
 *   schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey', 'secret'] });
 */
export function encryptionPlugin(schema: Schema, options: EncryptionPluginOptions): void {
  const { fieldsToEncrypt, tenantIdField = 'tenantId', skipTenantScoping = false } = options;

  if (!fieldsToEncrypt.length) return;

  // Add encryption metadata fields to the schema (required for strict mode)
  schema.add({
    ire: { type: String },
    iv: { type: String },
    cek: { type: String },
    kmsKeyId: { type: String }, // KMS key ID used for CEK wrapping (ire='v2')
    fieldsToEncrypt: { type: [String], default: [] },
  });

  // ── Auto-encrypt bulk writes ───────────────────────────────────────
  schema.pre('insertMany', async function (next, docs: any[]) {
    const modelCollectionName = (this as any)?.collection?.name as string | undefined;
    // DEK facade-based encryption (async)
    const facade = resolveEncryptionFacade();
    if (facade) {
      for (const doc of docs) {
        // Skip already-encrypted docs (no ire field means could be DEK envelope or plaintext)
        const hasPlaintext = fieldsToEncrypt.some((field) => {
          const val = doc[field];
          return val !== undefined && val !== null;
        });
        if (!hasPlaintext) continue;

        let dekScope: { tenantId: string; projectId: string; environment: string };
        try {
          dekScope = resolveDEKScope(doc, options);
        } catch (scopeErr) {
          // If scope resolution fails (e.g. missing projectId), check if there are fields to encrypt
          for (const field of fieldsToEncrypt) {
            if (doc[field] !== undefined && doc[field] !== null) {
              return next(scopeErr instanceof Error ? scopeErr : new Error(String(scopeErr)));
            }
          }
          continue;
        }
        if (!dekScope.tenantId && !skipTenantScoping) {
          for (const field of fieldsToEncrypt) {
            if (doc[field] !== undefined && doc[field] !== null) {
              return next(
                new Error(
                  `[encryption-plugin] insertMany requires tenantId for encryption of field '${field}'.`,
                ),
              );
            }
          }
          continue;
        }

        for (const field of fieldsToEncrypt) {
          const value = doc[field];
          if (value !== undefined && value !== null) {
            const strValue = stringifyFieldValue(value);
            rejectIfAlreadyEncrypted(field, strValue, 'insertMany/facade');
            doc[field] = await facade.encrypt(
              strValue,
              dekScope,
              resolveFieldAADContext(doc, schema, field, modelCollectionName),
            );
          }
        }
        // DEK envelope has no metadata fields
        doc.ire = undefined;
        doc.fieldsToEncrypt = undefined;
      }
      return next();
    }

    const hasEncryptedFields = docs.some((doc) =>
      fieldsToEncrypt.some((field) => doc[field] !== undefined && doc[field] !== null),
    );
    if (hasEncryptedFields) {
      return next(
        new Error(
          '[encryption-plugin] Encrypted fields require the DEK facade. ' +
            'Legacy tenant encryption fallback paths are disabled.',
        ),
      );
    }
    next();
  });

  type QueryUpdateErrorSource = {
    field: string;
    operator: string;
  };

  function findEncryptedFieldQueryUpdate(update: unknown): QueryUpdateErrorSource | null {
    if (!update) return null;

    // Aggregation-pipeline updates are too dynamic to prove safe for encrypted fields.
    if (Array.isArray(update)) {
      return {
        field: fieldsToEncrypt[0],
        operator: 'update pipeline',
      };
    }

    if (typeof update !== 'object') return null;
    const updateRecord = update as Record<string, unknown>;
    const hasOperator = Object.keys(updateRecord).some((key) => key.startsWith('$'));

    if (!hasOperator) {
      for (const field of fieldsToEncrypt) {
        if (updateRecord[field] !== undefined) {
          return {
            field,
            operator: 'replacement',
          };
        }
      }
      return null;
    }

    for (const [operator, payload] of Object.entries(updateRecord)) {
      if (!operator.startsWith('$') || !payload || typeof payload !== 'object') continue;

      const payloadRecord = payload as Record<string, unknown>;

      if (operator === '$rename') {
        for (const [sourceField, targetField] of Object.entries(payloadRecord)) {
          if (fieldsToEncrypt.includes(sourceField)) {
            return {
              field: sourceField,
              operator,
            };
          }
          if (typeof targetField === 'string' && fieldsToEncrypt.includes(targetField)) {
            return {
              field: targetField,
              operator,
            };
          }
        }
        continue;
      }

      for (const field of fieldsToEncrypt) {
        if (payloadRecord[field] !== undefined) {
          return {
            field,
            operator,
          };
        }
      }
    }

    return null;
  }

  function buildUnsafeQueryUpdateError(method: string, source: QueryUpdateErrorSource): Error {
    return new Error(
      `[encryption-plugin] Cannot ${method} with encrypted field '${source.field}' ` +
        `(via ${source.operator}). Load the document and call save() so ` +
        'encryption middleware can re-encrypt plaintext safely.',
    );
  }

  function rejectEncryptedFieldQueryUpdates(method: string) {
    return function (this: any, next: (err?: Error) => void) {
      const source = findEncryptedFieldQueryUpdate(this.getUpdate());
      if (source) {
        return next(buildUnsafeQueryUpdateError(method, source));
      }
      next();
    };
  }

  schema.pre('updateOne', rejectEncryptedFieldQueryUpdates('updateOne'));
  schema.pre('updateMany', rejectEncryptedFieldQueryUpdates('updateMany'));
  schema.pre('findOneAndUpdate', rejectEncryptedFieldQueryUpdates('findOneAndUpdate'));
  schema.pre('replaceOne', rejectEncryptedFieldQueryUpdates('replaceOne'));

  const stripEncryptionMeta = (_doc: any, ret: any) => {
    delete ret.ire;
    delete ret.cek;
    delete ret.iv;
    delete ret.kmsKeyId;
    delete ret.fieldsToEncrypt;
    delete ret._decryptionFailed;
    return ret;
  };
  schema.set('toJSON', { transform: stripEncryptionMeta });
  schema.set('toObject', { transform: stripEncryptionMeta });

  // ── Track decrypted values to detect real modifications ──────────
  const decryptedValuesKey = Symbol('decryptedValues');

  // ── Pre-save: encrypt fields ───────────────────────────────────────
  schema.pre('save', async function () {
    // Skip if no fields to encrypt
    const hasPlaintext = fieldsToEncrypt.some((field) => {
      const val = this.get(field);
      return val !== undefined && val !== null && !this.get('ire');
    });

    // Re-encrypt if any encrypted fields were explicitly modified by the caller.
    // Compare current values against what the post-find hook decrypted —
    // if they differ, the caller changed the field and we must re-encrypt.
    const decryptedValues: Map<string, unknown> = (this as any)[decryptedValuesKey] ?? new Map();
    const modified = fieldsToEncrypt.some((field) => {
      if (!this.isModified(field)) return false;
      // If we have the original decrypted value, only count as modified
      // if the current value actually differs
      if (decryptedValues.has(field)) {
        return this.get(field) !== decryptedValues.get(field);
      }
      return true;
    });

    if (!hasPlaintext && !modified) return;

    if (!isFacadeEncryptionAvailable()) {
      throw new Error(
        'Cannot save: encrypted fields require the DEK facade. ' +
          'Legacy tenant encryption fallback paths are disabled.',
      );
    }

    // ── DEK: Facade-based encryption (preferred path) ─────────────────
    const facade = resolveEncryptionFacade();
    if (facade) {
      // Resolve DEK scope from document fields + plugin options
      const docObj = this.toObject ? this.toObject() : this;
      const dekScope = resolveDEKScope(docObj, options);
      if (!dekScope.tenantId && !skipTenantScoping) {
        const tenantField = options.scopeFields?.tenantId ?? tenantIdField;
        throw new Error(`Encryption requires ${tenantField} but it is not set on the document`);
      }

      // Encrypt all fields via facade
      const encrypted = new Map<string, string>();
      for (const field of fieldsToEncrypt) {
        const value = this.get(field);
        if (value !== undefined && value !== null) {
          const strValue = stringifyFieldValue(value);
          // Facade has built-in double-encryption guard
          const ciphertext = await facade.encrypt(
            strValue,
            dekScope,
            resolveFieldAADContext(this, schema, field),
          );
          encrypted.set(field, ciphertext);
        }
      }

      // Apply all at once
      for (const [field, value] of encrypted) {
        this.set(field, value);
      }

      // DEK envelope has no legacy metadata fields (DEK ID is embedded in ciphertext)
      this.set('ire', undefined);
      this.set('cek', undefined);
      this.set('iv', undefined);
      this.set('kmsKeyId', undefined);
      this.set('fieldsToEncrypt', undefined);
      return;
    }
  });

  // ── Post-find: decrypt fields ──────────────────────────────────────
  const decryptDoc = async (doc: any) => {
    if (!doc) return;

    try {
      const fields: string[] =
        doc.fieldsToEncrypt && doc.fieldsToEncrypt.length > 0
          ? doc.fieldsToEncrypt
          : fieldsToEncrypt;
      const decryptedMap = new Map<string, unknown>();

      // ── DEK envelope path ────────────────────────
      // Documents encrypted with DEK envelope have NO ire field (DEK ID is embedded in ciphertext).
      const facade = resolveEncryptionFacade();
      if (!doc.ire && facade) {
        const tenantId = skipTenantScoping ? 'system' : doc[tenantIdField];
        if (!tenantId && !skipTenantScoping) {
          // tenantId not in projection — skip decryption, leave raw values
          // for callers that decrypt manually (e.g. SecretsProvider, llm-wiring)
          return;
        }

        for (const field of fields) {
          const raw = doc[field];
          if (raw !== undefined && raw !== null) {
            const encrypted = coerceToString(raw);
            const looksEncrypted = encrypted !== null && isAlreadyEncrypted(encrypted);
            if (!looksEncrypted) {
              const preservedValue =
                encrypted === null ? raw : parseDecryptedFieldValue(schema, field, encrypted);
              doc[field] = preservedValue;
              decryptedMap.set(field, preservedValue);
              if (typeof doc.unmarkModified === 'function') {
                doc.unmarkModified(field);
              }
              continue;
            }

            try {
              // Facade handles format detection plus ordered AAD compatibility fallbacks.
              const decrypted = await facade.decrypt(
                encrypted,
                tenantId,
                resolveFieldAADContext(doc, schema, field),
              );
              const parsedValue = parseDecryptedFieldValue(schema, field, decrypted);
              doc[field] = parsedValue;
              decryptedMap.set(field, parsedValue);
              if (typeof doc.unmarkModified === 'function') {
                doc.unmarkModified(field);
              }
            } catch (fieldErr) {
              log.warn('Field decryption failed (facade) — nulling field to prevent leakage', {
                docId: doc._id,
                field,
                collection: doc.collection?.name,
                valueLength: encrypted.length,
                valuePrefix: encrypted.substring(0, 20),
                error: fieldErr instanceof Error ? fieldErr.message : String(fieldErr),
              });
              doc[field] = null;
              doc._decryptionFailed = true;
            }
          }
        }

        if (decryptedMap.size > 0) {
          (doc as any)[decryptedValuesKey] = decryptedMap;
        }
        return;
      }

      if (doc.ire || doc.cek) {
        const metadata: Record<string, unknown> = {
          docId: doc._id,
          collection:
            doc?.collection?.name ??
            doc?.constructor?.collection?.name ??
            (schema.options.collection as string | undefined),
          ire: doc.ire,
          hasCek: !!doc.cek,
          hasIv: !!doc.iv,
          hasKmsKeyId: !!doc.kmsKeyId,
        };
        for (const field of fields) {
          const raw = doc[field];
          if (raw !== undefined && raw !== null) {
            doc[field] = null;
            doc._decryptionFailed = true;
          }
        }
        log.warn('Legacy encrypted document encountered — nulling encrypted fields', metadata);
      }

      if (decryptedMap.size > 0) {
        (doc as any)[decryptedValuesKey] = decryptedMap;
      }
    } catch (outerErr) {
      log.warn(
        'decryptDoc failed (catastrophic) — nulling encrypted fields to prevent state corruption',
        {
          docId: doc?._id,
          error: outerErr instanceof Error ? outerErr.message : String(outerErr),
        },
      );
      // Null out all encrypted fields to prevent ciphertext leaking to consumers
      for (const field of fieldsToEncrypt) {
        if (doc[field] !== undefined && doc[field] !== null) {
          doc[field] = null;
        }
      }
      doc._decryptionFailed = true;
    }
  };

  schema.post('find', async function (docs: any[]) {
    await Promise.all(docs.map(decryptDoc));
  });

  schema.post('findOne', async function (doc: any) {
    await decryptDoc(doc);
  });

  schema.post('findOneAndUpdate', async function (doc: any) {
    await decryptDoc(doc);
  });

  schema.post('findOneAndDelete', async function (doc: any) {
    await decryptDoc(doc);
  });
}
