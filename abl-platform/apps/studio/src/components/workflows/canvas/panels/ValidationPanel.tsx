/**
 * ValidationPanel
 *
 * Floating panel that displays validation issues for the current workflow.
 */

'use client';

import { X, AlertTriangle, AlertCircle } from 'lucide-react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

export function ValidationPanel() {
  const validationIssues = useWorkflowCanvasStore((s) => s.validationIssues);
  const setValidationPanelOpen = useWorkflowCanvasStore((s) => s.setValidationPanelOpen);
  const selectNode = useWorkflowCanvasStore((s) => s.selectNode);
  const setConfigPanelOpen = useWorkflowCanvasStore((s) => s.setConfigPanelOpen);

  return (
    <div
      className="absolute top-14 right-4 w-80 bg-background-elevated border border-default rounded-lg shadow-lg z-50"
      data-testid="validation-panel"
    >
      <div className="flex items-center justify-between p-3 border-b border-default">
        <h3 className="text-sm font-semibold">Validation Issues ({validationIssues.length})</h3>
        <button
          onClick={() => setValidationPanelOpen(false)}
          className="p-1 hover:bg-muted rounded"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {validationIssues.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">No issues found</div>
        ) : (
          validationIssues.map((issue, i) => (
            <button
              key={i}
              className="w-full flex items-start gap-2 p-3 hover:bg-muted/50 text-left border-b border-default last:border-0"
              onClick={() => {
                if (issue.nodeId) {
                  selectNode(issue.nodeId);
                  setConfigPanelOpen(true);
                }
                setValidationPanelOpen(false);
              }}
              data-testid={`validation-issue-${i}`}
            >
              {issue.severity === 'error' ? (
                <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              )}
              <span className="text-sm">{issue.message}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
