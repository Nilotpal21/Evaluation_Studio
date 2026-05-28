/**
 * Audit Trail Plugin
 *
 * Automatically records write operations on sensitive collections
 * through a registered audit handler. Captures who, what, and when.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Schema } from 'mongoose';

// ─── Actor Context ───────────────────────────────────────────────────────

export interface AuditActorContext {
  userId: string;
  email?: string;
  ip?: string;
  userAgent?: string;
}

const actorStorage = new AsyncLocalStorage<AuditActorContext>();

/**
 * Run a function within an audit actor context.
 * All write operations inside will record this actor.
 */
export function withAuditActor<T>(actor: AuditActorContext, fn: () => T): T {
  return actorStorage.run(actor, fn);
}

/**
 * Get the current audit actor from AsyncLocalStorage.
 */
export function getCurrentAuditActor(): AuditActorContext | undefined {
  return actorStorage.getStore();
}

// ─── Custom Handler ──────────────────────────────────────────────────────

type AuditHandler = (entry: {
  source: 'mongoose-plugin';
  schemaVersion: 1;
  collectionName: string;
  documentId: string;
  operation: string;
  actor?: AuditActorContext;
  changes?: Record<string, unknown>;
  previousValues?: Record<string, unknown>;
  tenantId?: string;
}) => void | Promise<void>;

let customHandler: AuditHandler | null = null;
let missingHandlerWarningEmitted = false;

/**
 * Set a custom audit handler (for testing or external integrations).
 * Passing null clears the registered handler.
 */
export function setAuditHandler(handler: AuditHandler | null): void {
  customHandler = handler;
  if (handler) {
    missingHandlerWarningEmitted = false;
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────

/**
 * Mongoose plugin that records audit trail entries for write operations.
 *
 * Usage:
 *   schema.plugin(auditTrailPlugin);
 */
export function auditTrailPlugin(schema: Schema): void {
  // ── Track isNew before save (Mongoose 8 resets it before post('save')) ──
  // Also capture modified fields now, while modifiedPaths() is still accurate.
  schema.pre('save', function () {
    this.$locals._wasNew = this.isNew;
    this.$locals._wasModified = this.isModified();
    if (!this.isNew && this.isModified()) {
      this.$locals._modifiedChanges = getModifiedFields(this);
    }
  });

  // ── Create / Update ────────────────────────────────────────────────
  schema.post('save', async function () {
    const wasNew = this.$locals._wasNew;
    const wasModified = this.$locals._wasModified;
    if (!wasNew && !wasModified) return;

    const operation = wasNew ? 'create' : 'update';
    const changes =
      operation === 'update'
        ? (this.$locals._modifiedChanges as Record<string, unknown> | undefined)
        : undefined;

    await writeAuditEntry({
      collectionName: (this.constructor as any).collection?.name ?? 'unknown',
      documentId: this._id as string,
      operation,
      tenantId: this.get?.('tenantId') as string | undefined,
      changes,
    });
  });

  // ── Update ─────────────────────────────────────────────────────────
  schema.post('findOneAndUpdate', async function (doc: any) {
    if (!doc) return;
    const maskedFields = getEncryptedFieldsFromSchema(doc);

    await writeAuditEntry({
      collectionName: this.model?.collection?.name ?? 'unknown',
      documentId: doc._id as string,
      operation: 'update',
      tenantId: doc.tenantId,
      changes: sanitizeChanges(this.getUpdate?.() as Record<string, unknown>, maskedFields),
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────
  schema.post('findOneAndDelete', async function (doc: any) {
    if (!doc) return;

    await writeAuditEntry({
      collectionName: this.model?.collection?.name ?? 'unknown',
      documentId: doc._id as string,
      operation: 'delete',
      tenantId: doc.tenantId,
    });
  });
}

// ─── Internal ────────────────────────────────────────────────────────────

async function writeAuditEntry(params: {
  collectionName: string;
  documentId: string;
  operation: string;
  tenantId?: string;
  changes?: Record<string, unknown>;
  previousValues?: Record<string, unknown>;
}): Promise<void> {
  const actor = getCurrentAuditActor();

  if (customHandler) {
    try {
      await customHandler({
        source: 'mongoose-plugin',
        schemaVersion: 1,
        ...params,
        actor,
      });
    } catch {
      // Don't let audit failures break the operation
    }
    return;
  }

  if (!missingHandlerWarningEmitted) {
    missingHandlerWarningEmitted = true;
    process.stderr.write(
      '[AUDIT] No audit handler registered for auditTrailPlugin; entry was dropped. Register a Kafka/ClickHouse audit handler before using audited writes.\n',
    );
  }
}

/**
 * Fields that contain ciphertext and must be masked in audit diffs.
 * Dynamically reads from the encryption plugin's fieldsToEncrypt metadata
 * when available, falls back to a hardcoded set.
 */
const FALLBACK_MASKED_FIELDS = new Set(['encryptedSecrets', 'previousEncryptedSecrets']);

/** Mongoose update operators that contain field-level changes. */
const UPDATE_OPERATORS = new Set([
  '$set',
  '$unset',
  '$setOnInsert',
  '$inc',
  '$min',
  '$max',
  '$mul',
  '$rename',
  '$push',
  '$addToSet',
  '$pull',
  '$pullAll',
  '$pop',
]);

export function isMaskedAuditPath(
  path: string,
  maskedFields: Set<string> = FALLBACK_MASKED_FIELDS,
): boolean {
  for (const field of maskedFields) {
    if (
      path === field ||
      path.startsWith(`${field}.`) ||
      path.endsWith(`.${field}`) ||
      path.includes(`.${field}.`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Sanitize a changes object by redacting encrypted fields.
 * Handles both direct field changes and Mongoose update operators ($set, $unset).
 * Returns undefined when input is undefined.
 */
export function sanitizeChanges(
  changes: Record<string, unknown> | undefined,
  maskedFields: Set<string> = FALLBACK_MASKED_FIELDS,
): Record<string, unknown> | undefined {
  if (!changes) return undefined;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(changes)) {
    if (UPDATE_OPERATORS.has(key) && value && typeof value === 'object') {
      // Recurse into $set / $unset operator objects
      const inner = value as Record<string, unknown>;
      const sanitizedInner: Record<string, unknown> = {};
      for (const [innerKey, innerVal] of Object.entries(inner)) {
        const renameTargetIsMasked =
          key === '$rename' &&
          typeof innerVal === 'string' &&
          isMaskedAuditPath(innerVal, maskedFields);
        sanitizedInner[innerKey] =
          isMaskedAuditPath(innerKey, maskedFields) || renameTargetIsMasked
            ? '[REDACTED]'
            : innerVal;
      }
      sanitized[key] = sanitizedInner;
    } else if (isMaskedAuditPath(key, maskedFields)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function getEncryptedFieldsFromSchema(doc: any): Set<string> {
  const docFields = doc?.fieldsToEncrypt;
  if (Array.isArray(docFields) && docFields.length > 0) {
    return new Set(docFields);
  }

  const schema = doc?.constructor?.schema;
  if (schema) {
    const pathDef = schema.path('fieldsToEncrypt');
    const defaultVal = pathDef?.options?.default;
    if (Array.isArray(defaultVal) && defaultVal.length > 0) {
      return new Set(defaultVal);
    }
  }

  return FALLBACK_MASKED_FIELDS;
}

function getModifiedFields(doc: any): Record<string, unknown> | undefined {
  if (!doc.modifiedPaths) return undefined;

  const paths: string[] = doc.modifiedPaths();
  if (paths.length === 0) return undefined;

  const maskedFields = getEncryptedFieldsFromSchema(doc);

  const changes: Record<string, unknown> = {};
  for (const path of paths) {
    if (path === 'updatedAt' || path === '__v') continue;
    if (isMaskedAuditPath(path, maskedFields)) {
      changes[path] = '[ENCRYPTED]';
    } else {
      changes[path] = doc.get(path);
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}
