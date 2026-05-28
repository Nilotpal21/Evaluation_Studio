'use client';

/**
 * AgentEditorModal
 *
 * Centered modal overlay container for the agent editor.
 * Scales in from 0.95 with opacity fade.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../../../lib/animation';
import { AgentEditor } from '../AgentEditor';
import { AGENT_EDITOR_CONFIG } from '../agent-editor-config';

// =============================================================================
// PROPS
// =============================================================================

interface AgentEditorModalProps {
  projectId: string;
  agentName: string | null;
  agents?: Array<{ name: string }>;
  onClose: () => void;
  onSaved?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentEditorModal({
  projectId,
  agentName,
  agents,
  onClose,
  onSaved,
}: AgentEditorModalProps) {
  return (
    <AnimatePresence>
      {agentName && (
        <>
          {/* Backdrop */}
          <motion.div
            key="editor-modal-backdrop"
            className="fixed inset-0 z-40 bg-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />

          {/* Centered container */}
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <motion.div
              key="editor-modal-panel"
              className={clsx(
                'rounded-xl shadow-2xl overflow-hidden',
                'bg-background-subtle',
                'flex flex-col pointer-events-auto',
              )}
              style={{
                width: AGENT_EDITOR_CONFIG.modal.width,
                height: AGENT_EDITOR_CONFIG.modal.height,
              }}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={springs.default}
            >
              <AgentEditor
                projectId={projectId}
                agentName={agentName}
                agents={agents}
                onClose={onClose}
                onSaved={onSaved}
              />
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
