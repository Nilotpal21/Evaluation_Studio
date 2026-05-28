/**
 * AddStagePopover
 *
 * Dropdown menu shown when clicking an insert-point `+` button between
 * pipeline stage nodes. Lists valid stage types for the position, with
 * already-present types disabled.
 */

import { useCallback, useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { FileText, Layers, Sparkles, GitMerge, Globe, Brain, Eye } from 'lucide-react';
import type { PipelineStage } from '../../../../api/pipelines';
import { usePipelineStore } from '../../../../store/pipeline-store';
import {
  getValidInsertOptions,
  getDefaultProvider,
  getStageLabelKey,
  isUtilityStage,
} from './stage-insertion-rules';
import { resolveStageIntent } from './edge-styles';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { Tooltip } from '../../../ui/Tooltip';

// =============================================================================
// ICON MAP
// =============================================================================

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  extraction: FileText,
  chunking: Layers,
  enrichment: Sparkles,
  'content-intelligence': Brain,
  'visual-analysis': Eye,
  'field-mapping': GitMerge,
  'api-webhook': Globe,
  'llm-stage': Sparkles,
};

// =============================================================================
// PROPS
// =============================================================================

interface AddStagePopoverProps {
  flowId: string;
  afterStageId: string | null;
  beforeStageId: string | null;
  existingStages: PipelineStage[];
  onClose: () => void;
  /**
   * Anchor element used to position the popover. The popover renders into
   * `document.body` via a portal so it escapes the SVG `<foreignObject>` it
   * lives inside (foreignObject does not propagate hit-testing to content
   * rendered outside its bounding rect in Chrome/Safari).
   */
  anchorRef: React.RefObject<HTMLElement | null>;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AddStagePopover({
  flowId,
  afterStageId,
  beforeStageId,
  existingStages,
  onClose,
  anchorRef,
}: AddStagePopoverProps) {
  const t = useTranslations('search_ai.pipeline');
  const addStage = usePipelineStore((s) => s.addStage);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 4,
      left: rect.left + rect.width / 2,
    });
  }, [anchorRef]);

  const options = useMemo(
    () => getValidInsertOptions({ flowId, afterStageId, beforeStageId }, existingStages, t),
    [flowId, afterStageId, beforeStageId, existingStages, t],
  );

  const pipelineOptions = useMemo(
    () => options.filter((o) => !isUtilityStage(o.stageType)),
    [options],
  );
  const utilityOptions = useMemo(
    () => options.filter((o) => isUtilityStage(o.stageType)),
    [options],
  );

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSelect = useCallback(
    (stageType: string) => {
      // Determine insertion order based on surrounding stages
      const afterStage = afterStageId ? existingStages.find((s) => s.id === afterStageId) : null;
      const beforeStage = beforeStageId ? existingStages.find((s) => s.id === beforeStageId) : null;

      const afterOrder = afterStage?.order ?? -1;
      const beforeOrder = beforeStage?.order ?? existingStages.length;
      const newOrder = Math.floor((afterOrder + beforeOrder) / 2) || existingStages.length;

      const newStage: PipelineStage = {
        id: crypto.randomUUID(),
        name: t(getStageLabelKey(stageType)),
        type: stageType,
        provider: getDefaultProvider(stageType),
        providerConfig: {},
        order: newOrder,
      };

      addStage(flowId, newStage);
      onClose();
    },
    [afterStageId, beforeStageId, existingStages, flowId, addStage, onClose, t],
  );

  function renderOption(option: (typeof options)[number]) {
    const Icon = STAGE_ICONS[option.stageType];
    const intent = resolveStageIntent(option.stageType);
    const styles = getIntentStyles(intent);

    const button = (
      <button
        key={option.stageType}
        disabled={option.disabled}
        onClick={() => handleSelect(option.stageType)}
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
          option.disabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-background-muted'
        }`}
      >
        {Icon ? (
          <div
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${styles.bgSubtle}`}
          >
            <Icon className={`h-3.5 w-3.5 ${styles.text}`} />
          </div>
        ) : null}
        <div className="flex-1 overflow-hidden">
          <div className="truncate text-sm font-medium text-foreground">{option.label}</div>
          <div className="truncate text-xs text-foreground-muted">{option.description}</div>
        </div>
      </button>
    );

    if (option.disabled && option.disabledReason) {
      return (
        <Tooltip key={option.stageType} content={option.disabledReason} side="right">
          {button}
        </Tooltip>
      );
    }

    return button;
  }

  if (!position) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 rounded-xl border border-default bg-background-elevated p-1 shadow-xl"
      style={{ minWidth: 220 }}
    >
      {pipelineOptions.length > 0 && (
        <>
          <div className="px-2 py-1 text-xs font-medium text-foreground-muted">
            {t('v2_insert_pipeline_stages')}
          </div>
          {pipelineOptions.map(renderOption)}
        </>
      )}
      {pipelineOptions.length > 0 && utilityOptions.length > 0 && (
        <div className="my-1 border-t border-default" />
      )}
      {utilityOptions.length > 0 && (
        <>
          <div className="px-2 py-1 text-xs font-medium text-foreground-muted">
            {t('v2_insert_utility_stages')}
          </div>
          {utilityOptions.map(renderOption)}
        </>
      )}
    </div>,
    document.body,
  );
}
