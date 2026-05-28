'use client';

/**
 * MemorySettingsPanel — slide-over panel for managing Arch memories.
 *
 * Two tabs:
 *  1. "Arch Learnings" — workspace-wide learned patterns (tenant-scoped + global)
 *  2. "Project Memory" — per-project decisions and patterns (only in IN_PROJECT mode)
 *
 * Supports viewing, inline editing, and deleting memory entries.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import {
  X,
  Trash2,
  Pencil,
  Check,
  XCircle,
  Plus,
  Brain,
  FolderOpen,
  ChevronDown,
} from 'lucide-react';
import { authHeaders } from '@/lib/api-client';

// ─── Types ────────────────────────────────────────────────────────────────

/** Mirrors LearningMemoryType from @agent-platform/database — defined locally to avoid
 *  importing the mongoose-dependent database package in client-side code. */
type LearningMemoryType = 'error_fix' | 'topology_pattern' | 'construct_usage' | 'model_preference';

interface LearningEntry {
  _id: string;
  type: LearningMemoryType;
  pattern: string;
  resolution: string;
  confidence: number;
  observationCount: number;
  domain?: string;
  agentRole?: string;
  construct?: string;
  tenantId?: string;
  firstSeen: string;
  lastSeen: string;
}

interface ProjectMemoryEntry {
  id: string;
  type: string;
  content: string;
  source: string;
  phase: string;
  sessionId: string;
  createdAt: string;
  relevance: number;
}

type TabKey = 'learnings' | 'project';

// ─── Constants ────────────────────────────────────────────────────────────

const LEARNING_TYPE_CONFIG: Record<string, { label: string; className: string }> = {
  error_fix: {
    label: 'Error Fix',
    className: 'border-error/40 bg-error/10 text-error',
  },
  topology_pattern: {
    label: 'Topology',
    className: 'border-info/40 bg-info/10 text-info',
  },
  construct_usage: {
    label: 'Construct',
    className: 'border-success/40 bg-success/10 text-success',
  },
  model_preference: {
    label: 'Model Pref',
    className: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
  },
};

const MEMORY_TYPE_CONFIG: Record<string, { label: string; className: string }> = {
  decision: {
    label: 'Decision',
    className: 'border-info/40 bg-info/10 text-info',
  },
  pattern: {
    label: 'Pattern',
    className: 'border-success/40 bg-success/10 text-success',
  },
  preference: {
    label: 'Preference',
    className: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
  },
  constraint: {
    label: 'Constraint',
    className: 'border-warning/40 bg-warning/10 text-warning',
  },
  learning: {
    label: 'Learning',
    className: 'border-accent/40 bg-accent/10 text-accent',
  },
};

const ADD_MEMORY_TYPES = [
  { value: 'decision', label: 'Decision' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'preference', label: 'Preference' },
  { value: 'constraint', label: 'Constraint' },
  { value: 'learning', label: 'Learning' },
] as const;

// ─── Props ────────────────────────────────────────────────────────────────

interface MemorySettingsPanelProps {
  mode?: string;
  projectId?: string;
  onClose: () => void;
}

// ─── Sub-components ───────────────────────────────────────────────────────

function TypeBadge({
  type,
  config,
}: {
  type: string;
  config: Record<string, { label: string; className: string }>;
}) {
  const entry = config[type] ?? {
    label: type,
    className: 'border-border bg-muted text-foreground-muted',
  };
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide',
        entry.className,
      )}
    >
      {entry.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-foreground-muted">{pct}%</span>
    </div>
  );
}

function DeleteConfirmation({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-foreground-muted">Delete?</span>
      <button
        onClick={onConfirm}
        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-error transition-colors hover:bg-error/10"
      >
        Yes
      </button>
      <button
        onClick={onCancel}
        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-muted"
      >
        No
      </button>
    </div>
  );
}

function InlineEditField({
  value,
  onSave,
  onCancel,
  multiline,
}: {
  value: string;
  onSave: (val: string) => void;
  onCancel: () => void;
  multiline?: boolean;
}) {
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onSave(text.trim());
    }
    if (e.key === 'Escape') onCancel();
  };

  const commonClass =
    'w-full rounded border border-accent/40 bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-accent/40';

  if (multiline) {
    return (
      <div className="flex items-start gap-1">
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className={clsx(commonClass, 'resize-none')}
        />
        <div className="flex flex-col gap-0.5">
          <button
            onClick={() => text.trim() && onSave(text.trim())}
            className="rounded p-0.5 text-success transition-colors hover:bg-success/10"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onClick={onCancel}
            className="rounded p-0.5 text-foreground-muted transition-colors hover:bg-muted"
          >
            <XCircle className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className={commonClass}
      />
      <button
        onClick={() => text.trim() && onSave(text.trim())}
        className="rounded p-0.5 text-success transition-colors hover:bg-success/10"
      >
        <Check className="h-3 w-3" />
      </button>
      <button
        onClick={onCancel}
        className="rounded p-0.5 text-foreground-muted transition-colors hover:bg-muted"
      >
        <XCircle className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

export function MemorySettingsPanel({ mode, projectId, onClose }: MemorySettingsPanelProps) {
  const hasProject = mode === 'IN_PROJECT' && !!projectId;
  const [activeTab, setActiveTab] = useState<TabKey>('learnings');

  // Learnings state
  const [learnings, setLearnings] = useState<LearningEntry[]>([]);
  const [learningsLoading, setLearningsLoading] = useState(false);

  // Project memories state
  const [memories, setMemories] = useState<ProjectMemoryEntry[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Add memory form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addContent, setAddContent] = useState('');
  const [addType, setAddType] = useState<string>('decision');
  const addInputRef = useRef<HTMLTextAreaElement>(null);

  // ─── Data fetching ──────────────────────────────────────────────────────

  const fetchLearnings = useCallback(async () => {
    setLearningsLoading(true);
    try {
      const res = await fetch('/api/arch-ai/memories/learnings', {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setLearnings(data.learnings ?? []);
      }
    } finally {
      setLearningsLoading(false);
    }
  }, []);

  const fetchMemories = useCallback(async () => {
    if (!projectId) return;
    setMemoriesLoading(true);
    try {
      const res = await fetch(`/api/arch-ai/memories/project?projectId=${projectId}`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setMemories(data.memories ?? []);
      }
    } finally {
      setMemoriesLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (activeTab === 'learnings') {
      void fetchLearnings();
    } else if (activeTab === 'project' && projectId) {
      void fetchMemories();
    }
  }, [activeTab, projectId, fetchLearnings, fetchMemories]);

  // ─── Learning CRUD ──────────────────────────────────────────────────────

  const updateLearning = useCallback(
    async (learningId: string, updates: Record<string, unknown>) => {
      const res = await fetch('/api/arch-ai/memories/learnings', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ learningId, updates }),
      });
      if (res.ok) {
        const data = await res.json();
        setLearnings((prev) =>
          prev.map((l) => (l._id === learningId ? { ...l, ...data.learning } : l)),
        );
      }
      setEditingId(null);
      setEditingField(null);
    },
    [],
  );

  const deleteLearning = useCallback(async (learningId: string) => {
    const res = await fetch('/api/arch-ai/memories/learnings', {
      method: 'DELETE',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ learningId }),
    });
    if (res.ok) {
      setLearnings((prev) => prev.filter((l) => l._id !== learningId));
    }
    setDeletingId(null);
  }, []);

  // ─── Project memory CRUD ────────────────────────────────────────────────

  const updateMemory = useCallback(
    async (memoryId: string, updates: Record<string, unknown>) => {
      if (!projectId) return;
      const res = await fetch('/api/arch-ai/memories/project', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, memoryId, updates }),
      });
      if (res.ok) {
        setMemories((prev) => prev.map((m) => (m.id === memoryId ? { ...m, ...updates } : m)));
      }
      setEditingId(null);
      setEditingField(null);
    },
    [projectId],
  );

  const deleteMemory = useCallback(
    async (memoryId: string) => {
      if (!projectId) return;
      const res = await fetch('/api/arch-ai/memories/project', {
        method: 'DELETE',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, memoryId }),
      });
      if (res.ok) {
        setMemories((prev) => prev.filter((m) => m.id !== memoryId));
      }
      setDeletingId(null);
    },
    [projectId],
  );

  const addMemory = useCallback(async () => {
    if (!projectId || !addContent.trim()) return;
    const res = await fetch('/api/arch-ai/memories/project', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, content: addContent.trim(), type: addType }),
    });
    if (res.ok) {
      const data = await res.json();
      setMemories((prev) => [...prev, data.memory]);
      setAddContent('');
      setShowAddForm(false);
    }
  }, [projectId, addContent, addType]);

  // Focus add input when form opens
  useEffect(() => {
    if (showAddForm) {
      setTimeout(() => addInputRef.current?.focus(), 100);
    }
  }, [showAddForm]);

  // ─── Render ─────────────────────────────────────────────────────────────

  const tabs: { key: TabKey; label: string; icon: typeof Brain }[] = [
    { key: 'learnings', label: 'Arch Learnings', icon: Brain },
    ...(hasProject
      ? [{ key: 'project' as TabKey, label: 'Project Memory', icon: FolderOpen }]
      : []),
  ];

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="memory-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />

      {/* Panel */}
      <motion.div
        key="memory-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-border bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <h2 className="text-sm font-semibold text-foreground">Memory Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-border px-5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => {
                  setActiveTab(tab.key);
                  setEditingId(null);
                  setEditingField(null);
                  setDeletingId(null);
                }}
                className={clsx(
                  'flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-foreground-muted hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'learnings' && (
            <LearningsTab
              learnings={learnings}
              loading={learningsLoading}
              editingId={editingId}
              editingField={editingField}
              deletingId={deletingId}
              onEdit={(id, field) => {
                setEditingId(id);
                setEditingField(field);
              }}
              onSaveEdit={updateLearning}
              onCancelEdit={() => {
                setEditingId(null);
                setEditingField(null);
              }}
              onDeleteRequest={(id) => setDeletingId(id)}
              onDeleteConfirm={deleteLearning}
              onDeleteCancel={() => setDeletingId(null)}
            />
          )}

          {activeTab === 'project' && hasProject && (
            <ProjectMemoryTab
              memories={memories}
              loading={memoriesLoading}
              editingId={editingId}
              editingField={editingField}
              deletingId={deletingId}
              showAddForm={showAddForm}
              addContent={addContent}
              addType={addType}
              addInputRef={addInputRef}
              onToggleAddForm={() => setShowAddForm((v) => !v)}
              onAddContentChange={setAddContent}
              onAddTypeChange={setAddType}
              onAddSubmit={addMemory}
              onEdit={(id, field) => {
                setEditingId(id);
                setEditingField(field);
              }}
              onSaveEdit={updateMemory}
              onCancelEdit={() => {
                setEditingId(null);
                setEditingField(null);
              }}
              onDeleteRequest={(id) => setDeletingId(id)}
              onDeleteConfirm={deleteMemory}
              onDeleteCancel={() => setDeletingId(null)}
            />
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Learnings Tab ────────────────────────────────────────────────────────

function LearningsTab({
  learnings,
  loading,
  editingId,
  editingField,
  deletingId,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  learnings: LearningEntry[];
  loading: boolean;
  editingId: string | null;
  editingField: string | null;
  deletingId: string | null;
  onEdit: (id: string, field: string) => void;
  onSaveEdit: (id: string, updates: Record<string, unknown>) => void;
  onCancelEdit: () => void;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (learnings.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <Brain className="h-8 w-8 text-foreground-muted/40" />
        <div>
          <p className="text-sm font-medium text-foreground-muted">No learnings yet</p>
          <p className="mt-1 text-xs text-foreground-muted/60">
            Arch collects patterns automatically as you build agents. Learnings improve
            recommendations over time.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <p className="mb-3 px-1 text-[11px] text-foreground-muted/60">
        Knowledge Arch has learned across all projects
      </p>
      <div className="space-y-2">
        {learnings.map((learning) => (
          <div
            key={learning._id}
            className="group rounded-lg border border-border bg-background-subtle p-3 transition-colors hover:border-border/80"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <TypeBadge type={learning.type} config={LEARNING_TYPE_CONFIG} />
                {learning.domain && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
                    {learning.domain}
                  </span>
                )}
                {learning.construct && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
                    {learning.construct}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {deletingId === learning._id ? (
                  <DeleteConfirmation
                    onConfirm={() => onDeleteConfirm(learning._id)}
                    onCancel={onDeleteCancel}
                  />
                ) : (
                  <>
                    <button
                      onClick={() => onEdit(learning._id, 'pattern')}
                      className="rounded p-1 text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
                      title="Edit"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => onDeleteRequest(learning._id)}
                      className="rounded p-1 text-foreground-muted transition-colors hover:bg-error/10 hover:text-error"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-2 space-y-1.5">
              {/* Pattern */}
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted/50">
                  Pattern
                </span>
                {editingId === learning._id && editingField === 'pattern' ? (
                  <InlineEditField
                    value={learning.pattern}
                    onSave={(val) => onSaveEdit(learning._id, { pattern: val })}
                    onCancel={onCancelEdit}
                  />
                ) : (
                  <p className="text-xs text-foreground/80">{learning.pattern}</p>
                )}
              </div>

              {/* Resolution */}
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted/50">
                  Resolution
                </span>
                {editingId === learning._id && editingField === 'resolution' ? (
                  <InlineEditField
                    value={learning.resolution}
                    onSave={(val) => onSaveEdit(learning._id, { resolution: val })}
                    onCancel={onCancelEdit}
                    multiline
                  />
                ) : (
                  <p
                    className="cursor-pointer text-xs text-foreground/80 hover:text-foreground"
                    onClick={() => onEdit(learning._id, 'resolution')}
                  >
                    {learning.resolution}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between">
              <ConfidenceBar value={learning.confidence} />
              <span className="text-[10px] text-foreground-muted/50">
                Seen {learning.observationCount} time{learning.observationCount !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Project Memory Tab ───────────────────────────────────────────────────

function ProjectMemoryTab({
  memories,
  loading,
  editingId,
  editingField,
  deletingId,
  showAddForm,
  addContent,
  addType,
  addInputRef,
  onToggleAddForm,
  onAddContentChange,
  onAddTypeChange,
  onAddSubmit,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  memories: ProjectMemoryEntry[];
  loading: boolean;
  editingId: string | null;
  editingField: string | null;
  deletingId: string | null;
  showAddForm: boolean;
  addContent: string;
  addType: string;
  addInputRef: React.RefObject<HTMLTextAreaElement | null>;
  onToggleAddForm: () => void;
  onAddContentChange: (val: string) => void;
  onAddTypeChange: (val: string) => void;
  onAddSubmit: () => void;
  onEdit: (id: string, field: string) => void;
  onSaveEdit: (id: string, updates: Record<string, unknown>) => void;
  onCancelEdit: () => void;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center justify-between px-1">
        <p className="text-[11px] text-foreground-muted/60">
          Decisions and patterns for this project
        </p>
        <button
          onClick={onToggleAddForm}
          className={clsx(
            'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            showAddForm
              ? 'bg-muted text-foreground'
              : 'text-foreground-muted hover:bg-muted hover:text-foreground',
          )}
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>

      {/* Add Memory Form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] font-medium text-foreground-muted">Type:</span>
                <div className="relative">
                  <select
                    value={addType}
                    onChange={(e) => onAddTypeChange(e.target.value)}
                    className="appearance-none rounded border border-border bg-background py-0.5 pl-2 pr-6 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-accent/40"
                  >
                    {ADD_MEMORY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-foreground-muted" />
                </div>
              </div>
              <textarea
                ref={addInputRef}
                value={addContent}
                onChange={(e) => onAddContentChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onAddSubmit();
                  }
                  if (e.key === 'Escape') onToggleAddForm();
                }}
                rows={2}
                placeholder="Describe the decision, pattern, or constraint..."
                className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-foreground-muted/40 outline-none focus:ring-1 focus:ring-accent/40"
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  onClick={onToggleAddForm}
                  className="rounded px-2.5 py-1 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={onAddSubmit}
                  disabled={!addContent.trim()}
                  className={clsx(
                    'rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground transition-opacity',
                    addContent.trim() ? 'hover:opacity-90' : 'cursor-not-allowed opacity-40',
                  )}
                >
                  Add Memory
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {memories.length === 0 && !showAddForm ? (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <FolderOpen className="h-8 w-8 text-foreground-muted/40" />
          <div>
            <p className="text-sm font-medium text-foreground-muted">No memories yet</p>
            <p className="mt-1 text-xs text-foreground-muted/60">
              Memories are saved automatically during project creation. You can also add them
              manually.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map((memory) => (
            <div
              key={memory.id}
              className="group rounded-lg border border-border bg-background-subtle p-3 transition-colors hover:border-border/80"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TypeBadge type={memory.type} config={MEMORY_TYPE_CONFIG} />
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      memory.source === 'user'
                        ? 'bg-accent/10 text-accent'
                        : 'bg-muted text-foreground-muted',
                    )}
                  >
                    {memory.source}
                  </span>
                  {memory.phase && memory.phase !== 'manual' && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
                      {memory.phase}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {deletingId === memory.id ? (
                    <DeleteConfirmation
                      onConfirm={() => onDeleteConfirm(memory.id)}
                      onCancel={onDeleteCancel}
                    />
                  ) : (
                    <>
                      <button
                        onClick={() => onEdit(memory.id, 'content')}
                        className="rounded p-1 text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => onDeleteRequest(memory.id)}
                        className="rounded p-1 text-foreground-muted transition-colors hover:bg-error/10 hover:text-error"
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-2">
                {editingId === memory.id && editingField === 'content' ? (
                  <InlineEditField
                    value={memory.content}
                    onSave={(val) => onSaveEdit(memory.id, { content: val })}
                    onCancel={onCancelEdit}
                    multiline
                  />
                ) : (
                  <p
                    className="cursor-pointer text-xs leading-relaxed text-foreground/80 hover:text-foreground"
                    onClick={() => onEdit(memory.id, 'content')}
                  >
                    {memory.content}
                  </p>
                )}
              </div>

              <div className="mt-2 flex items-center justify-between">
                <ConfidenceBar value={memory.relevance} />
                <span className="text-[10px] text-foreground-muted/50">
                  {new Date(memory.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
