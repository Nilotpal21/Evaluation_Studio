/**
 * Test Case List Component
 *
 * Displays suggested and saved test cases
 */

import { useSession } from '../../hooks/useSession';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import type { TestCase } from '../../types';
import { Play, CheckCircle, AlertTriangle, ArrowRightLeft, XCircle, Beaker } from 'lucide-react';
import clsx from 'clsx';

const CATEGORY_CONFIG: Record<
  TestCase['category'],
  {
    icon: typeof Play;
    color: string;
    label: string;
  }
> = {
  happy_path: { icon: CheckCircle, color: 'text-success', label: 'Happy Path' },
  edge_case: { icon: AlertTriangle, color: 'text-warning', label: 'Edge Case' },
  constraint: { icon: Beaker, color: 'text-purple', label: 'Constraint' },
  handoff: { icon: ArrowRightLeft, color: 'text-accent', label: 'Handoff' },
  error: { icon: XCircle, color: 'text-error', label: 'Error' },
};

export function TestCaseList() {
  const { agent } = useSession();
  const { runTest } = useWebSocketContext();

  const tests = agent?.suggestedTests || [];

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center text-subtle text-sm p-4">
        <p className="text-center">Select an agent to see suggested tests</p>
      </div>
    );
  }

  if (tests.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-subtle text-sm p-4">
        <p className="text-center">No test cases available for this agent</p>
      </div>
    );
  }

  // Group tests by category
  const groupedTests = tests.reduce(
    (acc, test) => {
      if (!acc[test.category]) {
        acc[test.category] = [];
      }
      acc[test.category].push(test);
      return acc;
    },
    {} as Record<string, TestCase[]>,
  );

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2 border-b border-default flex items-center justify-between">
        <span className="text-sm font-medium text-muted">Test Cases ({tests.length})</span>
      </div>

      {/* Test Groups */}
      <div className="py-2">
        {Object.entries(groupedTests).map(([category, categoryTests]) => {
          const config = CATEGORY_CONFIG[category as TestCase['category']];
          const Icon = config?.icon || Play;

          return (
            <div key={category} className="mb-4">
              {/* Category Header */}
              <div className="px-3 py-1 flex items-center gap-2">
                <Icon className={clsx('w-4 h-4', config?.color || 'text-muted')} />
                <span className="text-xs font-medium text-muted uppercase">
                  {config?.label || category}
                </span>
                <span className="text-xs text-subtle">({categoryTests.length})</span>
              </div>

              {/* Tests */}
              <div className="space-y-1">
                {categoryTests.map((test) => (
                  <TestCaseItem key={test.id} test={test} onRun={() => runTest(test.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface TestCaseItemProps {
  test: TestCase;
  onRun: () => void;
}

function TestCaseItem({ test, onRun }: TestCaseItemProps) {
  return (
    <div className="px-3 py-2 hover:bg-background-muted transition-colors group">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-foreground truncate">{test.name}</div>
          <div className="text-xs text-subtle line-clamp-2 mt-0.5">{test.description}</div>
          {test.inputs.length > 0 && (
            <div className="text-xs text-subtle mt-1">
              {test.inputs.length} input{test.inputs.length > 1 ? 's' : ''}
            </div>
          )}
        </div>

        <button
          onClick={onRun}
          className="p-1.5 bg-background-elevated hover:bg-background-muted rounded opacity-0 group-hover:opacity-100 transition-opacity"
          title="Run test"
        >
          <Play className="w-4 h-4 text-success" />
        </button>
      </div>
    </div>
  );
}
