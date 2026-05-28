/**
 * ElevenLabs Conversational AI S2S Configuration Fields
 */

'use client';

import { Input } from '../../ui/Input';
import { Info } from 'lucide-react';

interface ElevenLabsS2SFieldsProps {
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

export function ElevenLabsS2SFields({ config, onChange }: ElevenLabsS2SFieldsProps) {
  return (
    <div className="space-y-4 p-4 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        ElevenLabs Conversational AI Configuration
      </h5>

      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-info/5 border border-info/30">
        <Info className="w-4 h-4 text-info shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-foreground">Agent ID Required</p>
          <p className="text-xs text-muted mt-0.5">
            Agents are configured in your{' '}
            <a
              href="https://elevenlabs.io/app/conversational-ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              ElevenLabs dashboard
            </a>
            . Copy the Agent ID from there.
          </p>
        </div>
      </div>

      <Input
        label="Agent ID"
        placeholder="agent_abc123xyz..."
        value={(config.s2sAgentId as string) || ''}
        onChange={(e) => onChange('s2sAgentId', e.target.value)}
        required
      />

      <Input
        label="Conversation ID (Optional)"
        placeholder="For session continuity"
        value={(config.s2sConversationId as string) || ''}
        onChange={(e) => onChange('s2sConversationId', e.target.value)}
      />

      <div className="pt-2 border-t border-default">
        <p className="text-xs text-muted">
          ElevenLabs Conversational AI provides natural voice agents with custom personalities.{' '}
          <a
            href="https://elevenlabs.io/docs/conversational-ai/overview"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            View documentation →
          </a>
        </p>
      </div>
    </div>
  );
}
