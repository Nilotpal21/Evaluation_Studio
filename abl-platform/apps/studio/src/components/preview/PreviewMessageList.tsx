'use client';

import { useState } from 'react';
import { Brain } from 'lucide-react';
import type {
  ActionElement,
  ActionSet,
  ActionSubmitOptions,
  RichContent,
} from '@agent-platform/web-sdk';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TemplateMockProvider } from '../templates/TemplateMockProvider';
import { PreviewAuthChallengeCard } from './PreviewAuthChallengeCard';
import { CsatRatingCard } from './CsatRatingCard';
import type { PreviewChatMessage } from './preview-chat-utils';

interface PreviewMessageListProps {
  messages: PreviewChatMessage[];
  isTyping: boolean;
  projectId?: string;
  onAction?: PreviewActionSubmitHandler;
  onAuthResponse?: (toolCallId: string, status: 'completed' | 'cancelled') => void;
}

type PreviewActionSubmitHandler = (
  actionId: string,
  value?: string,
  options?: ActionSubmitOptions,
) => void;

function hasRenderableRichContent(richContent?: RichContent): richContent is RichContent {
  return Boolean(richContent && Object.keys(richContent).length > 0);
}

// Shared prose classes matching DebugTabs.tsx for visual consistency
const PROSE_CLASSES =
  'break-words text-sm max-w-none prose prose-sm dark:prose-invert ' +
  'prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 ' +
  'text-foreground prose-headings:text-foreground prose-headings:my-1.5 prose-headings:font-semibold ' +
  'prose-strong:text-foreground prose-em:text-foreground prose-li:text-foreground ' +
  'prose-code:text-foreground prose-code:bg-foreground/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em] prose-code:font-mono ' +
  'prose-pre:bg-background-muted prose-pre:border prose-pre:border-default prose-pre:text-foreground prose-pre:rounded-lg prose-pre:my-2 prose-pre:p-3 ' +
  'prose-a:text-info prose-a:underline prose-a:underline-offset-2 hover:prose-a:text-info/80 ' +
  'prose-blockquote:text-foreground/80 prose-blockquote:border-l-2 prose-blockquote:border-default prose-blockquote:not-italic prose-blockquote:pl-3 ' +
  'prose-th:text-foreground prose-th:border-foreground/10 prose-th:px-2 prose-th:py-1.5 prose-th:font-medium ' +
  'prose-td:text-foreground prose-td:border-foreground/10 prose-td:px-2 prose-td:py-1.5 ' +
  'prose-thead:bg-foreground/5 prose-table:border prose-table:border-foreground/10 prose-table:rounded-lg prose-table:overflow-hidden ' +
  'prose-hr:border-default';

function PreviewActionInput({
  element,
  onAction,
  onValueChange,
  deferToSubmit,
  renderId,
}: {
  element: ActionElement;
  onAction: PreviewActionSubmitHandler;
  onValueChange: (id: string, value: string) => void;
  deferToSubmit: boolean;
  renderId?: string;
}) {
  const t = useTranslations('preview');
  const [value, setValue] = useState('');

  const submit = () => {
    if (deferToSubmit) return;
    if (!value.trim()) return;
    emitPreviewAction(onAction, element.id, value, renderId);
    setValue('');
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type={element.input_type ?? 'text'}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onValueChange(element.id, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={element.placeholder ?? element.label}
        required={element.required}
        className="min-w-0 flex-1 rounded-lg border border-default bg-background-muted px-3 py-2 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-border-focus transition-default"
      />
      {!deferToSubmit ? (
        <button
          type="button"
          onClick={submit}
          className="rounded-lg border border-default bg-background-muted px-3 py-2 text-sm font-medium text-foreground hover:bg-background-elevated transition-default"
        >
          {t('send_button')}
        </button>
      ) : null}
    </div>
  );
}

function PreviewActionSet({
  actions,
  onAction,
}: {
  actions: ActionSet;
  onAction: PreviewActionSubmitHandler;
}) {
  const deferToSubmit = Boolean(actions.submit_id);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const setFormValue = (id: string, value: string) => {
    setFormValues((current) => ({ ...current, [id]: value }));
  };
  const submitForm = () => {
    if (!actions.submit_id) return;
    const formElements = actions.elements.filter(
      (element) => element.type === 'input' || element.type === 'select',
    );
    if (
      formElements.some(
        (element) => element.required && !String(formValues[element.id] ?? '').trim(),
      )
    ) {
      return;
    }
    const formData = Object.fromEntries(
      formElements.map((element) => [element.id, formValues[element.id] ?? '']),
    );
    emitPreviewAction(
      onAction,
      actions.submit_id,
      JSON.stringify(formData),
      actions.renderId,
      formData,
    );
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="preview-action-set">
      {actions.elements.map((element) => {
        if (element.type === 'button') {
          return (
            <button
              key={element.id}
              type="button"
              onClick={() =>
                emitPreviewAction(onAction, element.id, element.value, actions.renderId)
              }
              className="inline-flex items-center rounded-lg border border-default bg-background-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background-elevated hover:border-border-focus/30 transition-default"
              title={element.description}
            >
              {element.label}
            </button>
          );
        }

        if (element.type === 'select') {
          return (
            <select
              key={element.id}
              aria-label={element.label}
              defaultValue=""
              required={element.required}
              onChange={(event) => {
                setFormValue(element.id, event.target.value);
                if (!deferToSubmit) {
                  emitPreviewAction(onAction, element.id, event.target.value, actions.renderId);
                }
              }}
              className="w-full rounded-lg border border-default bg-background-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:border-border-focus transition-default"
            >
              <option value="" disabled>
                {element.label}
              </option>
              {(element.options ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          );
        }

        return (
          <PreviewActionInput
            key={element.id}
            element={element}
            onAction={onAction}
            onValueChange={setFormValue}
            deferToSubmit={deferToSubmit}
            renderId={actions.renderId}
          />
        );
      })}
      {actions.submit_id && actions.submit_label ? (
        <button
          type="button"
          onClick={submitForm}
          className="inline-flex items-center rounded-lg border border-info bg-info px-3 py-1.5 text-sm font-medium text-white hover:bg-info/90 transition-default"
        >
          {actions.submit_label}
        </button>
      ) : null}
    </div>
  );
}

function emitPreviewAction(
  onAction: PreviewActionSubmitHandler,
  actionId: string,
  value?: string,
  renderId?: string,
  formData?: Record<string, unknown>,
) {
  const options = {
    ...(renderId ? { renderId } : {}),
    ...(formData !== undefined ? { formData } : {}),
  };

  if (Object.keys(options).length > 0) {
    onAction(actionId, value, options);
    return;
  }

  onAction(actionId, value);
}

function PreviewAssistantMessage({
  message,
  onAction,
}: {
  message: PreviewChatMessage;
  onAction?: PreviewActionSubmitHandler;
}) {
  return (
    <div className="max-w-[82%] rounded-2xl rounded-bl-sm bg-background-subtle px-4 py-3 text-foreground shadow-xs animate-fade-in">
      {message.content ? (
        <div className={PROSE_CLASSES}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
      ) : null}

      {hasRenderableRichContent(message.richContent) ? (
        <div className={message.content ? 'mt-3' : undefined}>
          <TemplateMockProvider richContent={message.richContent as Record<string, unknown>} />
        </div>
      ) : null}

      {message.actions && onAction ? (
        <PreviewActionSet actions={message.actions} onAction={onAction} />
      ) : null}
    </div>
  );
}

function PreviewThoughtMessage({ message }: { message: PreviewChatMessage }) {
  const t = useTranslations('preview');

  return (
    <div className="max-w-[82%] rounded-2xl rounded-bl-sm border border-default bg-background px-4 py-3 text-foreground animate-fade-in">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-foreground-subtle">
        <Brain className="h-3 w-3" />
        {message.metadata?.toolName || t('thinking')}
      </div>
      <div className="whitespace-pre-wrap text-sm text-foreground-muted leading-relaxed">
        {message.content}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl rounded-bl-sm bg-background-subtle px-4 py-3 shadow-xs">
        <span className="flex items-center gap-1">
          <span
            className="h-1.5 w-1.5 rounded-full bg-foreground-subtle animate-bounce"
            style={{ animationDelay: '0ms', animationDuration: '1s' }}
          />
          <span
            className="h-1.5 w-1.5 rounded-full bg-foreground-subtle animate-bounce"
            style={{ animationDelay: '180ms', animationDuration: '1s' }}
          />
          <span
            className="h-1.5 w-1.5 rounded-full bg-foreground-subtle animate-bounce"
            style={{ animationDelay: '360ms', animationDuration: '1s' }}
          />
        </span>
      </div>
    </div>
  );
}

export function PreviewMessageList({
  messages,
  isTyping,
  projectId,
  onAction,
  onAuthResponse,
}: PreviewMessageListProps) {
  return (
    <>
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          {message.role === 'user' ? (
            <div className="max-w-[78%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-xs animate-fade-in leading-relaxed whitespace-pre-wrap">
              {message.content}
            </div>
          ) : message.csatData && projectId ? (
            <CsatRatingCard
              prompt={message.content}
              csatData={message.csatData}
              projectId={projectId}
            />
          ) : message.authChallenge && onAuthResponse ? (
            <PreviewAuthChallengeCard
              challenge={message.authChallenge}
              onAuthResponse={onAuthResponse}
            />
          ) : message.role === 'thought' ? (
            <PreviewThoughtMessage message={message} />
          ) : message.role === 'assistant' ? (
            <PreviewAssistantMessage message={message} onAction={onAction} />
          ) : (
            <div className="max-w-[82%] rounded-2xl rounded-bl-sm bg-background-subtle px-4 py-2.5 text-sm text-foreground shadow-xs animate-fade-in whitespace-pre-wrap">
              {message.content}
            </div>
          )}
        </div>
      ))}

      {isTyping ? <TypingIndicator /> : null}
    </>
  );
}
