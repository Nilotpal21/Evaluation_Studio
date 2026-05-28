'use client';

/**
 * AgentEditorHeader Component
 *
 * Header bar for the unified agent editor. Combines patterns from:
 * - AgentDetailPanel.tsx (canvas): save/discard/close buttons
 * - AgentDetailPage.tsx (list): back button, mode badge
 *
 * Renders differently based on container mode:
 * - Page mode: shows back button (via onBack)
 * - Slider/modal mode: shows close button (via onClose)
 */

import { Check, Code, History, Loader2, MessageCircle, RotateCcw, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';

interface AgentEditorHeaderProps {
  agentName: string;
  mode: string;
  model?: string;
  isDirty: boolean;
  isSaving: boolean;
  isSaved?: boolean;
  saveError?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onClose?: () => void;
  onBack?: () => void;
  onChat?: () => void;
  onVersions?: () => void;
  onDslOverlay?: () => void;
  onDelete?: () => void;
}

export function AgentEditorHeader({
  agentName,
  mode,
  model,
  isDirty,
  isSaving,
  isSaved,
  saveError,
  onSave,
  onDiscard,
  onClose,
  onBack,
  onChat,
  onVersions,
  onDslOverlay,
  onDelete,
}: AgentEditorHeaderProps) {
  return (
    <TooltipProvider>
      <div className="h-12 flex items-center justify-between px-4 border-b border-default shrink-0">
        {/* Left side: name + mode badge + unsaved badge */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">{agentName}</span>
          <span
            className={clsx(
              'text-xs px-2 py-0.5 rounded font-medium',
              mode === 'Reasoning'
                ? 'bg-accent-subtle text-accent'
                : mode === 'Mixed'
                  ? 'bg-purple-subtle text-purple'
                  : 'bg-info-subtle text-info',
            )}
          >
            {mode}
          </span>
          {model && <span className="text-xs text-foreground-muted font-mono">{model}</span>}
          {isDirty && (
            <span className="text-xs px-2 py-0.5 rounded bg-warning-subtle text-warning font-medium">
              Unsaved
            </span>
          )}
        </div>

        {/* Right side: action buttons + discard + save + close */}
        <div className="flex items-center gap-2">
          {/* Secondary CTAs with labels: Chat with Agent, DSL */}
          {onChat && (
            <Tooltip content="Chat with agent" side="bottom">
              <button
                onClick={onChat}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-default text-xs font-medium text-foreground hover:bg-background-muted transition-default"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Chat with Agent
              </button>
            </Tooltip>
          )}
          {onDslOverlay && (
            <Tooltip content="Full-screen ABL editor" side="bottom">
              <button
                onClick={onDslOverlay}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-default text-xs font-medium text-foreground hover:bg-background-muted transition-default"
              >
                <Code className="w-3.5 h-3.5" />
                ABL
              </button>
            </Tooltip>
          )}

          {/* Separator between labeled secondary CTAs and icon-only secondary CTAs */}
          {(onChat || onDslOverlay) && (onVersions || onDelete) && (
            <div className="w-px h-4 bg-border mx-1" />
          )}

          {/* Icon-only secondary CTAs: History, Delete */}
          {onVersions && (
            <Tooltip content="Version history" side="bottom">
              <button
                onClick={onVersions}
                aria-label="Version history"
                className="p-1.5 rounded-md border border-default text-foreground hover:bg-background-muted transition-default"
              >
                <History className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip content="Delete agent" side="bottom">
              <button
                onClick={onDelete}
                aria-label="Delete agent"
                className="p-1.5 rounded-md border border-default text-error hover:bg-error-subtle transition-default"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}

          {/* Separator before primary save controls */}
          {(onChat || onVersions || onDslOverlay || onDelete) && (
            <div className="w-px h-4 bg-border mx-1" />
          )}

          {isDirty && (
            <Tooltip content="Discard all changes" side="bottom">
              <button
                onClick={onDiscard}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
              >
                <RotateCcw className="w-3 h-3" />
                Discard
              </button>
            </Tooltip>
          )}
          <Tooltip
            content={
              saveError
                ? `Save failed: ${saveError}`
                : isSaved
                  ? 'Saved'
                  : isDirty
                    ? 'Save changes (Cmd+S)'
                    : 'No changes to save'
            }
            side="bottom"
          >
            <button
              onClick={onSave}
              disabled={!isDirty || isSaving}
              className={clsx(
                'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-default',
                saveError
                  ? 'bg-error text-error-foreground'
                  : isSaved
                    ? 'bg-success text-success-foreground'
                    : isDirty
                      ? 'bg-accent text-accent-foreground hover:opacity-90'
                      : 'bg-background-muted text-foreground-muted cursor-not-allowed',
              )}
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : isSaved ? (
                <Check className="w-3.5 h-3.5" />
              ) : null}
              {isSaving ? 'Saving…' : isSaved ? 'Saved' : saveError ? 'Error' : 'Save changes'}
            </button>
          </Tooltip>
          {onClose && (
            <Tooltip content="Close editor (Esc)" side="bottom">
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
