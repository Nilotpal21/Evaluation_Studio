/**
 * Batch Consent Store
 *
 * Session-scoped Zustand store for managing preflight auth consent state.
 * NOT persisted — resets on page refresh / session change.
 */

import { create } from 'zustand';

// =============================================================================
// TYPES
// =============================================================================

/** State of a single connector in the consent flow */
export type ConnectorConsentStatus = 'pending' | 'authorizing' | 'connected' | 'failed' | 'skipped';

/** A connector requiring consent */
export interface ConsentConnector {
  /** Stable requirement identity for mixed connection modes and resolved refs */
  requirementKey: string;
  /** Connector/provider name (e.g., "gmail", "salesforce") */
  connector: string;
  /** Auth profile reference */
  authProfileRef: string;
  /** Stable auth profile identifier when available */
  authProfileId?: string;
  /** Auth profile environment for same-name disambiguation */
  environment?: string | null;
  /** OAuth scopes needed */
  scopes?: string[];
  /** Connection mode */
  connectionMode: 'per_user' | 'shared';
  /** Current status */
  status: ConnectorConsentStatus;
  /** Error message if failed */
  error?: string;
}

interface BatchConsentState {
  /** Whether the consent gate is active */
  active: boolean;
  /** Session ID this consent state is for */
  sessionId: string | null;
  /** All connectors (pending + satisfied) */
  connectors: ConsentConnector[];

  // Actions
  /** Initialize consent state from auth_required event */
  initFromAuthRequired: (
    sessionId: string,
    pending: Array<{
      requirementKey?: string;
      connector: string;
      authProfileRef: string;
      profileId?: string;
      environment?: string | null;
      scopes?: string[];
      connectionMode: 'per_user' | 'shared';
    }>,
    satisfied: Array<{
      requirementKey?: string;
      connector: string;
      authProfileRef: string;
      profileId?: string;
      environment?: string | null;
      scopes?: string[];
      connectionMode: 'per_user' | 'shared';
    }>,
  ) => void;

  /** Update connector status from auth_gate_updated event */
  updateFromGateUpdate: (
    sessionId: string,
    pending: Array<{ requirementKey?: string; authProfileRef: string }>,
    satisfied: Array<{ requirementKey?: string; authProfileRef: string }>,
  ) => void;

  /** Set a connector as authorizing (OAuth popup opened) */
  setAuthorizing: (requirementKeyOrAuthProfileRef: string) => void;

  /** Set a connector as connected */
  setConnected: (requirementKeyOrAuthProfileRef: string) => void;

  /** Set a connector as failed */
  setFailed: (requirementKeyOrAuthProfileRef: string, error: string) => void;

  /** Set a connector as skipped */
  setSkipped: (requirementKeyOrAuthProfileRef: string) => void;

  /** Mark all as satisfied (from auth_gate_satisfied event) */
  markAllSatisfied: (sessionId?: string) => void;

  /** Reset the store */
  reset: () => void;

  // Computed-style getters
  /** Get pending connectors */
  getPending: () => ConsentConnector[];
  /** Get connected count */
  getConnectedCount: () => number;
  /** Get total count */
  getTotalCount: () => number;
}

const initialState = {
  active: false,
  sessionId: null as string | null,
  connectors: [] as ConsentConnector[],
};

function normalizeRequirementKey(params: {
  requirementKey?: string;
  authProfileRef: string;
}): string {
  return params.requirementKey ?? params.authProfileRef;
}

function matchesConnectorIdentity(
  connector: ConsentConnector,
  requirementKeyOrAuthProfileRef: string,
): boolean {
  return connector.requirementKey === requirementKeyOrAuthProfileRef;
}

function matchesGateUpdateIdentity(
  connector: ConsentConnector,
  candidate: {
    requirementKey?: string;
    authProfileRef: string;
  },
): boolean {
  return normalizeRequirementKey(candidate) === connector.requirementKey;
}

export const useBatchConsentStore = create<BatchConsentState>()((set, get) => ({
  ...initialState,

  initFromAuthRequired: (sessionId, pending, satisfied) => {
    const connectors: ConsentConnector[] = [
      ...satisfied.map((s) => ({
        requirementKey: normalizeRequirementKey(s),
        connector: s.connector,
        authProfileRef: s.authProfileRef,
        authProfileId: s.profileId,
        environment: s.environment ?? null,
        scopes: s.scopes,
        connectionMode: s.connectionMode,
        status: 'connected' as const,
      })),
      ...pending.map((p) => ({
        requirementKey: normalizeRequirementKey(p),
        connector: p.connector,
        authProfileRef: p.authProfileRef,
        authProfileId: p.profileId,
        environment: p.environment ?? null,
        scopes: p.scopes,
        connectionMode: p.connectionMode,
        status: 'pending' as const,
      })),
    ];
    set({ active: pending.length > 0, sessionId, connectors });
  },

  updateFromGateUpdate: (sessionId, pending, satisfied) => {
    set((state) => ({
      ...(state.sessionId && state.sessionId !== sessionId
        ? {}
        : {
            connectors: state.connectors.map((c) => {
              if (satisfied.some((s) => matchesGateUpdateIdentity(c, s))) {
                return { ...c, status: 'connected' as const, error: undefined };
              }
              if (pending.some((p) => matchesGateUpdateIdentity(c, p))) {
                // Keep current status if it's authorizing/failed, only reset from connected
                if (c.status === 'connected') {
                  return { ...c, status: 'pending' as const };
                }
              }
              return c;
            }),
            active: pending.length > 0,
          }),
    }));
  },

  setAuthorizing: (requirementKeyOrAuthProfileRef) => {
    set((state) => ({
      connectors: state.connectors.map((c) =>
        matchesConnectorIdentity(c, requirementKeyOrAuthProfileRef)
          ? { ...c, status: 'authorizing' as const }
          : c,
      ),
    }));
  },

  setConnected: (requirementKeyOrAuthProfileRef) => {
    set((state) => ({
      connectors: state.connectors.map((c) =>
        matchesConnectorIdentity(c, requirementKeyOrAuthProfileRef)
          ? { ...c, status: 'connected' as const, error: undefined }
          : c,
      ),
    }));
  },

  setFailed: (requirementKeyOrAuthProfileRef, error) => {
    set((state) => ({
      connectors: state.connectors.map((c) =>
        matchesConnectorIdentity(c, requirementKeyOrAuthProfileRef)
          ? { ...c, status: 'failed' as const, error }
          : c,
      ),
    }));
  },

  setSkipped: (requirementKeyOrAuthProfileRef) => {
    set((state) => ({
      connectors: state.connectors.map((c) =>
        matchesConnectorIdentity(c, requirementKeyOrAuthProfileRef)
          ? { ...c, status: 'skipped' as const }
          : c,
      ),
    }));
  },

  markAllSatisfied: (sessionId) => {
    set((state) => ({
      ...(sessionId && state.sessionId && state.sessionId !== sessionId
        ? {}
        : {
            active: false,
            connectors: state.connectors.map((c) => ({
              ...c,
              status: c.status === 'skipped' ? ('skipped' as const) : ('connected' as const),
              error: undefined,
            })),
          }),
    }));
  },

  reset: () => {
    set(initialState);
  },

  getPending: () => {
    return get().connectors.filter(
      (c) => c.status === 'pending' || c.status === 'authorizing' || c.status === 'failed',
    );
  },

  getConnectedCount: () => {
    return get().connectors.filter((c) => c.status === 'connected').length;
  },

  getTotalCount: () => {
    return get().connectors.length;
  },
}));
