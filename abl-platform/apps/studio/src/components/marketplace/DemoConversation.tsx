'use client';

import { useTranslations } from 'next-intl';
import { Bot, User } from 'lucide-react';
import type { DemoConversationMessage } from '@/store/marketplace-store';

interface DemoConversationProps {
  messages: DemoConversationMessage[];
}

export function DemoConversation({ messages }: DemoConversationProps) {
  const t = useTranslations('marketplace');

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
      <div className="px-4 py-3 border-b border-default">
        <h3 className="text-sm font-medium text-foreground">{t('demoConversation.title')}</h3>
        <p className="text-xs text-muted mt-0.5">{t('demoConversation.description')}</p>
      </div>
      <div className="p-4 space-y-3">
        {messages.map((msg, index) => {
          const isAgent = msg.role === 'agent' || msg.role === 'assistant';
          return (
            <div key={index} className={`flex gap-3 py-2 ${isAgent ? 'flex-row-reverse' : ''}`}>
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isAgent ? 'bg-accent-subtle' : 'bg-background-muted'
                }`}
              >
                {isAgent ? (
                  <Bot className="w-3.5 h-3.5 text-accent" />
                ) : (
                  <User className="w-3.5 h-3.5 text-foreground-muted" />
                )}
              </div>
              <div
                className={`rounded-xl px-4 py-2.5 text-sm max-w-[80%] ${
                  isAgent
                    ? 'bg-accent-subtle text-foreground'
                    : 'bg-background-muted text-foreground'
                }`}
              >
                {msg.content}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
