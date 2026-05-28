/**
 * StaleToolBanner Component
 *
 * Dismissible warning banner shown on the agent detail page when project tools
 * have changed (sourceHash mismatch) since the active agent version was compiled,
 * or when tools have been deleted from the project.
 * Encourages the user to recompile to pick up updates.
 */

import { useState } from 'react';
import { AlertTriangle, Trash2, X, RefreshCw, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { springs } from '../../lib/animation';
import type { StaleToolInfo, DeletedToolInfo, NewToolInfo } from '../../hooks/useStaleToolCheck';

interface StaleToolBannerProps {
  staleTools: StaleToolInfo[];
  deletedTools?: DeletedToolInfo[];
  newTools?: NewToolInfo[];
  onRecompile?: () => void;
  isRecompiling?: boolean;
}

export function StaleToolBanner({
  staleTools,
  deletedTools = [],
  newTools = [],
  onRecompile,
  isRecompiling = false,
}: StaleToolBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  const show =
    !dismissed && (staleTools.length > 0 || deletedTools.length > 0 || newTools.length > 0);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="stale-tool-banner"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={springs.snappy}
          className="px-6 py-3 bg-warning-subtle border-b border-warning/30"
        >
          <div className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              {staleTools.length > 0 && (
                <>
                  <p className="font-medium">
                    {staleTools.length} tool{staleTools.length !== 1 ? 's' : ''} ha
                    {staleTools.length !== 1 ? 've' : 's'} been updated since last compile.
                    Recompile to pick up changes.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {staleTools.map((tool) => (
                      <li key={tool.projectToolId} className="flex items-center gap-1.5 text-xs">
                        <span className="font-mono text-warning-foreground">{tool.name}</span>
                        <span className="text-warning/70">[{tool.toolType}]</span>
                        <span className="text-warning/50">modified</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {deletedTools.length > 0 && (
                <div className={staleTools.length > 0 ? 'mt-2' : ''}>
                  <p className="font-medium text-error">
                    {deletedTools.length} tool{deletedTools.length !== 1 ? 's' : ''}{' '}
                    {deletedTools.length !== 1 ? 'have' : 'has'} been deleted. Recompile will fail
                    until the tool reference is removed from the TOOLS section.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {deletedTools.map((tool) => (
                      <li key={tool.projectToolId} className="flex items-center gap-1.5 text-xs">
                        <Trash2 className="w-3 h-3 text-error/60" />
                        <span className="font-mono text-error/80 line-through">{tool.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {newTools.length > 0 && (
                <div className={staleTools.length > 0 || deletedTools.length > 0 ? 'mt-2' : ''}>
                  <p className="font-medium text-info">
                    {newTools.length} new tool{newTools.length !== 1 ? 's' : ''} added since last
                    compile. Recompile to include {newTools.length !== 1 ? 'them' : 'it'} in the
                    agent version snapshot.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {newTools.map((tool) => (
                      <li key={tool.projectToolId} className="flex items-center gap-1.5 text-xs">
                        <Plus className="w-3 h-3 text-info/60" />
                        <span className="font-mono text-info/80">{tool.name}</span>
                        <span className="text-info/50">new</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {onRecompile &&
                (staleTools.length > 0 || deletedTools.length > 0 || newTools.length > 0) && (
                  <button
                    onClick={onRecompile}
                    disabled={isRecompiling}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md text-warning-foreground bg-warning/20 hover:bg-warning/30 transition-fast disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRecompiling ? 'animate-spin' : ''}`} />
                    {isRecompiling ? 'Recompiling...' : 'Recompile'}
                  </button>
                )}
              <button
                onClick={() => setDismissed(true)}
                className="p-0.5 rounded text-warning/60 hover:text-warning transition-fast"
                aria-label="Dismiss stale tool warning"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
