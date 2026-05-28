/**
 * ToolMockEditor — Per-tool mock configuration UI.
 * Lists tools from agent IR and allows configuring mock responses.
 */

import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSessionStore } from '../../store/session-store';
import { useTestContextStore } from '../../store/test-context-store';
import type { ToolMockConfig } from '../../types/test-context';
import clsx from 'clsx';

function extractToolNames(ir: unknown): string[] {
  if (!ir || typeof ir !== 'object') return [];
  const agentIR = ir as Record<string, unknown>;
  const tools = agentIR.tools as Array<{ name: string }> | undefined;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => t.name);
}

export function ToolMockEditor() {
  const t = useTranslations('test_context.tool_mock');
  const agent = useSessionStore((s) => s.agent);
  const toolMocks = useTestContextStore((s) => s.toolMocks);
  const addToolMock = useTestContextStore((s) => s.addToolMock);
  const updateToolMock = useTestContextStore((s) => s.updateToolMock);
  const removeToolMock = useTestContextStore((s) => s.removeToolMock);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const availableTools = agent?.ir ? extractToolNames(agent.ir) : [];
  const mockedToolNames = new Set(toolMocks.map((m) => m.toolName));
  const unmockedTools = availableTools.filter((t) => !mockedToolNames.has(t));

  const handleAddMock = (toolName: string) => {
    addToolMock({
      toolName,
      response: { success: true, data: {} },
      success: true,
    });
    setExpandedIndex(toolMocks.length); // expand the newly added one
  };

  return (
    <div className="space-y-2">
      {toolMocks.map((mock, index) => (
        <MockItem
          key={`${mock.toolName}-${index}`}
          mock={mock}
          index={index}
          expanded={expandedIndex === index}
          onToggle={() => setExpandedIndex(expandedIndex === index ? null : index)}
          onUpdate={(m) => updateToolMock(index, m)}
          onRemove={() => {
            removeToolMock(index);
            if (expandedIndex === index) setExpandedIndex(null);
          }}
        />
      ))}

      {/* Add mock button */}
      {unmockedTools.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <select
            onChange={(e) => {
              if (e.target.value) {
                handleAddMock(e.target.value);
                e.target.value = '';
              }
            }}
            className="flex-1 px-2 py-1 text-xs bg-background-elevated border border-default rounded text-muted"
            defaultValue=""
          >
            <option value="" disabled>
              {t('add_tool_mock')}
            </option>
            {unmockedTools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      ) : availableTools.length === 0 ? (
        <button
          onClick={() => handleAddMock('')}
          className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
        >
          <Plus className="w-3 h-3" />
          {t('add_custom_mock')}
        </button>
      ) : null}
    </div>
  );
}

interface MockItemProps {
  mock: ToolMockConfig;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (mock: ToolMockConfig) => void;
  onRemove: () => void;
}

function MockItem({ mock, expanded, onToggle, onUpdate, onRemove }: MockItemProps) {
  const t = useTranslations('test_context.tool_mock');
  return (
    <div className="border border-default rounded bg-background-subtle">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer" onClick={onToggle}>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-subtle" />
        ) : (
          <ChevronRight className="w-3 h-3 text-subtle" />
        )}
        <span className="text-xs font-mono text-accent flex-1">
          {mock.toolName || t('unnamed')}
        </span>
        <span
          className={clsx(
            'text-xs px-1.5 py-0.5 rounded',
            mock.success !== false
              ? 'bg-success-subtle text-success'
              : 'bg-error-subtle text-error',
          )}
        >
          {mock.success !== false ? t('success') : t('error')}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="p-0.5 text-subtle hover:text-error"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="px-2 pb-2 space-y-2 border-t border-default">
          {/* Tool name (editable if not from IR) */}
          <div className="pt-2">
            <label className="text-xs text-subtle">{t('tool_name')}</label>
            <input
              type="text"
              value={mock.toolName}
              onChange={(e) => onUpdate({ ...mock, toolName: e.target.value })}
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono"
            />
          </div>

          {/* Success/Error toggle */}
          <div>
            <label className="text-xs text-subtle">{t('result')}</label>
            <div className="flex gap-2 mt-0.5">
              <button
                onClick={() => onUpdate({ ...mock, success: true, error: undefined })}
                className={clsx(
                  'px-2 py-0.5 text-xs rounded border',
                  mock.success !== false
                    ? 'border-success bg-success-subtle text-success'
                    : 'border-default text-muted hover:border-success',
                )}
              >
                {t('success_btn')}
              </button>
              <button
                onClick={() =>
                  onUpdate({
                    ...mock,
                    success: false,
                    error: mock.error || { code: 'ERROR', message: 'Mock error' },
                  })
                }
                className={clsx(
                  'px-2 py-0.5 text-xs rounded border',
                  mock.success === false
                    ? 'border-error bg-error-subtle text-error'
                    : 'border-default text-muted hover:border-error',
                )}
              >
                {t('error_btn')}
              </button>
            </div>
          </div>

          {/* Response JSON */}
          <div>
            <label className="text-xs text-subtle">
              {mock.success !== false ? t('response') : t('error')}
            </label>
            <textarea
              value={
                mock.success !== false
                  ? JSON.stringify(mock.response, null, 2)
                  : JSON.stringify(mock.error, null, 2)
              }
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  if (mock.success !== false) {
                    onUpdate({ ...mock, response: parsed });
                  } else {
                    onUpdate({ ...mock, error: parsed });
                  }
                } catch {
                  // Invalid JSON — don't update
                }
              }}
              rows={3}
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono resize-y"
            />
          </div>

          {/* Delay */}
          <div>
            <label className="text-xs text-subtle">{t('delay_ms')}</label>
            <input
              type="number"
              value={mock.delayMs || 0}
              onChange={(e) => onUpdate({ ...mock, delayMs: Number(e.target.value) || undefined })}
              min={0}
              max={30000}
              step={100}
              className="w-24 px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono"
            />
          </div>
        </div>
      )}
    </div>
  );
}
