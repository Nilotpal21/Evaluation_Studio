'use client';

/**
 * EscalationEditor
 *
 * Section editor for agent escalation configuration. Unlike other editors,
 * this manages a single object (not an array) with four sub-sections:
 * - Triggers: conditions that cause escalation to a human
 * - Context for Human: variables/data surfaced during escalation
 * - On Human Complete: actions taken when the human resolves the issue
 * - Routing: agent desktop connection, queue, skills, priority, post-agent action
 */

import { useState, useCallback, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  ArrowUpFromLine,
  AlertTriangle,
  PhoneForwarded,
  Phone,
} from 'lucide-react';
import clsx from 'clsx';
import { Select } from '../../ui/Select';
import { RadioGroup } from '../../ui/RadioGroup';
import type { SectionEditorProps, EscalationSectionData, EscalationRouting } from '../types';
import { SectionHeader } from './SectionHeader';
import { useNavigationStore } from '../../../store/navigation-store';
import { useConnections } from '../../../hooks/useConnections';

// =============================================================================
// CONSTANTS
// =============================================================================

export const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

const PRIORITY_BADGE_COLORS: Record<string, string> = {
  low: 'bg-foreground-muted/15 text-foreground-muted',
  medium: 'bg-info/15 text-info',
  high: 'bg-warning/15 text-warning',
  critical: 'bg-error/15 text-error',
};

// =============================================================================
// STYLE CONSTANTS
// =============================================================================

const INPUT_CLASSES = clsx(
  'w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default',
  'text-foreground placeholder:text-foreground-subtle',
  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus',
  'transition-default',
);

const CARD_CLASSES =
  'rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm';

const ADD_BUTTON_CLASSES = clsx(
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium',
  'text-accent hover:bg-accent-subtle border border-accent/30 transition-default',
);

const REMOVE_BUTTON_CLASSES = clsx(
  'p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default',
);

const TAG_CLASSES = clsx(
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
  'bg-accent/10 text-accent border border-accent/20',
);

// =============================================================================
// FIELD GROUP
// =============================================================================

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-default/50">
      <dt className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// =============================================================================
// SUB-SECTION HEADER
// =============================================================================

function SubSectionHeader({
  title,
  count,
  isExpanded,
  onToggle,
  icon: Icon,
}: {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 py-1.5 text-left group"
    >
      {isExpanded ? (
        <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
      ) : (
        <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
      )}
      <Icon className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
      <span className="text-xs font-semibold text-foreground group-hover:text-accent transition-default">
        {title}
      </span>
      {count > 0 && (
        <span className="text-xs px-1.5 py-0.5 rounded-full bg-foreground-muted/10 text-foreground-muted font-medium">
          {count}
        </span>
      )}
    </button>
  );
}

// =============================================================================
// TRIGGER CARD
// =============================================================================

function TriggerCard({
  trigger,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  readOnly,
}: {
  trigger: EscalationSectionData['triggers'][number];
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: EscalationSectionData['triggers'][number]) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const [tagInput, setTagInput] = useState('');
  const priorityColor = PRIORITY_BADGE_COLORS[trigger.priority] ?? PRIORITY_BADGE_COLORS.medium;

  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim();
    if (trimmed && !(trigger.tags ?? []).includes(trimmed)) {
      onChange({ ...trigger, tags: [...(trigger.tags ?? []), trimmed] });
      setTagInput('');
    }
  }, [tagInput, trigger, onChange]);

  const handleRemoveTag = useCallback(
    (tag: string) => {
      onChange({
        ...trigger,
        tags: (trigger.tags ?? []).filter((t) => t !== tag),
      });
    },
    [trigger, onChange],
  );

  return (
    <div className={CARD_CLASSES}>
      {/* Collapsed header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-background-subtle/50 transition-default"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        )}

        <span className="flex-1 min-w-0">
          <span className="text-xs text-foreground truncate block">
            {trigger.when || `Trigger ${index + 1}`}
          </span>
        </span>

        <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', priorityColor)}>
          {trigger.priority}
        </span>

        {trigger.reason && (
          <span className="text-xs text-foreground-muted truncate max-w-[180px]">
            {trigger.reason}
          </span>
        )}
      </button>

      {/* Expanded edit form */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-default pt-2.5">
          <FieldGroup label="When">
            <textarea
              value={trigger.when}
              onChange={(e) => onChange({ ...trigger, when: e.target.value })}
              placeholder="Condition that triggers escalation"
              rows={2}
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono resize-y')}
            />
          </FieldGroup>

          <FieldGroup label="Reason">
            <input
              type="text"
              value={trigger.reason}
              onChange={(e) => onChange({ ...trigger, reason: e.target.value })}
              placeholder="Why this escalation is needed"
              readOnly={readOnly}
              className={INPUT_CLASSES}
            />
          </FieldGroup>

          <FieldGroup label="Priority">
            <Select
              options={PRIORITY_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
              value={trigger.priority}
              onChange={(v) => onChange({ ...trigger, priority: v })}
              disabled={readOnly}
            />
          </FieldGroup>

          <FieldGroup label="Tags">
            <div className="space-y-2">
              {(trigger.tags ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(trigger.tags ?? []).map((tag) => (
                    <span key={tag} className={TAG_CLASSES}>
                      {tag}
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(tag)}
                          className="hover:text-error transition-default"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    placeholder="Add tag..."
                    className={clsx(INPUT_CLASSES, 'flex-1')}
                  />
                  <button type="button" onClick={handleAddTag} className={ADD_BUTTON_CLASSES}>
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </FieldGroup>

          {!readOnly && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onRemove}
                className={REMOVE_BUTTON_CLASSES}
                aria-label="Remove trigger"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ON HUMAN COMPLETE CARD
// =============================================================================

function OnHumanCompleteCard({
  item,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  readOnly,
}: {
  item: { condition: string; action: string };
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: { condition: string; action: string }) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className={CARD_CLASSES}>
      {/* Collapsed header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-background-subtle/50 transition-default"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        )}

        <span className="flex-1 min-w-0">
          <span className="text-xs text-foreground truncate block">
            {item.condition || `Handler ${index + 1}`}
          </span>
        </span>

        {item.action && (
          <span className="text-xs text-foreground-muted truncate max-w-[180px]">
            {item.action}
          </span>
        )}
      </button>

      {/* Expanded edit form */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-default pt-2.5">
          <FieldGroup label="Condition">
            <input
              type="text"
              value={item.condition}
              onChange={(e) => onChange({ ...item, condition: e.target.value })}
              placeholder="e.g. human_approved"
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono')}
            />
          </FieldGroup>

          <FieldGroup label="Action">
            <input
              type="text"
              value={item.action}
              onChange={(e) => onChange({ ...item, action: e.target.value })}
              placeholder="e.g. continue_flow"
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono')}
            />
          </FieldGroup>

          {!readOnly && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onRemove}
                className={REMOVE_BUTTON_CLASSES}
                aria-label="Remove handler"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// VOICE SETTINGS EDITOR
// =============================================================================

const TRANSFER_METHOD_OPTIONS = ['invite', 'refer', 'bye'] as const;

function VoiceSettingsEditor({
  routing,
  onChange,
  readOnly,
}: {
  routing?: EscalationRouting;
  onChange: (partial: Partial<EscalationRouting>) => void;
  readOnly?: boolean;
}) {
  const [voiceExpanded, setVoiceExpanded] = useState(false);

  const voice = routing?.voice ?? { transferMethod: 'refer' };
  const sipHeadersRecord = voice.sipHeaders ?? {};
  const sipHeaders = Object.entries(sipHeadersRecord).map(([key, value]) => ({ key, value }));

  const updateVoice = (partial: Partial<NonNullable<EscalationRouting['voice']>>) =>
    onChange({ voice: { ...voice, ...partial } });

  const sipHeadersToRecord = (
    entries: Array<{ key: string; value: string }>,
  ): Record<string, string> => {
    const record: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.key) record[entry.key] = entry.value;
    }
    return record;
  };

  const handleAddSipHeader = () => {
    updateVoice({ sipHeaders: sipHeadersToRecord([...sipHeaders, { key: '', value: '' }]) });
  };

  const handleRemoveSipHeader = (index: number) => {
    updateVoice({ sipHeaders: sipHeadersToRecord(sipHeaders.filter((_, i) => i !== index)) });
  };

  const handleSipHeaderChange = (index: number, field: 'key' | 'value', val: string) => {
    const next = [...sipHeaders];
    next[index] = { ...next[index], [field]: val };
    updateVoice({ sipHeaders: sipHeadersToRecord(next) });
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setVoiceExpanded(!voiceExpanded)}
        className="w-full flex items-center gap-2 py-1.5 text-left group"
      >
        {voiceExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        )}
        <Phone className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        <span className="text-xs font-semibold text-foreground group-hover:text-accent transition-default">
          Voice Settings
        </span>
      </button>

      {voiceExpanded && (
        <div className="space-y-2.5 pl-5">
          <FieldGroup label="Transfer Method">
            <Select
              options={TRANSFER_METHOD_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
              value={voice.transferMethod ?? 'refer'}
              onChange={(v) => updateVoice({ transferMethod: v as 'invite' | 'refer' | 'bye' })}
              disabled={readOnly}
            />
          </FieldGroup>

          <FieldGroup label="SIP Headers">
            <div className="space-y-2">
              {sipHeaders.map((header, index) => (
                <div key={index} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={header.key}
                    onChange={(e) => handleSipHeaderChange(index, 'key', e.target.value)}
                    placeholder="Header name"
                    readOnly={readOnly}
                    className={clsx(INPUT_CLASSES, 'flex-1')}
                  />
                  <input
                    type="text"
                    value={header.value}
                    onChange={(e) => handleSipHeaderChange(index, 'value', e.target.value)}
                    placeholder="Header value"
                    readOnly={readOnly}
                    className={clsx(INPUT_CLASSES, 'flex-1')}
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => handleRemoveSipHeader(index)}
                      className={REMOVE_BUTTON_CLASSES}
                      aria-label="Remove SIP header"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button type="button" onClick={handleAddSipHeader} className={ADD_BUTTON_CLASSES}>
                  <Plus className="w-3 h-3" />
                  Add Header
                </button>
              )}
            </div>
          </FieldGroup>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ROUTING EDITOR
// =============================================================================

function RoutingEditor({
  routing,
  onChange,
  readOnly,
}: {
  routing?: EscalationRouting;
  onChange: (r: EscalationRouting | undefined) => void;
  readOnly?: boolean;
}) {
  const { projectId } = useNavigationStore();
  const { connections } = useConnections(projectId);
  const agentDesktopConnections = useMemo(
    () => connections.filter((c) => c.category === 'agent_desktop'),
    [connections],
  );

  const [skillInput, setSkillInput] = useState('');

  const update = (partial: Partial<EscalationRouting>) =>
    onChange({ connectionId: '', postAgentAction: 'return', ...routing, ...partial });

  const handleAddSkill = useCallback(() => {
    const trimmed = skillInput.trim();
    if (trimmed && !(routing?.skills ?? []).includes(trimmed)) {
      update({ skills: [...(routing?.skills ?? []), trimmed] });
      setSkillInput('');
    }
  }, [skillInput, routing, update]);

  const handleRemoveSkill = useCallback(
    (skill: string) => {
      update({ skills: (routing?.skills ?? []).filter((s) => s !== skill) });
    },
    [routing, update],
  );

  return (
    <div className="space-y-2.5 pl-5">
      {/* Connection */}
      <FieldGroup label="Connection">
        {agentDesktopConnections.length > 0 ? (
          <Select
            options={[
              { value: '', label: 'Select agent desktop connection...' },
              ...agentDesktopConnections.map((conn) => ({
                value: conn.id,
                label: conn.displayName || conn.connectorName,
              })),
            ]}
            value={routing?.connectionId ?? ''}
            onChange={(v) => update({ connectionId: v })}
            disabled={readOnly}
          />
        ) : (
          <p className="text-xs text-foreground-subtle italic">
            No agent desktop connections configured. Add one in the Connections page.
          </p>
        )}
      </FieldGroup>

      {/* Queue */}
      <FieldGroup label="Queue">
        <input
          type="text"
          value={routing?.queue ?? ''}
          onChange={(e) => update({ queue: e.target.value || undefined })}
          placeholder="Optional queue name"
          readOnly={readOnly}
          className={INPUT_CLASSES}
        />
      </FieldGroup>

      {/* Skills */}
      <FieldGroup label="Skills">
        <div className="space-y-2">
          {(routing?.skills ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {(routing?.skills ?? []).map((skill) => (
                <span key={skill} className={TAG_CLASSES}>
                  {skill}
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => handleRemoveSkill(skill)}
                      className="hover:text-error transition-default"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {!readOnly && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddSkill();
                  }
                }}
                placeholder="Add skill..."
                className={clsx(INPUT_CLASSES, 'flex-1')}
              />
              <button type="button" onClick={handleAddSkill} className={ADD_BUTTON_CLASSES}>
                <Plus className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </FieldGroup>

      {/* Priority */}
      <FieldGroup label="Priority">
        <input
          type="number"
          min={0}
          max={10}
          value={routing?.priority ?? 5}
          onChange={(e) => update({ priority: Number(e.target.value) })}
          readOnly={readOnly}
          className={clsx(INPUT_CLASSES, 'w-24')}
        />
        <p className="text-xs text-foreground-subtle mt-1">0 (lowest) to 10 (highest)</p>
      </FieldGroup>

      {/* Post-Agent Action */}
      <FieldGroup label="Post-Agent Action">
        <RadioGroup
          options={[
            { value: 'return', label: 'Return to bot' },
            { value: 'end', label: 'End conversation' },
          ]}
          value={routing?.postAgentAction ?? 'return'}
          onChange={(v) => update({ postAgentAction: v as 'return' | 'end' })}
          disabled={readOnly}
        />
      </FieldGroup>

      {/* Voice Settings */}
      <VoiceSettingsEditor routing={routing} onChange={update} readOnly={readOnly} />
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function EscalationEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'escalation'>) {
  const [triggersExpanded, setTriggersExpanded] = useState(true);
  const [contextExpanded, setContextExpanded] = useState(true);
  const [onCompleteExpanded, setOnCompleteExpanded] = useState(true);
  const [routingExpanded, setRoutingExpanded] = useState(false);
  const [expandedTriggerIndex, setExpandedTriggerIndex] = useState<number | null>(null);
  const [expandedCompleteIndex, setExpandedCompleteIndex] = useState<number | null>(null);
  const [contextInput, setContextInput] = useState('');

  // ---------------------------------------------------------------------------
  // Trigger handlers
  // ---------------------------------------------------------------------------

  const handleTriggerChange = useCallback(
    (index: number, updated: EscalationSectionData['triggers'][number]) => {
      const next = [...data.triggers];
      next[index] = updated;
      onChange({ ...data, triggers: next });
    },
    [data, onChange],
  );

  const handleRemoveTrigger = useCallback(
    (index: number) => {
      onChange({
        ...data,
        triggers: data.triggers.filter((_, i) => i !== index),
      });
      if (expandedTriggerIndex === index) {
        setExpandedTriggerIndex(null);
      }
    },
    [data, onChange, expandedTriggerIndex],
  );

  const handleAddTrigger = useCallback(() => {
    onChange({
      ...data,
      triggers: [...data.triggers, { when: '', reason: '', priority: 'medium' }],
    });
    setExpandedTriggerIndex(data.triggers.length);
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Context for human handlers
  // ---------------------------------------------------------------------------

  const handleAddContext = useCallback(() => {
    const trimmed = contextInput.trim();
    if (trimmed && !data.contextForHuman.includes(trimmed)) {
      onChange({
        ...data,
        contextForHuman: [...data.contextForHuman, trimmed],
      });
      setContextInput('');
    }
  }, [contextInput, data, onChange]);

  const handleRemoveContext = useCallback(
    (item: string) => {
      onChange({
        ...data,
        contextForHuman: data.contextForHuman.filter((c) => c !== item),
      });
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // On human complete handlers
  // ---------------------------------------------------------------------------

  const handleOnCompleteChange = useCallback(
    (index: number, updated: { condition: string; action: string }) => {
      const next = [...data.onHumanComplete];
      next[index] = updated;
      onChange({ ...data, onHumanComplete: next });
    },
    [data, onChange],
  );

  const handleRemoveOnComplete = useCallback(
    (index: number) => {
      onChange({
        ...data,
        onHumanComplete: data.onHumanComplete.filter((_, i) => i !== index),
      });
      if (expandedCompleteIndex === index) {
        setExpandedCompleteIndex(null);
      }
    },
    [data, onChange, expandedCompleteIndex],
  );

  const handleAddOnComplete = useCallback(() => {
    onChange({
      ...data,
      onHumanComplete: [...data.onHumanComplete, { condition: '', action: '' }],
    });
    setExpandedCompleteIndex(data.onHumanComplete.length);
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Routing handler
  // ---------------------------------------------------------------------------

  const handleRoutingChange = useCallback(
    (routing: EscalationRouting | undefined) => {
      onChange({ ...data, routing });
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const isEmpty =
    data.triggers.length === 0 &&
    data.contextForHuman.length === 0 &&
    data.onHumanComplete.length === 0 &&
    !data.routing?.connectionId;

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      {isEmpty ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <ArrowUpFromLine className="w-8 h-8 text-foreground-muted/40 mb-3" />
          <p className="text-sm font-medium text-foreground-muted">No escalation configured</p>
          <p className="text-xs text-foreground-subtle mt-1 mb-4">
            Escalation routes conversations to human agents when needed
          </p>
          {!readOnly && (
            <button type="button" onClick={handleAddTrigger} className={ADD_BUTTON_CLASSES}>
              <Plus className="w-3 h-3" />
              Add Trigger
            </button>
          )}
        </div>
      ) : (
        <>
          {/* ----------------------------------------------------------------- */}
          {/* Triggers sub-section                                              */}
          {/* ----------------------------------------------------------------- */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <SubSectionHeader
                title="Triggers"
                count={data.triggers.length}
                isExpanded={triggersExpanded}
                onToggle={() => setTriggersExpanded(!triggersExpanded)}
                icon={AlertTriangle}
              />
              {!readOnly && triggersExpanded && (
                <button type="button" onClick={handleAddTrigger} className={ADD_BUTTON_CLASSES}>
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>

            {triggersExpanded && (
              <div className="space-y-2 pl-5">
                {data.triggers.length > 0 ? (
                  data.triggers.map((trigger, index) => (
                    <TriggerCard
                      key={index}
                      trigger={trigger}
                      index={index}
                      isExpanded={expandedTriggerIndex === index}
                      onToggle={() =>
                        setExpandedTriggerIndex(expandedTriggerIndex === index ? null : index)
                      }
                      onChange={(updated) => handleTriggerChange(index, updated)}
                      onRemove={() => handleRemoveTrigger(index)}
                      readOnly={readOnly}
                    />
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <AlertTriangle className="w-5 h-5 text-foreground-muted/40 mb-2" />
                    <p className="text-xs text-foreground-subtle">No triggers defined</p>
                    <p className="text-xs text-foreground-subtle mt-0.5">
                      Triggers determine when escalation occurs
                    </p>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={handleAddTrigger}
                        className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Trigger
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ----------------------------------------------------------------- */}
          {/* Context for Human sub-section                                     */}
          {/* ----------------------------------------------------------------- */}
          <div className="space-y-2">
            <SubSectionHeader
              title="Context for Human"
              count={data.contextForHuman.length}
              isExpanded={contextExpanded}
              onToggle={() => setContextExpanded(!contextExpanded)}
              icon={ArrowUpFromLine}
            />

            {contextExpanded && (
              <div className="space-y-2 pl-5">
                {data.contextForHuman.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {data.contextForHuman.map((item) => (
                      <span key={item} className={TAG_CLASSES}>
                        <span className="font-mono">{item}</span>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => handleRemoveContext(item)}
                            className="hover:text-error transition-default"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {!readOnly && (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={contextInput}
                      onChange={(e) => setContextInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddContext();
                        }
                      }}
                      placeholder="Add context variable..."
                      className={clsx(INPUT_CLASSES, 'flex-1 font-mono')}
                    />
                    <button type="button" onClick={handleAddContext} className={ADD_BUTTON_CLASSES}>
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {data.contextForHuman.length === 0 && readOnly && (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <ArrowUpFromLine className="w-5 h-5 text-foreground-muted/40 mb-2" />
                    <p className="text-xs text-foreground-subtle">No context variables defined</p>
                    <p className="text-xs text-foreground-subtle mt-0.5">
                      Variables surfaced to the human during escalation
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ----------------------------------------------------------------- */}
          {/* On Human Complete sub-section                                     */}
          {/* ----------------------------------------------------------------- */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <SubSectionHeader
                title="On Human Complete"
                count={data.onHumanComplete.length}
                isExpanded={onCompleteExpanded}
                onToggle={() => setOnCompleteExpanded(!onCompleteExpanded)}
                icon={ArrowUpFromLine}
              />
              {!readOnly && onCompleteExpanded && (
                <button type="button" onClick={handleAddOnComplete} className={ADD_BUTTON_CLASSES}>
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>

            {onCompleteExpanded && (
              <div className="space-y-2 pl-5">
                {data.onHumanComplete.length > 0 ? (
                  data.onHumanComplete.map((item, index) => (
                    <OnHumanCompleteCard
                      key={index}
                      item={item}
                      index={index}
                      isExpanded={expandedCompleteIndex === index}
                      onToggle={() =>
                        setExpandedCompleteIndex(expandedCompleteIndex === index ? null : index)
                      }
                      onChange={(updated) => handleOnCompleteChange(index, updated)}
                      onRemove={() => handleRemoveOnComplete(index)}
                      readOnly={readOnly}
                    />
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <ArrowUpFromLine className="w-5 h-5 text-foreground-muted/40 mb-2" />
                    <p className="text-xs text-foreground-subtle">No completion handlers defined</p>
                    <p className="text-xs text-foreground-subtle mt-0.5">
                      Actions to take when the human resolves the issue
                    </p>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={handleAddOnComplete}
                        className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Handler
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ----------------------------------------------------------------- */}
          {/* Routing sub-section                                               */}
          {/* ----------------------------------------------------------------- */}
          <div className="space-y-2">
            <SubSectionHeader
              icon={PhoneForwarded}
              title="Routing"
              count={data.routing?.connectionId ? 1 : 0}
              isExpanded={routingExpanded}
              onToggle={() => setRoutingExpanded(!routingExpanded)}
            />
            {routingExpanded && (
              <RoutingEditor
                routing={data.routing}
                onChange={handleRoutingChange}
                readOnly={readOnly}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
