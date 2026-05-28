'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { HandoffHistoryConfig } from '@abl/core';
import { springs, transitions } from '../../lib/animation';
import { EDGE_COLORS, EDGE_LABELS } from './edges/RelationshipEdge';
import { Checkbox } from '../ui/Checkbox';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface HandoffFormData {
  type: 'handoff';
  when: string;
  return: boolean;
  summary: string;
  pass: string;
  history: HandoffHistoryConfig;
  priority: string;
}

export interface DelegateFormData {
  type: 'delegate';
  when: string;
  purpose: string;
  input: Array<{ key: string; value: string }>;
  returns: Array<{ key: string; value: string }>;
  timeout: string;
}

export type ConnectionFormData = HandoffFormData | DelegateFormData;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConnectionTypePickerProps {
  pendingConnection: {
    source: string;
    target: string;
    editMode?: {
      type: 'handoff' | 'delegate';
      when?: string;
      summary?: string;
      pass?: string;
      history?: HandoffHistoryConfig;
      return?: boolean;
      purpose?: string;
    };
  } | null;
  onSelect: (data: ConnectionFormData) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Shared CSS classes (design-system tokens)
// ---------------------------------------------------------------------------

const INPUT_CLASS =
  'w-full px-2.5 py-1.5 text-xs rounded-md bg-background border border-default text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus transition-default';
const LABEL_CLASS =
  'text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1';
const SECTION_SEPARATOR = 'border-t border-default pt-3 mt-3';

function parseHistorySelection(history: HandoffHistoryConfig | undefined): {
  mode: 'auto' | 'none' | 'summary_only' | 'full' | 'last_n';
  count: string;
} {
  if (!history) {
    return { mode: 'auto', count: '5' };
  }

  if (typeof history === 'object') {
    if (history.mode === 'last_n') {
      return { mode: 'last_n', count: String(history.count ?? 5) };
    }
    return { mode: history.mode, count: '5' };
  }

  const match = history.match(/^last_(\d+)$/);
  if (match) {
    return { mode: 'last_n', count: match[1] };
  }

  if (
    history === 'auto' ||
    history === 'none' ||
    history === 'summary_only' ||
    history === 'full'
  ) {
    return { mode: history, count: '5' };
  }

  return { mode: 'auto', count: '5' };
}

function buildHistorySelection(
  mode: 'auto' | 'none' | 'summary_only' | 'full' | 'last_n',
  count: string,
): HandoffHistoryConfig {
  if (mode === 'last_n') {
    const parsed = Number.parseInt(count, 10);
    return {
      mode: 'last_n',
      count: Number.isFinite(parsed) && parsed > 0 ? parsed : 5,
    };
  }

  return mode;
}
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectionTypePicker({
  pendingConnection,
  onSelect,
  onCancel,
}: ConnectionTypePickerProps) {
  const [selectedType, setSelectedType] = useState<'handoff' | 'delegate' | null>(null);

  // Handoff form state
  const [hWhen, setHWhen] = useState('');
  const [hSummary, setHSummary] = useState('');
  const [hPass, setHPass] = useState('');
  const [hHistoryMode, setHHistoryMode] = useState<
    'auto' | 'none' | 'summary_only' | 'full' | 'last_n'
  >('auto');
  const [hHistoryCount, setHHistoryCount] = useState('5');
  const [hReturn, setHReturn] = useState(true);
  const [hPriority, setHPriority] = useState('');

  // Delegate form state
  const [dWhen, setDWhen] = useState('');
  const [dPurpose, setDPurpose] = useState('');
  const [dInputRows, setDInputRows] = useState<Array<{ key: string; value: string }>>([]);
  const [dReturnRows, setDReturnRows] = useState<Array<{ key: string; value: string }>>([]);
  const [dTimeout, setDTimeout] = useState('');

  // Reset or pre-populate when pendingConnection changes
  const editMode = pendingConnection?.editMode;
  useEffect(() => {
    if (editMode) {
      // Edit mode — skip type selection, pre-populate fields
      setSelectedType(editMode.type);
      if (editMode.type === 'handoff') {
        setHWhen(editMode.when ?? '');
        setHSummary(editMode.summary ?? '');
        setHPass(editMode.pass ?? '');
        const historySelection = parseHistorySelection(editMode.history);
        setHHistoryMode(historySelection.mode);
        setHHistoryCount(historySelection.count);
        setHReturn(editMode.return !== false);
        setHPriority('');
      } else {
        setDWhen(editMode.when ?? '');
        setDPurpose(editMode.purpose ?? '');
        setDInputRows([]);
        setDReturnRows([]);
        setDTimeout('');
      }
    } else {
      // Create mode — reset everything
      setSelectedType(null);
      setHWhen('');
      setHSummary('');
      setHPass('');
      setHHistoryMode('auto');
      setHHistoryCount('5');
      setHReturn(true);
      setHPriority('');
      setDWhen('');
      setDPurpose('');
      setDInputRows([]);
      setDReturnRows([]);
      setDTimeout('');
    }
  }, [pendingConnection, editMode]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  const handleSubmitHandoff = useCallback(() => {
    onSelect({
      type: 'handoff',
      when: hWhen,
      return: hReturn,
      summary: hSummary,
      pass: hPass,
      history: buildHistorySelection(hHistoryMode, hHistoryCount),
      priority: hPriority,
    });
  }, [onSelect, hWhen, hReturn, hSummary, hPass, hHistoryMode, hHistoryCount, hPriority]);

  const handleSubmitDelegate = useCallback(() => {
    onSelect({
      type: 'delegate',
      when: dWhen,
      purpose: dPurpose,
      input: dInputRows.filter((r) => r.key.trim() !== ''),
      returns: dReturnRows.filter((r) => r.key.trim() !== ''),
      timeout: dTimeout,
    });
  }, [onSelect, dWhen, dPurpose, dInputRows, dReturnRows, dTimeout]);

  const containerWidth = selectedType === null ? 280 : 420;

  return (
    <AnimatePresence>
      {pendingConnection && (
        <motion.div
          key="connection-type-picker-backdrop"
          className="fixed inset-0 z-[60] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitions.backdrop}
          onClick={handleBackdropClick}
        >
          <motion.div
            key="connection-type-picker"
            className="bg-background-elevated border border-default rounded-xl shadow-xl px-5 py-4 overflow-hidden"
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0, width: containerWidth }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={springs.default}
            style={{ width: containerWidth }}
          >
            <AnimatePresence mode="wait">
              {/* ========================================================= */}
              {/* STEP 1: Type selection                                     */}
              {/* ========================================================= */}
              {selectedType === null && (
                <motion.div
                  key="step-type"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={transitions.stageSlide}
                >
                  <p className="text-xs text-foreground-muted mb-1">
                    Connect{' '}
                    <span className="text-foreground font-medium">{pendingConnection.source}</span>{' '}
                    to{' '}
                    <span className="text-foreground font-medium">{pendingConnection.target}</span>
                  </p>
                  <p className="text-xs text-foreground-subtle mb-3">Choose a relationship type</p>

                  <div className="space-y-2">
                    <button
                      onClick={() => setSelectedType('handoff')}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-default hover:border-[color:var(--edge-handoff-hover)] bg-background-muted hover:bg-background-elevated transition-default group"
                    >
                      <span className="w-8 flex items-center justify-center">
                        <svg width="24" height="4" viewBox="0 0 24 4" className="shrink-0">
                          <line
                            x1="0"
                            y1="2"
                            x2="24"
                            y2="2"
                            stroke={EDGE_COLORS.handoff}
                            strokeWidth="2.5"
                          />
                        </svg>
                      </span>
                      <span className="text-sm font-medium text-foreground group-hover:text-[color:var(--edge-handoff-hover)]">
                        {EDGE_LABELS.handoff}
                      </span>
                      <span className="ml-auto text-xs text-foreground-subtle">
                        Transfer control
                      </span>
                    </button>

                    <button
                      onClick={() => setSelectedType('delegate')}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-default hover:border-[color:var(--edge-delegate-hover)] bg-background-muted hover:bg-background-elevated transition-default group"
                    >
                      <span className="w-8 flex items-center justify-center">
                        <svg width="24" height="4" viewBox="0 0 24 4" className="shrink-0">
                          <line
                            x1="0"
                            y1="2"
                            x2="24"
                            y2="2"
                            stroke={EDGE_COLORS.delegate}
                            strokeWidth="2.5"
                            strokeDasharray="6 4"
                          />
                        </svg>
                      </span>
                      <span className="text-sm font-medium text-foreground group-hover:text-[color:var(--edge-delegate-hover)]">
                        {EDGE_LABELS.delegate}
                      </span>
                      <span className="ml-auto text-xs text-foreground-subtle">
                        Sub-task &amp; return
                      </span>
                    </button>
                  </div>

                  <button
                    onClick={onCancel}
                    className="w-full mt-3 text-xs text-foreground-muted hover:text-foreground text-center py-1 transition-default"
                  >
                    Cancel
                  </button>
                </motion.div>
              )}

              {/* ========================================================= */}
              {/* STEP 2: Handoff form                                       */}
              {/* ========================================================= */}
              {selectedType === 'handoff' && (
                <motion.div
                  key="step-handoff"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={transitions.stageSlide}
                >
                  <FormHeader
                    type="handoff"
                    source={pendingConnection.source}
                    target={pendingConnection.target}
                  />

                  <div className="space-y-3 mt-3">
                    {/* When */}
                    <div>
                      <label className={LABEL_CLASS}>
                        When <span className="text-error">*</span>
                      </label>
                      <input
                        type="text"
                        value={hWhen}
                        onChange={(e) => setHWhen(e.target.value)}
                        placeholder='intent.category == "payments"'
                        className={INPUT_CLASS}
                      />
                    </div>

                    {/* Priority */}
                    <div>
                      <label className={LABEL_CLASS}>Priority</label>
                      <input
                        type="number"
                        value={hPriority}
                        onChange={(e) => setHPriority(e.target.value)}
                        placeholder="10 (lower = higher priority)"
                        className={INPUT_CLASS}
                      />
                    </div>

                    {/* Summary */}
                    <div>
                      <label className={LABEL_CLASS}>Summary</label>
                      <input
                        type="text"
                        value={hSummary}
                        onChange={(e) => setHSummary(e.target.value)}
                        placeholder="Customer needs payment assistance"
                        className={INPUT_CLASS}
                      />
                    </div>

                    {/* Context section */}
                    <div className={SECTION_SEPARATOR}>
                      <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
                        Context
                      </p>

                      {/* Pass variables */}
                      <div className="mb-3">
                        <label className={LABEL_CLASS}>Pass variables</label>
                        <input
                          type="text"
                          value={hPass}
                          onChange={(e) => setHPass(e.target.value)}
                          placeholder="customer_id, account_type"
                          className={INPUT_CLASS}
                        />
                      </div>

                      {/* History */}
                      <div>
                        <label className={LABEL_CLASS}>History</label>
                        <select
                          value={hHistoryMode}
                          onChange={(e) =>
                            setHHistoryMode(
                              e.target.value as
                                | 'auto'
                                | 'none'
                                | 'summary_only'
                                | 'full'
                                | 'last_n',
                            )
                          }
                          className={INPUT_CLASS}
                        >
                          <option value="auto">auto (default)</option>
                          <option value="full">full</option>
                          <option value="none">none</option>
                          <option value="summary_only">summary_only</option>
                          <option value="last_n">last_n (typed)</option>
                        </select>
                        {hHistoryMode === 'last_n' && (
                          <input
                            type="number"
                            min="1"
                            value={hHistoryCount}
                            onChange={(e) => setHHistoryCount(e.target.value)}
                            placeholder="5"
                            className={`${INPUT_CLASS} mt-2`}
                          />
                        )}
                      </div>
                    </div>

                    {/* Return checkbox */}
                    <Checkbox
                      checked={hReturn}
                      onChange={(checked) => setHReturn(checked)}
                      label="Allow return to source agent"
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between mt-4">
                    <button
                      onClick={() => (editMode ? onCancel() : setSelectedType(null))}
                      className="text-xs text-foreground-muted hover:text-foreground transition-default"
                    >
                      {editMode ? 'Cancel' : 'Back'}
                    </button>
                    <button
                      onClick={handleSubmitHandoff}
                      disabled={hWhen.trim().length === 0}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-default"
                    >
                      {editMode ? 'Save Handoff' : 'Create Handoff'}
                    </button>
                  </div>
                </motion.div>
              )}

              {/* ========================================================= */}
              {/* STEP 2: Delegate form                                      */}
              {/* ========================================================= */}
              {selectedType === 'delegate' && (
                <motion.div
                  key="step-delegate"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={transitions.stageSlide}
                >
                  <FormHeader
                    type="delegate"
                    source={pendingConnection.source}
                    target={pendingConnection.target}
                  />

                  <div className="space-y-3 mt-3">
                    {/* When */}
                    <div>
                      <label className={LABEL_CLASS}>
                        When <span className="text-error">*</span>
                      </label>
                      <input
                        type="text"
                        value={dWhen}
                        onChange={(e) => setDWhen(e.target.value)}
                        placeholder="transfer_amount >= 3000"
                        className={INPUT_CLASS}
                      />
                    </div>

                    {/* Purpose */}
                    <div>
                      <label className={LABEL_CLASS}>
                        Purpose <span className="text-error">*</span>
                      </label>
                      <input
                        type="text"
                        value={dPurpose}
                        onChange={(e) => setDPurpose(e.target.value)}
                        placeholder="Run compliance screening on transfer"
                        className={INPUT_CLASS}
                      />
                    </div>

                    {/* Input Mapping */}
                    <div className={SECTION_SEPARATOR}>
                      <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
                        Input Mapping
                      </p>
                      <KeyValueRows
                        rows={dInputRows}
                        onChange={setDInputRows}
                        keyPlaceholder="context_var"
                        valuePlaceholder="mapped_name"
                      />
                      <button
                        onClick={() => setDInputRows((prev) => [...prev, { key: '', value: '' }])}
                        className="mt-2 text-xs font-medium text-info hover:text-info/80 transition-default"
                      >
                        + Add input
                      </button>
                    </div>

                    {/* Returns Mapping */}
                    <div className={SECTION_SEPARATOR}>
                      <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
                        Returns Mapping
                      </p>
                      <KeyValueRows
                        rows={dReturnRows}
                        onChange={setDReturnRows}
                        keyPlaceholder="result_key"
                        valuePlaceholder="target_var"
                      />
                      <button
                        onClick={() => setDReturnRows((prev) => [...prev, { key: '', value: '' }])}
                        className="mt-2 text-xs font-medium text-info hover:text-info/80 transition-default"
                      >
                        + Add return
                      </button>
                    </div>

                    {/* Timeout */}
                    <div>
                      <label className={LABEL_CLASS}>Timeout</label>
                      <input
                        type="text"
                        value={dTimeout}
                        onChange={(e) => setDTimeout(e.target.value)}
                        placeholder="30s"
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between mt-4">
                    <button
                      onClick={() => (editMode ? onCancel() : setSelectedType(null))}
                      className="text-xs text-foreground-muted hover:text-foreground transition-default"
                    >
                      {editMode ? 'Cancel' : 'Back'}
                    </button>
                    <button
                      onClick={handleSubmitDelegate}
                      disabled={dWhen.trim().length === 0 || dPurpose.trim().length === 0}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-default"
                    >
                      {editMode ? 'Save Delegate' : 'Create Delegate'}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FormHeader({
  type,
  source,
  target,
}: {
  type: 'handoff' | 'delegate';
  source: string;
  target: string;
}) {
  const color = EDGE_COLORS[type];
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 h-0.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="text-sm font-semibold text-foreground">{EDGE_LABELS[type]}</span>
      <span className="text-xs text-foreground-subtle ml-auto">
        <span className="text-foreground font-medium">{source}</span>
        {' \u2192 '}
        <span className="text-foreground font-medium">{target}</span>
      </span>
    </div>
  );
}

function KeyValueRows({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const updateRow = (index: number, field: 'key' | 'value', val: string) => {
    const next = rows.map((r, i) => (i === index ? { ...r, [field]: val } : r));
    onChange(next);
  };

  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  if (rows.length === 0) {
    return <p className="text-xs text-foreground-subtle">No mappings defined.</p>;
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={row.key}
            onChange={(e) => updateRow(i, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            className={INPUT_CLASS + ' flex-1'}
          />
          <span className="text-xs text-foreground-muted shrink-0">{'\u2192'}</span>
          <input
            type="text"
            value={row.value}
            onChange={(e) => updateRow(i, 'value', e.target.value)}
            placeholder={valuePlaceholder}
            className={INPUT_CLASS + ' flex-1'}
          />
          <button
            onClick={() => removeRow(i)}
            className="p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default shrink-0"
            title="Remove row"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
