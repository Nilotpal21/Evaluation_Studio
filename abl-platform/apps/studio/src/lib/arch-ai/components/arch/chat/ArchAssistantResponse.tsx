'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { Skeleton } from '@/components/ui/Skeleton';
import type { ActivityGroup, ChatMessage } from '@/lib/arch-ai/ui/types';
import { SpecialistBadge } from './SpecialistBadge';
import { ThinkingPanel } from './ThinkingPanel';
import { ContentBlockRenderer } from './ContentBlockRenderer';
import { CompletionIndicator } from './CompletionIndicator';
import { ArchMarkdown } from './ArchMarkdown';
import { copyRichTextFromRenderedMessage, getMessageCopyMarkdown } from './message-copy';

type AssistantResponseMessage = Pick<
  ChatMessage,
  | 'specialist'
  | 'thinkingText'
  | 'thinkingElapsed'
  | 'rawContent'
  | 'content'
  | 'completion'
  | 'isStreaming'
  | 'activityGroups'
>;

interface ArchAssistantResponseProps {
  message: AssistantResponseMessage;
  defaultExpanded: boolean;
  activityGroups?: ActivityGroup[];
  beforeContent?: ReactNode;
  afterContent?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export const ArchAssistantResponse = memo(function ArchAssistantResponse({
  message,
  defaultExpanded,
  activityGroups,
  beforeContent,
  afterContent,
  className,
  bodyClassName,
}: ArchAssistantResponseProps) {
  const copyContentRef = useRef<HTMLDivElement>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedFormat, setCopiedFormat] = useState<'markdown' | 'rich-text' | null>(null);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const visibleActivityGroups = activityGroups ?? message.activityGroups;
  const hasActivitySteps = Boolean(visibleActivityGroups?.some((group) => group.steps.length > 0));
  const hasThinkingOrActivity = Boolean(message.thinkingText) || hasActivitySteps;
  const hasRawContent = Boolean(message.rawContent && message.rawContent.length > 0);
  const copyMarkdown = useMemo(
    () => getMessageCopyMarkdown({ content: message.content, rawContent: message.rawContent }),
    [message.content, message.rawContent],
  );
  const canCopy = copyMarkdown.trim().length > 0;
  const hasRenderableBody =
    hasRawContent ||
    Boolean(message.content) ||
    Boolean(beforeContent) ||
    Boolean(afterContent) ||
    Boolean(message.completion);
  const showStreamingPlaceholder =
    Boolean(message.isStreaming) && !hasThinkingOrActivity && !hasRenderableBody;
  const shouldShowSpecialist = Boolean(
    message.specialist && (message.isStreaming || hasThinkingOrActivity || hasRenderableBody),
  );

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const showCopiedState = useCallback((format: 'markdown' | 'rich-text') => {
    setCopiedFormat(format);
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopiedFormat(null);
      copyResetTimerRef.current = null;
    }, 1800);
  }, []);

  const handleCopyMarkdown = useCallback(async () => {
    await navigator.clipboard.writeText(copyMarkdown);
    showCopiedState('markdown');
  }, [copyMarkdown, showCopiedState]);

  const handleCopyRichText = useCallback(async () => {
    if (!copyContentRef.current) {
      await navigator.clipboard.writeText(copyMarkdown);
      showCopiedState('rich-text');
      return;
    }

    await copyRichTextFromRenderedMessage(copyContentRef.current, copyMarkdown);
    showCopiedState('rich-text');
  }, [copyMarkdown, showCopiedState]);

  if (!shouldShowSpecialist && !hasThinkingOrActivity && !hasRenderableBody) {
    return null;
  }

  return (
    <div className={clsx('flex min-w-0 flex-col gap-2.5', className)}>
      {shouldShowSpecialist && message.specialist ? (
        <SpecialistBadge name={message.specialist.name} icon={message.specialist.icon} />
      ) : null}

      <div
        className={clsx(
          'group/assistant-message w-full max-w-[720px] rounded-3xl border border-border/60 bg-background-elevated/80 px-5 py-4 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.35)] backdrop-blur-sm',
          bodyClassName,
        )}
      >
        <div className="relative">
          {canCopy ? (
            <div
              className={clsx(
                'absolute right-0 top-0 z-10 transition-all duration-150',
                'opacity-0 translate-y-1 pointer-events-none',
                'group-hover/assistant-message:opacity-100 group-hover/assistant-message:translate-y-0 group-hover/assistant-message:pointer-events-auto',
                'group-focus-within/assistant-message:opacity-100 group-focus-within/assistant-message:translate-y-0 group-focus-within/assistant-message:pointer-events-auto',
                (copyMenuOpen || copiedFormat) && 'opacity-100 translate-y-0 pointer-events-auto',
              )}
            >
              <DropdownMenu
                align="end"
                onOpenChange={setCopyMenuOpen}
                trigger={
                  <button
                    type="button"
                    aria-label="Copy message"
                    title={
                      copiedFormat === 'markdown'
                        ? 'Copied markdown'
                        : copiedFormat === 'rich-text'
                          ? 'Copied rich text'
                          : 'Copy message'
                    }
                    className={clsx(
                      'rounded-full border border-border/40 bg-background/78 p-1 text-foreground-muted/45 shadow-sm backdrop-blur-sm transition-colors',
                      'hover:border-border/70 hover:bg-background/92 hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
                    )}
                  >
                    {copiedFormat ? (
                      <Check className="h-3 w-3 text-success" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                }
              >
                <DropdownMenuItem onSelect={() => void handleCopyMarkdown()}>
                  Copy as Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleCopyRichText()}>
                  Copy as Rich Text
                </DropdownMenuItem>
              </DropdownMenu>
            </div>
          ) : null}

          <div className={clsx('space-y-4', canCopy && 'pr-11')}>
            <ThinkingPanel
              thinkingText={message.thinkingText}
              thinkingElapsed={message.thinkingElapsed}
              activityGroups={visibleActivityGroups}
              isStreaming={message.isStreaming ?? false}
              defaultExpanded={defaultExpanded}
            />

            {beforeContent}

            {hasRawContent ? (
              <div ref={copyContentRef}>
                <ContentBlockRenderer blocks={message.rawContent ?? []} />
              </div>
            ) : message.content ? (
              <div ref={copyContentRef}>
                <ArchMarkdown
                  content={message.content}
                  isStreaming={message.isStreaming ?? false}
                />
              </div>
            ) : showStreamingPlaceholder ? (
              <div
                role="status"
                aria-live="polite"
                aria-label="Arch is responding"
                className="flex items-center py-1"
              >
                <Skeleton className="h-3 w-36 max-w-[58%] rounded-full opacity-70" />
              </div>
            ) : null}

            {afterContent}

            {message.completion ? <CompletionIndicator completion={message.completion} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
});
