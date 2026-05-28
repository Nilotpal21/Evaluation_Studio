'use client';

/**
 * UserAssigneePicker
 *
 * Selector for workflow human/data-entry node assignees.
 *
 * - Fetches project members from /api/projects/:projectId/members
 * - Stores user IDs (UUIDs) in the workflow config
 * - Displays selected assignees as chips showing their email
 * - Lets the user search and pick members from a card list
 * - Handles legacy email-based config values by rendering the email
 *   directly on the chip so older workflows still display correctly
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { X, Search, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { useNavigationStore } from '../../../../store/navigation-store';

interface ProjectMember {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
}

interface MembersResponse {
  success: boolean;
  members: ProjectMember[];
}

interface UserAssigneePickerProps {
  /** Currently selected assignees — userIds going forward, may contain legacy emails. */
  value: string[];
  /** Called whenever the selection changes with the new list of userIds. */
  onChange: (assignees: string[]) => void;
  label?: string;
  placeholder?: string;
}

export function UserAssigneePicker({
  value,
  onChange,
  label = 'Assignees',
  placeholder = 'Search people to assign…',
}: UserAssigneePickerProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useSWR<MembersResponse>(
    projectId ? `/api/projects/${projectId}/members` : null,
    async (url: string) => {
      const res = await apiFetch(url);
      return handleResponse<MembersResponse>(res);
    },
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  const members = data?.members ?? [];

  // userId → member lookup for chip label resolution
  const byId = useMemo(() => {
    const map: Record<string, ProjectMember> = {};
    for (const m of members) map[m.userId] = m;
    return map;
  }, [members]);

  // Members not already selected, filtered by search query (email or name)
  const available = useMemo(() => {
    const selected = new Set(value);
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => !selected.has(m.userId))
      .filter((m) => {
        if (!q) return true;
        return (
          (m.email && m.email.toLowerCase().includes(q)) ||
          (m.name && m.name.toLowerCase().includes(q))
        );
      });
  }, [members, value, search]);

  const addAssignee = useCallback(
    (userId: string) => {
      if (!userId || value.includes(userId)) return;
      onChange([...value, userId]);
      setSearch('');
    },
    [value, onChange],
  );

  const removeAssignee = useCallback(
    (assignee: string) => {
      onChange(value.filter((a) => a !== assignee));
    },
    [value, onChange],
  );

  /**
   * Prune unresolvable userIds from `value` once members have loaded.
   *
   * When a project member is deleted, their userId can linger in the node
   * config and render as "Unknown user (…)". Rather than showing that stub
   * chip, we drop the stale id from `value` during resolution. Legacy email
   * strings are preserved because they still render meaningfully.
   *
   * Guards:
   * - Wait for the members fetch to resolve (`data` truthy) so we do not
   *   mistakenly drop ids during the loading window.
   * - Skip when `members` is empty, since that happens for projects with no
   *   members yet and dropping everything would be destructive — we only
   *   prune when we have a members list to validate against.
   */
  useEffect(() => {
    if (!data) return;
    if (members.length === 0) return;
    if (value.length === 0) return;

    const cleaned = value.filter((v) => {
      if (byId[v]) return true; // still a valid member
      if (v.includes('@')) return true; // legacy email — keep
      return false; // unresolvable userId — drop
    });

    // Compare contents, not just length — parents typically pass an inline
    // arrow for `onChange`, so this effect re-runs on every parent render.
    // A length-only guard would miss same-length-different-IDs swaps and
    // could loop indefinitely if `cleaned` ever diverges from `value` while
    // retaining the same length.
    const changed = cleaned.length !== value.length || cleaned.some((v, i) => v !== value[i]);
    if (changed) {
      onChange(cleaned);
    }
  }, [data, members.length, byId, value, onChange]);

  // Dropdown is tied to the search input's focus state:
  // - Opens on focus
  // - Closes on blur (see `onBlur` below)
  // Member buttons use `onMouseDown={e.preventDefault()}` to avoid blurring the
  // input when clicked, which would otherwise dismiss the dropdown before the
  // click registers on the button.

  /**
   * Chip label + state:
   * - `resolved` → show the member email or legacy email verbatim
   * - `loading`  → members fetch is still in flight; avoid flashing an
   *                "Unknown user" label while the lookup hasn't completed
   * - `unknown`  → members have loaded and this id doesn't match anyone
   *                (only visible briefly before the prune effect removes it)
   */
  const resolveChip = (
    assignee: string,
  ): { label: string; state: 'resolved' | 'loading' | 'unknown' } => {
    const member = byId[assignee];
    if (member) return { label: member.email || member.name || assignee, state: 'resolved' };
    if (assignee.includes('@')) return { label: assignee, state: 'resolved' };
    if (!data) return { label: 'Loading…', state: 'loading' };
    return { label: `Unknown user (${assignee.slice(0, 8)}…)`, state: 'unknown' };
  };

  return (
    <div className="space-y-1.5" data-testid="user-assignee-picker">
      {label && <label className="block text-sm font-medium text-foreground">{label}</label>}

      {/* Selected assignees as chips.
          Once members have loaded, filter out userIds that no longer resolve
          to a project member (and are not legacy emails) so the user never
          sees an "Unknown user" chip — the pruning effect above will also
          update the stored config to remove them.
          During the members fetch we keep every chip visible but render a
          neutral "Loading…" label so we never flash "Unknown user" at the
          user just because the API hasn't returned yet. */}
      {(() => {
        const visibleChips = value.filter((assignee) => {
          if (!data) return true; // still loading — show everything
          if (byId[assignee]) return true;
          if (assignee.includes('@')) return true;
          return false;
        });
        if (visibleChips.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1.5" data-testid="assignee-chips">
            {visibleChips.map((assignee) => {
              const { label, state } = resolveChip(assignee);
              return (
                <span
                  key={assignee}
                  className={clsx(
                    'inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full text-xs',
                    'bg-background-subtle border border-default text-foreground',
                    state === 'loading' && 'animate-pulse text-muted italic',
                  )}
                  data-testid={`assignee-chip-${assignee}`}
                  data-state={state}
                >
                  <span className="truncate max-w-[180px]">{label}</span>
                  <button
                    type="button"
                    onClick={() => removeAssignee(assignee)}
                    className="rounded-full hover:bg-muted p-0.5 text-muted hover:text-foreground transition-default"
                    aria-label={`Remove ${label}`}
                    data-testid={`assignee-chip-remove-${assignee}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        );
      })()}

      {/* Search input + floating member card list */}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none">
          <Search className="w-4 h-4" />
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder={placeholder}
          data-testid="assignee-search-input"
          className={clsx(
            'w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle',
            'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            'text-sm py-2 pl-9 pr-3',
          )}
        />

        {/* Member card list — absolutely positioned so it overlays and does not reflow the layout */}
        {open && (
          <div
            // Preventing mousedown keeps the search input focused when a member
            // is clicked, so the dropdown does not dismiss before the click.
            onMouseDown={(e) => e.preventDefault()}
            className={clsx(
              // Indented from the input edges so the card reads as a sub-item
              'absolute left-6 right-6 top-full mt-1 z-20',
              'border border-default rounded-lg bg-background-elevated shadow-lg',
              'max-h-56 overflow-y-auto',
            )}
            data-testid="assignee-member-list"
          >
            {!projectId ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
                Project context is missing.
              </div>
            ) : isLoading || !data ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
                Loading members…
              </div>
            ) : available.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
                <Users className="w-4 h-4" />
                {search
                  ? 'No matches found'
                  : members.length === 0
                    ? 'No members in this project'
                    : 'All project members added'}
              </div>
            ) : (
              <ul className="divide-y divide-default">
                {available.map((m) => (
                  <li key={m.userId}>
                    <button
                      type="button"
                      onClick={() => addAssignee(m.userId)}
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-default"
                      data-testid={`assignee-option-${m.userId}`}
                    >
                      <div className="text-sm text-foreground truncate">
                        {m.email || '(no email)'}
                      </div>
                      {m.name && <div className="text-xs text-muted truncate">{m.name}</div>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
