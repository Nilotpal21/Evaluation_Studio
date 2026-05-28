'use client';

import { KB_CARD_MAP } from '../cards';
import type { ChatMessage } from '@/lib/arch-ai/ui/types';

type SearchArtifactCard = NonNullable<ChatMessage['kbCards']>[number];

interface SearchArtifactEntry {
  id: string;
  receivedAt: string;
  card: SearchArtifactCard;
}

interface SearchArtifactPanelProps {
  data: unknown;
  emptyMessage: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSearchArtifactEntry(value: unknown): value is SearchArtifactEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.receivedAt === 'string' &&
    isRecord(value.card) &&
    typeof value.card.type === 'string'
  );
}

function getEntries(data: unknown): SearchArtifactEntry[] {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    return [];
  }

  return data.entries.filter(isSearchArtifactEntry);
}

function groupEntries(entries: SearchArtifactEntry[]) {
  const grouped: Record<string, { label: string; items: SearchArtifactEntry[] }> = {};
  const order: string[] = [];

  for (const entry of [...entries].reverse()) {
    const kbId =
      typeof entry.card.kbId === 'string' && entry.card.kbId.trim().length > 0
        ? entry.card.kbId
        : 'search-ai';
    const kbName =
      typeof entry.card.kbName === 'string' && entry.card.kbName.trim().length > 0
        ? entry.card.kbName
        : 'Search AI';

    if (!grouped[kbId]) {
      grouped[kbId] = { label: kbName, items: [] };
      order.push(kbId);
    }

    grouped[kbId].items.push(entry);
  }

  return order.map((key) => ({ key, ...grouped[key] }));
}

export function SearchArtifactPanel({ data, emptyMessage }: SearchArtifactPanelProps) {
  const entries = getEntries(data);

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <svg
          width="28"
          height="28"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-foreground/10"
          aria-hidden="true"
        >
          <path
            d="M9 2L16 16H2L9 2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M6 11.5H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <p className="text-xs text-foreground-subtle">{emptyMessage}</p>
      </div>
    );
  }

  const groups = groupEntries(entries);

  return (
    <div className="space-y-6 p-4">
      {groups.map((group) => (
        <section key={group.key} className="space-y-3">
          <div className="sticky top-0 z-10 -mx-4 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground-muted">
              {group.label}
            </h3>
          </div>

          <div className="space-y-3">
            {group.items.map((entry) => {
              const CardComponent = KB_CARD_MAP[entry.card.type];
              if (!CardComponent) {
                return null;
              }

              return <CardComponent key={entry.id} event={entry.card} />;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
