'use client';

import { useCallback } from 'react';
import { clsx } from 'clsx';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { ChannelTags } from '../specification/ChannelTags';
import { SectionHeader } from './SectionHeader';

interface BusinessSectionProps {
  sessionId: string;
  projectId?: string;
  disabled?: boolean;
  specFallback?: Record<string, unknown>;
  specOverride?: { projectName?: string; description?: string } | null;
}

const LANGUAGE_OPTIONS = [
  'English',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Japanese',
  'Multi-language',
];

/** PUT a field update to the backend; reconcile store from response. */
async function handleFieldChange(
  sessionId: string,
  projectId: string | undefined,
  path: string,
  value: unknown,
) {
  const store = useArchAIStore.getState();
  const snapshot = store.specDocument ? structuredClone(store.specDocument) : null;

  // Optimistic update
  store.updateSpecDocument(path, value, store.specDocumentVersion + 1);

  try {
    const { authHeaders } = await import('@/lib/api-client');
    const url = projectId
      ? `/api/arch-ai/projects/${encodeURIComponent(projectId)}/spec-document`
      : `/api/arch-ai/sessions/${sessionId}/spec-document`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ path, value }] }),
    });
    const json = (await res.json()) as {
      success?: boolean;
      data?: Record<string, unknown>;
    };
    if (json.success && json.data) {
      store.setSpecDocument(json.data);
    } else if (snapshot) {
      store.setSpecDocument(snapshot);
    }
  } catch {
    if (snapshot) store.setSpecDocument(snapshot);
  }
}

export function BusinessSection({
  sessionId,
  projectId,
  disabled,
  specFallback,
  specOverride,
}: BusinessSectionProps) {
  const doc = useArchAIStore((s) => s.specDocument);

  const business = (doc?.business ?? {}) as Record<string, unknown>;
  const fallback = specFallback ?? {};
  const docChannels = Array.isArray(business.channels)
    ? business.channels.filter((value): value is string => typeof value === 'string')
    : [];
  const fallbackChannels = Array.isArray(fallback.channels)
    ? fallback.channels.filter((value): value is string => typeof value === 'string')
    : [];
  const projectName =
    (business.projectName as string) ||
    specOverride?.projectName ||
    (fallback.projectName as string) ||
    '';
  const objective =
    (business.objective as string) ||
    specOverride?.description ||
    (fallback.description as string) ||
    '';
  const channels = docChannels.length > 0 ? docChannels : fallbackChannels;
  const language = (business.language as string) || (fallback.language as string) || '';
  const compliance =
    (business.compliance as Array<{ standard?: string; severity?: string; detail?: string }>) ?? [];
  const constraints = (business.constraints as string[]) ?? [];
  const personas =
    (business.personas as Array<{ name?: string; description?: string; context?: string }>) ?? [];
  const slas = (business.slas as Array<{ metric?: string; target?: string; unit?: string }>) ?? [];
  const edgeCases = (business.edgeCases as string[]) ?? [];
  const notes = (business.notes as Array<{ icon?: string; label?: string; detail?: string }>) ?? [];

  const hasContent = projectName.length > 0 || objective.length > 0;
  const status = hasContent ? 'draft' : 'empty';

  const onFieldChange = useCallback(
    (path: string, value: unknown) => {
      handleFieldChange(sessionId, projectId, path, value);
    },
    [projectId, sessionId],
  );

  return (
    <SectionHeader title="Business" status={status} defaultExpanded>
      <div className="flex flex-col gap-4">
        {/* Project Name */}
        <EditableField
          label="Project Name"
          value={projectName}
          onChange={(v) => onFieldChange('business.projectName', v)}
          placeholder="e.g., Fintech Customer Support"
          required
          disabled={disabled}
        />

        {/* Objective */}
        <EditableField
          label="Objective"
          value={objective}
          onChange={(v) => onFieldChange('business.objective', v)}
          placeholder="What does this project do?"
          multiline
          disabled={disabled}
        />

        {/* Channels */}
        <div>
          <label className="text-xs font-medium text-foreground-muted">Channels</label>
          <ChannelTags
            channels={channels}
            onChange={(ch) => onFieldChange('business.channels', ch)}
            disabled={disabled}
          />
        </div>

        {/* Language */}
        <div>
          <label className="text-xs font-medium text-foreground-muted">Language</label>
          {disabled ? (
            <ReadOnlyValue value={language} fallback="Not captured yet" />
          ) : (
            <select
              value={language}
              onChange={(e) => onFieldChange('business.language', e.target.value)}
              className={clsx(
                'mt-1 w-full rounded-lg border border-border bg-background-elevated px-3 py-2 text-sm outline-none transition-colors',
                'hover:border-foreground-subtle focus:border-accent',
              )}
            >
              <option value="">Select language</option>
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Compliance — read-only list (objects → display strings) */}
        {compliance.length > 0 && (
          <ReadOnlyList
            label="Compliance"
            items={compliance.map(
              (c) => `${c.standard ?? 'Unknown'} (${c.severity ?? '?'}): ${c.detail ?? ''}`,
            )}
          />
        )}

        {/* Constraints — read-only list */}
        {constraints.length > 0 && <ReadOnlyList label="Constraints" items={constraints} />}

        {/* Personas — read-only cards */}
        {personas.length > 0 && (
          <div>
            <label className="text-xs font-medium text-foreground-muted">Personas</label>
            <div className="mt-1.5 flex flex-col gap-2">
              {personas.map((p, i) => (
                <div key={i} className="rounded-lg border border-border/50 px-3 py-2 text-xs">
                  <span className="font-medium text-foreground">
                    {p.name ?? `Persona ${i + 1}`}
                  </span>
                  {p.description && <p className="mt-0.5 text-foreground-muted">{p.description}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SLAs — read-only table */}
        {slas.length > 0 && (
          <div>
            <label className="text-xs font-medium text-foreground-muted">SLAs</label>
            <div className="mt-1.5 overflow-hidden rounded-lg border border-border/50">
              <table className="w-full text-xs">
                <tbody>
                  {slas.map((sla, i) => (
                    <tr key={i} className="border-b border-border/30 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-foreground">
                        {sla.metric ?? `SLA ${i + 1}`}
                      </td>
                      <td className="px-3 py-1.5 text-foreground-muted">
                        {sla.target ?? ''} {sla.unit ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Edge Cases — read-only list */}
        {edgeCases.length > 0 && <ReadOnlyList label="Edge Cases" items={edgeCases} />}

        {/* Notes — read-only list (ConversationNote objects → display strings) */}
        {notes.length > 0 && (
          <ReadOnlyList
            label="Notes"
            items={notes.map((n) => `${n.label ?? ''}: ${n.detail ?? ''}`)}
          />
        )}
      </div>
    </SectionHeader>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function ReadOnlyList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground-muted">{label}</label>
      <ul className="mt-1.5 flex flex-col gap-1">
        {items.map((item, i) => (
          <li
            key={i}
            className="rounded-md border border-border/40 px-3 py-1.5 text-xs text-foreground"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReadOnlyValue({ value, fallback }: { value: string; fallback: string }) {
  return (
    <div className="mt-1 rounded-lg border border-border/50 bg-background-muted/30 px-3 py-2 text-sm text-foreground">
      {value.trim().length > 0 ? value : <span className="text-foreground-subtle">{fallback}</span>}
    </div>
  );
}

interface EditableFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  disabled?: boolean;
}

function EditableField({
  label,
  value,
  onChange,
  placeholder,
  required,
  multiline,
  disabled,
}: EditableFieldProps) {
  const filled = value.trim().length > 0;

  if (disabled) {
    return (
      <div>
        <label className="text-xs font-medium text-foreground-muted">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
        <ReadOnlyValue value={value} fallback={placeholder ?? 'Not captured yet'} />
      </div>
    );
  }

  const sharedClasses = clsx(
    'mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors',
    filled ? 'border-success/50' : 'border-border',
    'focus:border-accent disabled:opacity-50 bg-background-elevated',
  );

  return (
    <div>
      <label className="text-xs font-medium text-foreground-muted">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          maxLength={500}
          className={sharedClasses}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={100}
          className={sharedClasses}
        />
      )}
    </div>
  );
}
