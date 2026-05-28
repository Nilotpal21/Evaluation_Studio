/**
 * FactStoreWorkflowAdapter (D-5)
 *
 * Composition wrapper around `MongoDBFactStore` that owns the
 * `wf:<workflowId>:<key>` namespace. The adapter is the only caller
 * permitted to set `__originAdapter='workflow'` on `MongoDBFactStore._setInternal`,
 * which bypasses the deep reserved-prefix guard for the `wf:` namespace.
 *
 * Composition (NOT extends) because `MongoDBFactStore` declares private
 * fields (`tenantId`, `userId`, `projectId`, `scope`) and a private
 * `ownerFilter()` method. Subclassing would force visibility changes on
 * those fields purely for one feature; composition keeps the public
 * surface intact and lets us scope an inner store to the project's
 * `__project__` userId sentinel.
 *
 * Friend-class pattern: the adapter is part of the same in-package
 * stores/ directory as `MongoDBFactStore`, so casting to the protected
 * method via `Object.getPrototypeOf(...)` is acceptable. We do not export
 * a public way to bypass the guard.
 */

import type {
  FactStoreConfig,
  Fact,
  SetFactParams,
  GetFactParams,
} from '@abl/compiler/platform/stores/fact-store.js';
import { MongoDBFactStore, PROJECT_SCOPE_USER_ID } from './mongodb-fact-store.js';
import type { SetInternalOptions } from './mongodb-fact-store.js';
import { buildWorkflowKey } from './workflow-memory-constants.js';

export interface SetWorkflowKeyOptions {
  /** Optional explicit TTL override; falls through to `MongoDBFactStore` defaults when omitted. */
  ttlMs?: number;
  /** Tracing source — usually populated by the route layer with runId / traceId. */
  source?: SetFactParams['source'];
  /** Free-form metadata stored alongside the fact. */
  metadata?: SetFactParams['metadata'];
}

/**
 * Friend-class accessor for the protected `_setInternal` method on the
 * inner `MongoDBFactStore`. Confined to this file — no other call site
 * is allowed to bypass the reserved-prefix guard.
 */
type InternalSetInvoker = (params: SetFactParams, options?: SetInternalOptions) => Promise<Fact>;

export class FactStoreWorkflowAdapter {
  private readonly inner: MongoDBFactStore;
  private readonly internalSet: InternalSetInvoker;

  constructor(
    config: FactStoreConfig,
    public readonly tenantId: string,
    public readonly projectId: string,
    public readonly workflowId: string,
  ) {
    // Inner store is project-scope (PROJECT_SCOPE_USER_ID='__project__' sentinel).
    // Workflow-scope facts are global within a project — they must be visible to
    // every end-user calling the workflow.
    this.inner = new MongoDBFactStore(
      config,
      tenantId,
      PROJECT_SCOPE_USER_ID,
      projectId,
      'project',
    );

    // Friend-class bind: the protected `_setInternal` method is exposed via
    // this typed cast. No other call site has access to the marker.
    this.internalSet = (
      this.inner as unknown as {
        _setInternal: InternalSetInvoker;
      }
    )._setInternal.bind(this.inner);
  }

  /**
   * Write a workflow-scope fact.
   *
   * Stored under `wf:<workflowId>:<key>` with `userId='__project__'`.
   */
  async setWorkflowKey(
    key: string,
    value: unknown,
    options: SetWorkflowKeyOptions = {},
  ): Promise<Fact> {
    const storageKey = buildWorkflowKey(this.workflowId, key);
    return this.internalSet(
      {
        key: storageKey,
        value,
        ttlMs: options.ttlMs,
        source: options.source,
        metadata: options.metadata,
      },
      { __originAdapter: 'workflow' },
    );
  }

  /**
   * Read a workflow-scope fact. Returns `null` when missing or tombstoned.
   */
  async getWorkflowKey(key: string): Promise<Fact | null> {
    const storageKey = buildWorkflowKey(this.workflowId, key);
    return this.inner.get({ key: storageKey } as GetFactParams);
  }

  /**
   * Delete a workflow-scope fact. Soft-delete semantics — see
   * `MongoDBFactStore.delete()`. Returns `true` when a live fact was
   * tombstoned, `false` when no live fact existed.
   */
  async deleteWorkflowKey(key: string): Promise<boolean> {
    const storageKey = buildWorkflowKey(this.workflowId, key);
    return this.inner.delete(storageKey);
  }
}
