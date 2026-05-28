/**
 * InteractionsTab — Root component for the Interactions debug panel tab.
 *
 * Composes: SessionHeader → AgentPath → (InteractionCard | AgentSwitchBanner)*
 *
 * Reads trace events from useObservatoryStore and processes them
 * into interactions using event-processor.ts. All derived state
 * is local (no store modifications).
 */

import { useMemo, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useObservatoryStore } from '../../../store/observatory-store';
import { useSessionStore } from '../../../store/session-store';
import { processEventsToInteractions } from './event-processor';
import { SessionHeader } from './SessionHeader';
import { InteractionCard } from './InteractionCard';
import { AgentSwitchBanner } from './AgentSwitchBanner';
import { SessionResolutionFooter } from './SessionResolutionFooter';
import { InteractionsErrorBoundary } from './ErrorBoundary';
import type { AgentSwitch, Interaction } from './types';
import type { SessionMessage } from '../../../types';
import type { WaterfallMode } from '../WaterfallPanel';

const FOLLOW_LATEST_THRESHOLD_PX = 72;

function InteractionsTabContent({ mode }: { mode: WaterfallMode }) {
  const events = useObservatoryStore((s) => s.events);
  const messages = useSessionStore((s) => s.messages);
  // I5: Check if session is still loading by looking at session store loading state
  const isLoading = useSessionStore((s) => s.isLoading ?? false);

  // C2: Debounce event processing to prevent UI freeze on large sessions (500+ events)
  // useDeferredValue allows React to prioritize user interactions while deferring heavy computation
  const deferredEvents = useDeferredValue(events);
  const processed = useMemo(() => processEventsToInteractions(deferredEvents), [deferredEvents]);

  const { summary, agentSwitches, resolution } = processed;

  // Enrich agent_response steps that lack content with actual chat messages
  const interactions = useMemo(
    () => enrichResponseContent(processed.interactions, messages),
    [processed.interactions, messages],
  );
  const latestInteraction = interactions[interactions.length - 1] ?? null;
  const latestInteractionId = latestInteraction?.id ?? null;
  const latestActivityKey = useMemo(() => {
    if (!latestInteraction) {
      return null;
    }

    const latestStep = latestInteraction.steps[latestInteraction.steps.length - 1];
    return [
      latestInteraction.id,
      latestInteraction.steps.length,
      latestStep?.id ?? 'no-step',
      latestStep?.events.length ?? 0,
    ].join(':');
  }, [latestInteraction]);
  const [expandedInteractionId, setExpandedInteractionId] = useState<string | null>(
    () => latestInteraction?.id ?? null,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousLatestActivityKeyRef = useRef<string | null>(null);

  // I4: Build switchMap limited to last 100 interactions to prevent unbounded memory
  const switchMap = useMemo(() => {
    const map = new Map<number, AgentSwitch>();
    // Only keep switches for recent interactions (last 100)
    const recentSwitches = agentSwitches.length > 100 ? agentSwitches.slice(-100) : agentSwitches;
    for (const sw of recentSwitches) {
      map.set(sw.afterInteractionIndex, sw);
    }
    return map;
  }, [agentSwitches]);

  useEffect(() => {
    if (!latestInteractionId || !latestActivityKey) {
      setExpandedInteractionId(null);
      previousLatestActivityKeyRef.current = null;
      return;
    }

    setExpandedInteractionId(latestInteractionId);

    const previousKey = previousLatestActivityKeyRef.current;
    previousLatestActivityKeyRef.current = latestActivityKey;

    if (mode !== 'live' || !followLatestRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({
        behavior: previousKey === null ? 'auto' : 'smooth',
        block: 'end',
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [latestActivityKey, latestInteractionId, mode]);

  const handleTimelineScroll = () => {
    const timeline = listRef.current;
    if (!timeline) {
      return;
    }

    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    followLatestRef.current = distanceFromBottom <= FOLLOW_LATEST_THRESHOLD_PX;
  };

  // I5: Loading state - show skeleton while events are loading
  if (events.length === 0 && isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-foreground-subtle text-sm gap-2">
        <div className="animate-pulse">
          <div className="h-8 w-8 bg-foreground-subtle/20 rounded-full mb-2" />
        </div>
        <span className="text-xs text-foreground-subtle">Loading interactions...</span>
      </div>
    );
  }

  // Empty state
  if (interactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-foreground-subtle text-sm gap-2">
        <span className="text-xl opacity-30">No interactions recorded</span>
        <span className="text-xs text-foreground-subtle">
          Start a conversation to see the timeline
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Session header */}
      <SessionHeader summary={summary} />

      {/* Interaction list */}
      <div
        ref={listRef}
        aria-label="Interaction timeline"
        className="flex-1 overflow-y-auto p-3 space-y-2"
        onScroll={handleTimelineScroll}
      >
        {interactions.map((interaction) => (
          <div key={interaction.id}>
            {/* Agent switch banner (if applicable) */}
            {switchMap.has(interaction.index - 1) && (
              <AgentSwitchBanner agentSwitch={switchMap.get(interaction.index - 1)!} />
            )}

            {/* Interaction card */}
            <InteractionCard
              interaction={interaction}
              expanded={interaction.id === expandedInteractionId}
              onExpandedChange={(nextExpanded) =>
                setExpandedInteractionId(nextExpanded ? interaction.id : null)
              }
            />
          </div>
        ))}

        {/* Session resolution footer */}
        {resolution && <SessionResolutionFooter resolution={resolution} />}
        <div ref={bottomRef} aria-hidden="true" className="h-px w-full" />
      </div>
    </div>
  );
}

// I1: Export wrapped with ErrorBoundary
export function InteractionsTab({ mode = 'live' }: { mode?: WaterfallMode }) {
  return (
    <InteractionsErrorBoundary>
      <InteractionsTabContent mode={mode} />
    </InteractionsErrorBoundary>
  );
}

/**
 * Hook for badge count — returns the number of interactions.
 * Used by DebugTabs to show a badge on the Interactions tab.
 *
 * M1: Reuses processEventsToInteractions to avoid duplicate event scanning.
 * Previously scanned events manually for user_message — now leverages existing processor.
 */
export function useInteractionCount(): number {
  const events = useObservatoryStore((s) => s.events);
  return useMemo(() => {
    const processed = processEventsToInteractions(events);
    return processed.interactions.length;
  }, [events]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getActionSummary(actions: unknown): string {
  if (!isRecord(actions) || !Array.isArray(actions.elements)) {
    return '';
  }

  const labels = actions.elements
    .map((element) => (isRecord(element) && typeof element.label === 'string' ? element.label : ''))
    .filter((label) => label.trim().length > 0);

  if (labels.length === 0) {
    return 'Interactive actions';
  }

  return `Interactive actions: ${labels.slice(0, 3).join(', ')}`;
}

function getRichContentSummary(richContent: unknown): string {
  if (!isRecord(richContent)) {
    return '';
  }

  const preferredTextFields = [
    richContent.markdown,
    richContent.html,
    richContent.adaptive_card,
    richContent.slack,
    richContent.ag_ui,
    richContent.whatsapp,
  ];
  const preferredText = preferredTextFields.find((value): value is string => {
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (preferredText) {
    return preferredText.trim();
  }

  const image = richContent.image;
  if (isRecord(image)) {
    const caption = image.caption ?? image.alt;
    if (typeof caption === 'string' && caption.trim().length > 0) {
      return caption.trim();
    }
    return 'Image content';
  }

  const file = richContent.file;
  if (isRecord(file) && typeof file.filename === 'string' && file.filename.trim().length > 0) {
    return `File: ${file.filename.trim()}`;
  }

  const templateLabels: Array<[unknown, string]> = [
    [richContent.carousel, 'Carousel content'],
    [richContent.quick_replies, 'Quick replies'],
    [richContent.list, 'List content'],
    [richContent.table, 'Table content'],
    [richContent.chart, 'Chart content'],
    [richContent.form, 'Form content'],
    [richContent.progress, 'Progress content'],
    [richContent.feedback, 'Feedback prompt'],
    [richContent.kpi, 'KPI content'],
    [richContent.video, 'Video content'],
    [richContent.audio, 'Audio content'],
  ];

  return templateLabels.find(([value]) => value !== undefined)?.[1] ?? '';
}

export function getMessageRenderableContent(message: SessionMessage): string {
  const text = message.content.trim();
  if (text.length > 0) {
    return text;
  }

  const envelope = message.contentEnvelope;
  if (!envelope) {
    return '';
  }

  if (typeof envelope.text === 'string' && envelope.text.trim().length > 0) {
    return envelope.text.trim();
  }

  const richContentSummary = getRichContentSummary(envelope.richContent);
  if (richContentSummary.length > 0) {
    return richContentSummary;
  }

  const voiceConfig = envelope.voiceConfig;
  if (isRecord(voiceConfig)) {
    const plainText = voiceConfig.plain_text;
    if (typeof plainText === 'string' && plainText.trim().length > 0) {
      return plainText.trim();
    }
  }

  return getActionSummary(envelope.actions);
}

/**
 * Enrich agent_response steps that have no content with the actual
 * assistant message text from the session store. The runtime's
 * agent_response trace event only carries contentLength, not text.
 *
 * C3: Uses timestamp proximity matching instead of fragile positional index.
 * Matches each agent_response step to the closest assistant message by timestamp.
 */
function enrichResponseContent(
  interactions: Interaction[],
  messages: SessionMessage[],
): Interaction[] {
  const assistantMessages = messages
    .filter((m) => m.role === 'assistant' && getMessageRenderableContent(m).length > 0)
    .map((message) => ({
      message,
      content: getMessageRenderableContent(message),
    }));
  if (assistantMessages.length === 0) return interactions;

  // Track which messages have been matched to avoid duplicates
  const usedMessageIds = new Set<string>();

  return interactions.map((interaction) => {
    return {
      ...interaction,
      steps: interaction.steps.map((step) => {
        if (step.type === 'agent_response' && !step.data.content) {
          // Find the closest assistant message by timestamp that hasn't been used yet
          let closestMessage: SessionMessage | null = null;
          let smallestTimeDiff = Infinity;

          for (const { message } of assistantMessages) {
            if (usedMessageIds.has(message.id)) continue;

            const timeDiff = Math.abs(
              step.timestamp.getTime() - new Date(message.timestamp).getTime(),
            );
            if (timeDiff < smallestTimeDiff) {
              smallestTimeDiff = timeDiff;
              closestMessage = message;
            }
          }

          if (closestMessage) {
            usedMessageIds.add(closestMessage.id);
            return {
              ...step,
              data: {
                ...step.data,
                content: getMessageRenderableContent(closestMessage),
                ...(closestMessage.contentEnvelope
                  ? { contentEnvelope: closestMessage.contentEnvelope }
                  : {}),
              },
            };
          }
        }
        return step;
      }),
    };
  });
}
