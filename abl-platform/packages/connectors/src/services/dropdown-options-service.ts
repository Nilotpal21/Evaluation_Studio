/**
 * DropdownOptionsService
 *
 * Framework-agnostic resolver for an action prop's dynamic dropdown options.
 * Used by Studio (via workflow-engine BFF) to populate `Property.Dropdown`
 * fields at design-time — e.g. the list of Google Sheets the user can pick
 * from once a connection has been selected.
 *
 * Resolution chain:
 *   1. Look up the action on the ConnectorRegistry.
 *   2. Resolve the connection + auth via ConnectionResolver.
 *   3. Call `action.resolveOptions(propName, ctx)` which dispatches to the
 *      underlying adapter (Activepieces today).
 *
 * Used by both Studio (when it imports a lighter proxy) and workflow-engine
 * routes. Lives in `packages/connectors/src/services` alongside
 * ConnectorListingService / ConnectionService — the existing home for
 * framework-agnostic connector services.
 */

import type { ConnectorRegistry } from '../registry.js';
import type {
  DynamicPropertiesState,
  DropdownState,
  KeyValueStore,
  ResolveOptionsContext,
} from '../types.js';
import type { ConnectionResolver } from '../auth/connection-resolver.js';
import { coerceParams, ConnectorConfigError } from '../adapters/activepieces/context-translator.js';
import { createLogger } from '../logger.js';

const log = createLogger('dropdown-options-service');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DropdownOptionsServiceDeps {
  registry: ConnectorRegistry;
  connectionResolver: ConnectionResolver;
}

export interface ResolveActionOptionsInput {
  tenantId: string;
  projectId: string;
  connectorName: string;
  actionName: string;
  propName: string;
  connectionId: string;
  userId?: string;
  propsValue?: Record<string, unknown>;
  searchValue?: string;
}

export interface ResolveTriggerOptionsInput {
  tenantId: string;
  projectId: string;
  connectorName: string;
  triggerName: string;
  propName: string;
  connectionId: string;
  userId?: string;
  propsValue?: Record<string, unknown>;
  searchValue?: string;
}

export interface ResolveActionDynamicPropsInput {
  tenantId: string;
  projectId: string;
  connectorName: string;
  actionName: string;
  propName: string;
  connectionId: string;
  userId?: string;
  propsValue?: Record<string, unknown>;
}

export interface ResolveTriggerDynamicPropsInput {
  tenantId: string;
  projectId: string;
  connectorName: string;
  triggerName: string;
  propName: string;
  connectionId: string;
  userId?: string;
  propsValue?: Record<string, unknown>;
}

// ─── Error ──────────────────────────────────────────────────────────────────

export type DropdownOptionsErrorCode =
  | 'CONNECTOR_NOT_FOUND'
  | 'ACTION_NOT_FOUND'
  | 'TRIGGER_NOT_FOUND'
  | 'PROP_NOT_DYNAMIC'
  | 'PROP_NOT_DYNAMIC_PROPERTIES'
  | 'CONNECTION_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'RESOLVE_FAILED';

export class DropdownOptionsServiceError extends Error {
  constructor(
    message: string,
    public readonly code: DropdownOptionsErrorCode,
  ) {
    super(message);
    this.name = 'DropdownOptionsServiceError';
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * Design-time calls don't have a real workflow execution store, but AP
 * pieces are free to read/write it. A no-op store satisfies the interface
 * without persisting anything — matches how ConnectionService.test() does it.
 */
const noopStore: KeyValueStore = {
  async get() {
    return undefined;
  },
  async set() {
    /* no-op */
  },
  async delete() {
    /* no-op */
  },
};

export class DropdownOptionsService {
  private readonly registry: ConnectorRegistry;
  private readonly connectionResolver: ConnectionResolver;

  constructor(deps: DropdownOptionsServiceDeps) {
    this.registry = deps.registry;
    this.connectionResolver = deps.connectionResolver;
  }

  /**
   * Resolve dropdown options for a specific (connector, action, prop) tuple
   * using credentials from the given connection.
   */
  async resolveActionProp(input: ResolveActionOptionsInput): Promise<DropdownState> {
    if (!input.connectionId) {
      throw new DropdownOptionsServiceError('connectionId is required', 'VALIDATION_ERROR');
    }

    if (!this.registry.has(input.connectorName)) {
      throw new DropdownOptionsServiceError(
        `Connector not found: ${input.connectorName}`,
        'CONNECTOR_NOT_FOUND',
      );
    }

    const action = await this.registry.getAction(input.connectorName, input.actionName);
    if (!action) {
      throw new DropdownOptionsServiceError(
        `Action not found: ${input.connectorName}/${input.actionName}`,
        'ACTION_NOT_FOUND',
      );
    }

    const prop = action.props.find((p) => p.name === input.propName);
    if (!prop) {
      throw new DropdownOptionsServiceError(
        `Prop not found: ${input.propName}`,
        'PROP_NOT_DYNAMIC',
      );
    }

    if (typeof action.resolveOptions !== 'function' || !Array.isArray(prop.refreshers)) {
      throw new DropdownOptionsServiceError(
        `Prop '${input.propName}' on action '${input.actionName}' is not dynamic`,
        'PROP_NOT_DYNAMIC',
      );
    }

    let auth: Record<string, unknown>;
    try {
      const resolved = await this.connectionResolver.resolve({
        connectorName: input.connectorName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        connectionId: input.connectionId,
      });
      auth = await this.connectionResolver.resolveAuth(resolved.connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DropdownOptionsServiceError(message, 'CONNECTION_NOT_FOUND');
    }

    const ctx: ResolveOptionsContext = {
      auth,
      propsValue: coerceParams(input.propsValue ?? {}, { coerceObjects: true }),
      tenantId: input.tenantId,
      projectId: input.projectId,
      store: noopStore,
      searchValue: input.searchValue,
      connectorName: input.connectorName,
    };

    try {
      return await action.resolveOptions(input.propName, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Dropdown options resolver threw', {
        connectorName: input.connectorName,
        actionName: input.actionName,
        propName: input.propName,
        error: message,
      });
      if (err instanceof ConnectorConfigError) {
        throw new DropdownOptionsServiceError(message, 'VALIDATION_ERROR');
      }
      throw new DropdownOptionsServiceError(
        `Failed to resolve options: ${message}`,
        'RESOLVE_FAILED',
      );
    }
  }

  /**
   * Resolve dropdown options for a specific (connector, trigger, prop) tuple
   * using credentials from the given connection.
   */
  async resolveTriggerProp(input: ResolveTriggerOptionsInput): Promise<DropdownState> {
    if (!input.connectionId) {
      throw new DropdownOptionsServiceError('connectionId is required', 'VALIDATION_ERROR');
    }

    if (!this.registry.has(input.connectorName)) {
      throw new DropdownOptionsServiceError(
        `Connector not found: ${input.connectorName}`,
        'CONNECTOR_NOT_FOUND',
      );
    }

    const trigger = await this.registry.getTrigger(input.connectorName, input.triggerName);
    if (!trigger) {
      throw new DropdownOptionsServiceError(
        `Trigger not found: ${input.connectorName}/${input.triggerName}`,
        'TRIGGER_NOT_FOUND',
      );
    }

    const prop = trigger.props.find((p) => p.name === input.propName);
    if (!prop) {
      throw new DropdownOptionsServiceError(
        `Prop not found: ${input.propName}`,
        'PROP_NOT_DYNAMIC',
      );
    }

    if (typeof trigger.resolveOptions !== 'function' || !Array.isArray(prop.refreshers)) {
      throw new DropdownOptionsServiceError(
        `Prop '${input.propName}' on trigger '${input.triggerName}' is not dynamic`,
        'PROP_NOT_DYNAMIC',
      );
    }

    let auth: Record<string, unknown>;
    try {
      const resolved = await this.connectionResolver.resolve({
        connectorName: input.connectorName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        connectionId: input.connectionId,
      });
      auth = await this.connectionResolver.resolveAuth(resolved.connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DropdownOptionsServiceError(message, 'CONNECTION_NOT_FOUND');
    }

    const ctx: ResolveOptionsContext = {
      auth,
      propsValue: coerceParams(input.propsValue ?? {}, { coerceObjects: true }),
      tenantId: input.tenantId,
      projectId: input.projectId,
      store: noopStore,
      searchValue: input.searchValue,
      connectorName: input.connectorName,
    };

    try {
      return await trigger.resolveOptions(input.propName, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Dropdown options resolver threw', {
        connectorName: input.connectorName,
        triggerName: input.triggerName,
        propName: input.propName,
        error: message,
      });
      if (err instanceof ConnectorConfigError) {
        throw new DropdownOptionsServiceError(message, 'VALIDATION_ERROR');
      }
      throw new DropdownOptionsServiceError(
        `Failed to resolve options: ${message}`,
        'RESOLVE_FAILED',
      );
    }
  }

  /**
   * Resolve the DynamicProperties field map for a connector action prop.
   * Returns a Record<fieldName, DynamicSubField> describing each sub-field.
   */
  async resolveActionDynamicProps(
    input: ResolveActionDynamicPropsInput,
  ): Promise<DynamicPropertiesState> {
    if (!input.connectionId) {
      throw new DropdownOptionsServiceError('connectionId is required', 'VALIDATION_ERROR');
    }

    if (!this.registry.has(input.connectorName)) {
      throw new DropdownOptionsServiceError(
        `Connector not found: ${input.connectorName}`,
        'CONNECTOR_NOT_FOUND',
      );
    }

    const action = await this.registry.getAction(input.connectorName, input.actionName);
    if (!action) {
      throw new DropdownOptionsServiceError(
        `Action not found: ${input.connectorName}/${input.actionName}`,
        'ACTION_NOT_FOUND',
      );
    }

    if (typeof action.resolveDynamicProps !== 'function') {
      throw new DropdownOptionsServiceError(
        `Prop '${input.propName}' on action '${input.actionName}' is not a DynamicProperties prop`,
        'PROP_NOT_DYNAMIC_PROPERTIES',
      );
    }

    let auth: Record<string, unknown>;
    try {
      const resolved = await this.connectionResolver.resolve({
        connectorName: input.connectorName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        connectionId: input.connectionId,
      });
      auth = await this.connectionResolver.resolveAuth(resolved.connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DropdownOptionsServiceError(message, 'CONNECTION_NOT_FOUND');
    }

    const ctx: ResolveOptionsContext = {
      auth,
      propsValue: coerceParams(input.propsValue ?? {}, { coerceObjects: true }),
      tenantId: input.tenantId,
      projectId: input.projectId,
      store: noopStore,
      connectorName: input.connectorName,
    };

    try {
      return await action.resolveDynamicProps(input.propName, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('DynamicProperties resolver threw', {
        connectorName: input.connectorName,
        actionName: input.actionName,
        propName: input.propName,
        error: message,
      });
      if (err instanceof ConnectorConfigError) {
        throw new DropdownOptionsServiceError(message, 'VALIDATION_ERROR');
      }
      throw new DropdownOptionsServiceError(
        `Failed to resolve dynamic props: ${message}`,
        'RESOLVE_FAILED',
      );
    }
  }

  /**
   * Resolve the DynamicProperties field map for a connector trigger prop.
   */
  async resolveTriggerDynamicProps(
    input: ResolveTriggerDynamicPropsInput,
  ): Promise<DynamicPropertiesState> {
    if (!input.connectionId) {
      throw new DropdownOptionsServiceError('connectionId is required', 'VALIDATION_ERROR');
    }

    if (!this.registry.has(input.connectorName)) {
      throw new DropdownOptionsServiceError(
        `Connector not found: ${input.connectorName}`,
        'CONNECTOR_NOT_FOUND',
      );
    }

    const trigger = await this.registry.getTrigger(input.connectorName, input.triggerName);
    if (!trigger) {
      throw new DropdownOptionsServiceError(
        `Trigger not found: ${input.connectorName}/${input.triggerName}`,
        'TRIGGER_NOT_FOUND',
      );
    }

    if (typeof trigger.resolveDynamicProps !== 'function') {
      throw new DropdownOptionsServiceError(
        `Prop '${input.propName}' on trigger '${input.triggerName}' is not a DynamicProperties prop`,
        'PROP_NOT_DYNAMIC_PROPERTIES',
      );
    }

    let auth: Record<string, unknown>;
    try {
      const resolved = await this.connectionResolver.resolve({
        connectorName: input.connectorName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        connectionId: input.connectionId,
      });
      auth = await this.connectionResolver.resolveAuth(resolved.connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DropdownOptionsServiceError(message, 'CONNECTION_NOT_FOUND');
    }

    const ctx: ResolveOptionsContext = {
      auth,
      propsValue: coerceParams(input.propsValue ?? {}, { coerceObjects: true }),
      tenantId: input.tenantId,
      projectId: input.projectId,
      store: noopStore,
      connectorName: input.connectorName,
    };

    try {
      return await trigger.resolveDynamicProps(input.propName, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('DynamicProperties resolver threw', {
        connectorName: input.connectorName,
        triggerName: input.triggerName,
        propName: input.propName,
        error: message,
      });
      if (err instanceof ConnectorConfigError) {
        throw new DropdownOptionsServiceError(message, 'VALIDATION_ERROR');
      }
      throw new DropdownOptionsServiceError(
        `Failed to resolve dynamic props: ${message}`,
        'RESOLVE_FAILED',
      );
    }
  }
}
