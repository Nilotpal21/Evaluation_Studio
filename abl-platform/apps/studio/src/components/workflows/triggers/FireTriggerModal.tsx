'use client';

/**
 * FireTriggerModal
 *
 * Payload editor for the "Fire Now" action on webhook and app/event triggers.
 * Pre-populates with the last real triggerPayload (fetched on open) so users
 * can re-run with known-good input, or edit to exercise specific branches.
 *
 * Cron triggers bypass this modal — scheduled firings don't carry payloads,
 * so Fire Now on cron fires directly with an empty body.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Play } from 'lucide-react';
import clsx from 'clsx';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { getTriggerSamplePayload, testTriggerSample } from '../../../api/workflows';
import { sanitizeError } from '../../../lib/sanitize-error';
import { workflowInputSample } from '../../../lib/json-schema-sample';

interface FireTriggerModalProps {
  open: boolean;
  onClose: () => void;
  onFire: (payload: Record<string, unknown>) => Promise<void>;
  projectId: string;
  triggerId: string;
  triggerTypeLabel: string;
  /**
   * Workflow's declared inputSchema. When present, the modal pre-populates
   * with a sample derived from the schema (the author-declared contract),
   * taking priority over the last-fire replay so the editor reflects intent
   * rather than history.
   */
  inputSchema?: Record<string, unknown> | null;
  /**
   * If set, the trigger is a connector trigger. When no samplePayload exists
   * yet (trigger never fired), we auto-call testTriggerSample to fetch live
   * data from the connector so the editor is pre-populated on first open.
   */
  connectorName?: string;
}

// Scaffold shown when the trigger has no prior execution — gives users a
// starting shape instead of a bare `{}`. Pure placeholder; submits as an
// empty object if left untouched.
const EMPTY_SCAFFOLD = JSON.stringify({ event: '', data: {} }, null, 2);

export function FireTriggerModal({
  open,
  onClose,
  onFire,
  projectId,
  triggerId,
  triggerTypeLabel,
  inputSchema,
  connectorName,
}: FireTriggerModalProps) {
  const [text, setText] = useState<string>(EMPTY_SCAFFOLD);
  const [loading, setLoading] = useState(false);
  const [firing, setFiring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'live-test' = fetched on-demand via testTriggerSample (never fired before)
  const [source, setSource] = useState<'contract' | 'history' | 'scaffold' | 'live-test'>(
    'scaffold',
  );

  // Pre-populate priority:
  //   1. Schema sample — the workflow's declared contract. If the author has
  //      published one, respect it: the editor should reflect intent, not
  //      drift back to whatever happened to arrive last.
  //   2. Last-fire replay — real data from the most recent execution. Useful
  //      for debugging specific failures when no schema is declared.
  //   3. Empty scaffold — neither source available.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);

    const schemaSample = workflowInputSample(inputSchema);
    if (schemaSample) {
      setText(JSON.stringify(schemaSample, null, 2));
      setSource('contract');
      setLoading(false);
      return;
    }

    setLoading(true);
    setSource('scaffold');

    async function loadPayload() {
      // 1. Try persisted sample (from real execution or previous test)
      try {
        const payload = await getTriggerSamplePayload(projectId, triggerId);
        if (cancelled) return;
        if (payload && Object.keys(payload).length > 0) {
          setText(JSON.stringify(payload, null, 2));
          setSource('history');
          setLoading(false);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        // Fall through to live-test or scaffold so the modal stays usable;
        // surface the underlying error in devtools so a stuck "no sample"
        // state isn't silently invisible.
        console.warn('[FireTriggerModal] getTriggerSamplePayload failed', err);
      }

      // 2. No stored sample — if this is a connector trigger, fetch live data
      if (connectorName) {
        try {
          const result = await testTriggerSample(projectId, triggerId);
          if (cancelled) return;
          if (result.itemCount > 0 && Object.keys(result.sample).length > 0) {
            setText(JSON.stringify(result.sample, null, 2));
            setSource('live-test');
            setLoading(false);
            return;
          }
        } catch (err) {
          if (cancelled) return;
          console.warn('[FireTriggerModal] testTriggerSample failed', err);
        }
      }

      // 3. Nothing available — show placeholder
      if (!cancelled) {
        setText(EMPTY_SCAFFOLD);
        setSource('scaffold');
        setLoading(false);
      }
    }

    void loadPayload();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, triggerId, inputSchema, connectorName]);

  const handleFire = useCallback(async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON payload');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Payload must be a JSON object (e.g. `{ "key": "value" }`)');
      return;
    }
    setFiring(true);
    try {
      await onFire(parsed as Record<string, unknown>);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to fire trigger'));
    } finally {
      setFiring(false);
    }
  }, [text, onFire]);

  const handleReset = useCallback(() => {
    setText('{}');
    setError(null);
  }, []);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xl">
      <div className="flex flex-col">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-foreground">Fire {triggerTypeLabel} Trigger</h3>
          <p className="text-sm text-muted mt-1">
            {source === 'contract'
              ? 'Pre-populated from the workflow\u2019s declared input contract. Edit values to match your test case.'
              : source === 'history'
                ? 'Pre-populated with the last payload this trigger received. Edit before firing if your workflow expects different fields.'
                : source === 'live-test'
                  ? `Live sample fetched from ${connectorName ?? 'the connector'}. Edit before firing if needed.`
                  : loading && connectorName
                    ? `Fetching live sample from ${connectorName}…`
                    : 'No contract or prior executions — using a placeholder. Replace with a realistic payload before firing.'}
          </p>
        </div>

        <label className="text-xs font-medium text-muted mb-1.5" htmlFor="fire-payload-editor">
          Payload (JSON)
        </label>
        <div className="relative">
          <textarea
            id="fire-payload-editor"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={14}
            disabled={loading}
            className={clsx(
              'w-full px-3 py-2 text-xs font-mono rounded-lg border border-default',
              'bg-background-muted text-foreground resize-y',
              'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
              'disabled:opacity-60',
            )}
          />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background-elevated/70 rounded-lg">
              <Loader2 className="w-5 h-5 animate-spin text-muted" />
            </div>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-error">{error}</p>}

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={handleReset} disabled={loading || firing}>
            Reset to empty
          </Button>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose} disabled={firing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Play className="w-4 h-4" />}
              onClick={handleFire}
              loading={firing}
              disabled={loading}
            >
              Fire Now
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
