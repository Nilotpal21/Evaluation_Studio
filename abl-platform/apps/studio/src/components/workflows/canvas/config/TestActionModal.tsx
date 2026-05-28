'use client';

/**
 * TestActionModal
 *
 * Test-run an integration action against the configured connection and capture
 * the output as a design-time sample for the downstream expression context.
 *
 * Prefills params from the node's current config but **does not write back**.
 * Edits inside this modal are scoped to the test run — the persisted node
 * config is never mutated; only `config.sampleOutput` is updated server-side
 * after a successful run so downstream nodes can pre-suggest paths.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Loader2, Play, Info, AlertTriangle, X, Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { ConnectorLogo } from '../../../connections/ConnectorLogo';
import { AuthProfilePicker } from '../../../auth-profiles/AuthProfilePicker';
import { DynamicActionForm } from './DynamicActionForm';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../../store/navigation-store';
import { useAuthProfiles } from '../../../../hooks/useAuthProfiles';
import { useWorkflowExpressionContext } from '../hooks/useWorkflowExpressionContext';
import { testNodeAction } from '../../../../api/workflows';
import { sanitizeError } from '../../../../lib/sanitize-error';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import type { ConnectorProperty } from '@agent-platform/connectors';

interface TestActionModalProps {
  open: boolean;
  nodeId: string | null;
  onClose: () => void;
}

// READ-prefix heuristic — chosen so a misclassification falls open as WRITE
// (warning is shown), which is the safe default.
const READ_PREFIXES = [
  'get_',
  'list_',
  'search_',
  'find_',
  'read_',
  'describe_',
  'count_',
  'check_',
  'fetch_',
];

function classifyAction(actionName: string): 'read' | 'write' {
  const lower = actionName.toLowerCase();
  return READ_PREFIXES.some((p) => lower.startsWith(p)) ? 'read' : 'write';
}

/**
 * Outer wrapper — keeps heavy hooks (useWorkflowExpressionContext,
 * useConnections, etc.) mounted ONLY when the modal is actually open.
 * Without this gate, those hooks fire SWR fetches and state updates on
 * every page render, which can ripple into useRegisterPageHeader's
 * useLayoutEffect deps and trigger "Maximum update depth exceeded".
 */
export function TestActionModal(props: TestActionModalProps) {
  if (!props.open || !props.nodeId) return null;
  return <TestActionModalInner {...props} nodeId={props.nodeId} />;
}

interface TestActionModalInnerProps extends Omit<TestActionModalProps, 'nodeId'> {
  nodeId: string;
}

function TestActionModalInner({ open, nodeId, onClose }: TestActionModalInnerProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const updateNodeConfig = useWorkflowCanvasStore((s) => s.updateNodeConfig);
  const { profiles: authProfiles } = useAuthProfiles(projectId ?? null, {
    status: 'active',
    limit: 100,
  });
  const { triggers, previousSteps } = useWorkflowExpressionContext(nodeId);

  const node = useMemo(() => nodes.find((n) => n.id === nodeId) ?? null, [nodes, nodeId]);

  const connectorId = (node?.data.config?.connectorId as string | undefined) ?? '';
  const actionName = (node?.data.config?.actionName as string | undefined) ?? '';
  const nodeConnectionId = (node?.data.config?.connectionId as string | undefined) ?? '';
  // auth.type='none' connectors are bound to a synthetic `system-<connector>-none`
  // placeholder id by IntegrationNodeConfig. Detect that here so we can skip
  // the picker + the "auth profile required" gate.
  //
  // Charset matches the server-side resolver pattern in
  // `packages/connectors/src/auth/connection-resolver.ts` — both must agree
  // on what a "sentinel" id looks like so the UI hides the picker iff the
  // resolver will accept the sentinel server-side.
  const isNoAuthConnector =
    nodeConnectionId === `system-${connectorId}-none` ||
    /^system-[a-z0-9-]+-none$/.test(nodeConnectionId);

  // Modal-local connection override. Defaults to the node's saved connection,
  // can be switched in the header picker for this test only. NEVER written
  // back to node.config — keeps the test scoped, the node untouched.
  const [connectionId, setConnectionId] = useState<string>(nodeConnectionId);
  // Memoize the prefill objects so the reset effect below doesn't see a new
  // reference on every render — otherwise we loop on its setState calls.
  const nodeParams = useMemo(
    () => (node?.data.config?.params as Record<string, string> | undefined) ?? {},
    [node],
  );
  const nodeParamModes = useMemo(
    () =>
      (node?.data.config?.paramModes as Record<string, 'static' | 'expression'> | undefined) ?? {},
    [node],
  );

  // Local, transient copies — edits here NEVER write back to the node config.
  const [params, setParams] = useState<Record<string, string>>({});
  const [paramModes, setParamModes] = useState<Record<string, 'static' | 'expression'>>({});
  const [actionProps, setActionProps] = useState<ConnectorProperty[]>([]);
  const [actionDisplayName, setActionDisplayName] = useState<string>('');
  const [propsLoading, setPropsLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const category = useMemo(() => (actionName ? classifyAction(actionName) : 'write'), [actionName]);

  const connectionName = useMemo(() => {
    if (!connectionId) return '';
    const matches = authProfiles.filter((p) => p.id === connectionId);
    return matches[0]?.name ?? '';
  }, [authProfiles, connectionId]);

  // Reset state + reseed from node config every time the modal opens for a new node
  useEffect(() => {
    if (!open) return;
    setParams({ ...nodeParams });
    setParamModes({ ...nodeParamModes });
    setOutput(null);
    setError(null);
    setRunning(false);
    setCopied(false);
    setConnectionId(nodeConnectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodeId]);

  // Late-hydration safety net: if the canvas store hadn't loaded `node` yet
  // when the modal mounted, `nodeConnectionId` was '' at initial useState time
  // AND at first reset-effect run. Sync once when the real value appears and
  // the user hasn't yet picked something different.
  useEffect(() => {
    if (open && nodeConnectionId && !connectionId) {
      setConnectionId(nodeConnectionId);
    }
  }, [open, nodeConnectionId, connectionId]);

  // Fetch action prop schema so DynamicActionForm can render the right fields
  useEffect(() => {
    if (!open || !projectId || !connectorId || !actionName) {
      setActionProps([]);
      setActionDisplayName('');
      return;
    }
    let cancelled = false;
    setPropsLoading(true);
    (async () => {
      try {
        const res = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(connectorId)}/actions`,
        );
        const result = await handleResponse<{
          data?: Array<{ name: string; displayName?: string; props?: ConnectorProperty[] }>;
        }>(res);
        if (cancelled) return;
        const action = (result?.data ?? []).find((a) => a.name === actionName);
        setActionProps(action?.props ?? []);
        setActionDisplayName(action?.displayName ?? actionName);
      } catch {
        if (!cancelled) setActionProps([]);
      } finally {
        if (!cancelled) setPropsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, connectorId, actionName]);

  const handleParamChange = useCallback((name: string, value: string) => {
    setParams((prev) => ({ ...prev, [name]: value }));
  }, []);
  const handleModeChange = useCallback((name: string, mode: 'static' | 'expression') => {
    setParamModes((prev) => ({ ...prev, [name]: mode }));
  }, []);

  const handleRun = useCallback(async () => {
    if (!projectId || !workflowId || !node) return;
    setRunning(true);
    setError(null);
    try {
      const result = await testNodeAction(
        projectId,
        workflowId,
        node.id,
        params,
        // Only send override when user picked a different connection than the
        // node's saved one — keeps the request body minimal in the common case.
        connectionId && connectionId !== nodeConnectionId ? connectionId : undefined,
      );
      const out =
        result.output && typeof result.output === 'object'
          ? (result.output as Record<string, unknown>)
          : ({ value: result.output } as Record<string, unknown>);
      setOutput(out);
      // Mirror the persisted sampleOutput into the local store so the
      // expression builder picks it up immediately without a refetch.
      // Note: this only touches `sampleOutput`; the rest of the node config
      // (params, paramModes) is preserved verbatim.
      if (updateNodeConfig) {
        updateNodeConfig(node.id, { ...node.data.config, sampleOutput: out });
      }
    } catch (e) {
      setError(sanitizeError(e, 'Failed to run action'));
    } finally {
      setRunning(false);
    }
  }, [projectId, workflowId, node, params, updateNodeConfig, connectionId, nodeConnectionId]);

  const handleCopyOutput = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(output, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard can fail in iframes / non-secure contexts — silent.
    }
  }, [output]);

  if (!node) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="2xl"
      noBodyWrapper
      className="flex flex-col max-h-[85vh] overflow-hidden"
    >
      <div className="flex flex-col min-h-0 flex-1">
        {/* ── Header (fixed) ─────────────────────────────────────────── */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-default shrink-0">
          {connectorId ? (
            <ConnectorLogo name={connectorId} className="w-9 h-9 shrink-0" />
          ) : (
            <div className="w-9 h-9 rounded-md bg-background-muted shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-foreground truncate">
              Test action: {actionDisplayName || actionName || 'Untitled'}
            </h2>
            <p className="text-xs text-subtle truncate mt-0.5">
              {connectorId
                ? connectorId.charAt(0).toUpperCase() + connectorId.slice(1)
                : 'No connector selected'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-subtle hover:text-foreground p-1 -m-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Status banner (fixed) ───────────────────────────────────
            Banner narrows the test setup state in one line:
              • integration not chosen     → error, Run disabled
              • action not chosen          → error, Run disabled
              • connection not chosen      → error, Run disabled
              • read action, all set       → info, safe to fetch
              • write action, all set      → warning, live side-effects
            Falling open as WRITE on classification miss is intentional. */}
        <div
          className={clsx(
            'flex items-start gap-2 px-5 py-3 text-xs border-b border-default shrink-0',
            !connectorId || !actionName || (!connectionId && !isNoAuthConnector)
              ? 'bg-error-subtle text-error'
              : category === 'write'
                ? 'bg-warning-subtle text-warning'
                : 'bg-info-subtle text-info',
          )}
        >
          {connectorId &&
          actionName &&
          (connectionId || isNoAuthConnector) &&
          category === 'read' ? (
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <div>
            {!connectorId ? (
              <>
                <span className="font-medium">Integration not selected.</span> Configure this node
                with a connector and action before testing.
              </>
            ) : !actionName ? (
              <>
                <span className="font-medium">Action not selected.</span> Pick an action on{' '}
                {connectorId.charAt(0).toUpperCase() + connectorId.slice(1)} in the node
                configuration before testing.
              </>
            ) : !connectionId && !isNoAuthConnector ? (
              <>
                <span className="font-medium">Auth profile required.</span> Select a{' '}
                {connectorId.charAt(0).toUpperCase() + connectorId.slice(1)} auth profile below to
                enable this test.
              </>
            ) : category === 'write' ? (
              <>
                Clicking <span className="font-medium">Run</span> will perform the{' '}
                <span className="font-medium">{actionDisplayName || actionName}</span> action in{' '}
                <span className="font-medium">
                  {connectorId.charAt(0).toUpperCase() + connectorId.slice(1)}
                </span>
                {isNoAuthConnector ? (
                  '.'
                ) : (
                  <>
                    {' '}
                    using your <span className="font-medium">{connectionName}</span> auth profile.
                  </>
                )}
              </>
            ) : (
              <>
                <span className="font-medium">Read-only.</span> Fetches live data from{' '}
                {connectorId.charAt(0).toUpperCase() + connectorId.slice(1)}
                {isNoAuthConnector ? (
                  '; '
                ) : (
                  <>
                    {' '}
                    using your <span className="font-medium">{connectionName}</span> auth
                    profile;{' '}
                  </>
                )}
                nothing is changed.
              </>
            )}
          </div>
        </div>

        {/* ── Form (only scrollable region) ──────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Auth profile field — mirrors the side-panel picker so users see
              the same control they configured the node with. Edits here are
              test-scoped: the node's saved connectionId (auth-profile id) is
              untouched. Hidden for auth.type='none' connectors. */}
          {connectorId && actionName && projectId && !isNoAuthConnector && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
                Auth Profile
              </label>
              <AuthProfilePicker
                projectId={projectId}
                value={connectionId || null}
                onChange={(id) => setConnectionId(id ?? '')}
                connectorName={connectorId}
                strictConnectorMatch
                placeholder={`Select a ${connectorId.charAt(0).toUpperCase() + connectorId.slice(1)} auth profile`}
              />
            </div>
          )}

          {propsLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-subtle">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading action inputs…
            </div>
          ) : actionProps.length > 0 ? (
            <DynamicActionForm
              props={actionProps}
              params={params}
              paramModes={paramModes}
              onParamChange={handleParamChange}
              onModeChange={handleModeChange}
              triggers={triggers}
              previousSteps={previousSteps}
              projectId={projectId ?? undefined}
              connectorName={connectorId || undefined}
              actionName={actionName || undefined}
              connectionId={connectionId || undefined}
            />
          ) : (
            <p className="text-xs text-subtle">
              No action selected. Configure the integration node first.
            </p>
          )}

          {/* ── Output preview ────────────────────────────────────────── */}
          {(output || error) && (
            <div className="pt-3 border-t border-default">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-foreground">
                  {error ? 'Error' : 'Response preview'}
                </p>
                {!error && output && (
                  <button
                    type="button"
                    onClick={() => void handleCopyOutput()}
                    className="flex items-center gap-1 text-xs text-subtle hover:text-foreground transition-colors"
                    aria-label="Copy response"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" /> Copy
                      </>
                    )}
                  </button>
                )}
              </div>
              <pre
                className={clsx(
                  'text-xs p-3 rounded-md overflow-x-auto max-h-64 overflow-y-auto',
                  error ? 'bg-error-subtle text-error' : 'bg-background-muted text-foreground',
                )}
              >
                {error ? error : JSON.stringify(output, null, 2)}
              </pre>
              {!error && (
                <p className="text-xs text-subtle mt-2">
                  Use{' '}
                  <code className="text-foreground bg-background-muted px-1 rounded">
                    {`{{context.steps.${node.data.label}.output}}`}
                  </code>{' '}
                  in downstream nodes.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Footer (fixed) ─────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-default shrink-0">
          <Button variant="ghost" onClick={onClose}>
            {output ? 'Done' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleRun()}
            disabled={running || actionProps.length === 0 || (!connectionId && !isNoAuthConnector)}
          >
            {running ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Running…
              </>
            ) : output ? (
              <>
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Run again
              </>
            ) : category === 'read' ? (
              <>
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Fetch
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Run action
              </>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
