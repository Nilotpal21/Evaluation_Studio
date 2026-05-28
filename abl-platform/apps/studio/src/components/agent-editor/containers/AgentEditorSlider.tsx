'use client';

/**
 * AgentEditorSlider
 *
 * Slide-over panel container for the agent editor.
 * Slides in from the right, same pattern as AgentDetailPanel on the canvas.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { springs, transitions } from '../../../lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';
import { AgentEditor } from '../AgentEditor';
import { AGENT_EDITOR_CONFIG } from '../agent-editor-config';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

const ARCH_PANEL_WIDTH = 480;

// =============================================================================
// PROPS
// =============================================================================

interface AgentEditorSliderProps {
  projectId: string;
  agentName: string | null;
  agents?: Array<{ name: string }>;
  onClose: () => void;
  onSaved?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentEditorSlider({
  projectId,
  agentName,
  agents,
  onClose,
  onSaved,
}: AgentEditorSliderProps) {
  const archOpen = useArchAIStore((s) => s.overlayState !== 'closed');
  const rightOffset = archOpen ? ARCH_PANEL_WIDTH : 0;

  return (
    <AnimatePresence>
      {agentName && (
        <>
          {/* Backdrop */}
          <motion.div
            key="editor-slider-backdrop"
            data-testid="agent-editor-slider-backdrop"
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Panel — shifts left when Arch AI panel is open */}
          <motion.div
            key="editor-slider-panel"
            className={clsx(
              'fixed top-0 right-0 h-full z-50',
              'bg-background-subtle border-l border-default shadow-xl',
              'flex flex-col',
              'transition-[margin-right] duration-300 ease-out',
            )}
            style={{
              width: AGENT_EDITOR_CONFIG.slider.width,
              marginRight: rightOffset,
            }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
          >
            <AgentEditor
              projectId={projectId}
              agentName={agentName}
              agents={agents}
              onClose={onClose}
              onSaved={onSaved}
            />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
