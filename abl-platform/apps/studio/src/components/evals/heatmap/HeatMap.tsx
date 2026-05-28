/**
 * HeatMap Component
 *
 * Main heat map grid showing persona rows x scenario columns.
 * Each cell displays the average score (across all evaluators) for that
 * (persona, scenario) pair, color-coded from red (low) to green (high).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { HeatMapCell } from '@/hooks/useEvalData';
import { HeatMapCellComponent } from './HeatMapCell';
import { HeatMapLegend } from './HeatMapLegend';
import { Tooltip } from '../../ui/Tooltip';

interface HeatMapProps {
  cells: HeatMapCell[];
  personaNames: Record<string, string>;
  scenarioNames: Record<string, string>;
  selectedCell: { personaId: string; scenarioId: string } | null;
  onCellClick: (personaId: string, scenarioId: string) => void;
}

interface AggregatedCell {
  avgScore: number;
  totalCount: number;
}

export function HeatMap({
  cells,
  personaNames,
  scenarioNames,
  selectedCell,
  onCellClick,
}: HeatMapProps) {
  const t = useTranslations('evals');

  // Build the aggregated matrix: for each (persona, scenario) pair, compute
  // the average score across all evaluators.
  const { personaIds, scenarioIds, matrix } = useMemo(() => {
    const pIds = [...new Set(cells.map((c) => c.personaId))];
    const sIds = [...new Set(cells.map((c) => c.scenarioId))];

    const mat = new Map<string, AggregatedCell>();

    for (const cell of cells) {
      const key = `${cell.personaId}::${cell.scenarioId}`;
      const existing = mat.get(key);
      // ClickHouse JSONEachRow serializes count() as a string. Coerce to number
      // to prevent JS string concatenation ("1"+"1"+"1"="111") instead of addition.
      const cellCount = Number(cell.count);
      if (existing) {
        // Incrementally compute weighted average
        const newTotal = existing.totalCount + cellCount;
        const newAvg =
          (existing.avgScore * existing.totalCount + cell.avgScore * cellCount) / newTotal;
        mat.set(key, { avgScore: newAvg, totalCount: newTotal });
      } else {
        mat.set(key, { avgScore: cell.avgScore, totalCount: cellCount });
      }
    }

    return { personaIds: pIds, scenarioIds: sIds, matrix: mat };
  }, [cells]);

  if (cells.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted">
        {t('heatmap.no_data')}
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="border border-default rounded-lg overflow-hidden border-collapse w-full">
          <thead>
            <tr>
              {/* Empty corner cell */}
              <th className="bg-background-muted border border-default px-4 py-3 min-w-[180px]" />
              {scenarioIds.map((sId) => {
                const name = scenarioNames[sId] ?? sId;
                return (
                  <th
                    key={sId}
                    className="bg-background-muted border border-default px-3 py-3 min-w-[120px] max-w-[180px]"
                  >
                    <Tooltip content={name} side="top">
                      <span className="block text-xs font-medium text-muted text-center truncate cursor-default">
                        {name}
                      </span>
                    </Tooltip>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {personaIds.map((pId) => {
              const personaName = personaNames[pId] ?? pId;
              return (
                <tr key={pId}>
                  <td className="bg-background-muted border border-default px-4 py-3 max-w-[200px]">
                    <Tooltip content={personaName} side="right">
                      <span className="block text-xs font-medium text-muted truncate cursor-default">
                        {personaName}
                      </span>
                    </Tooltip>
                  </td>
                  {scenarioIds.map((sId) => {
                    const key = `${pId}::${sId}`;
                    const agg = matrix.get(key);
                    const isSelected =
                      selectedCell?.personaId === pId && selectedCell?.scenarioId === sId;

                    return (
                      <td key={sId} className="border border-default p-0">
                        {agg ? (
                          <HeatMapCellComponent
                            score={agg.avgScore}
                            count={agg.totalCount}
                            isSelected={isSelected}
                            onClick={() => onCellClick(pId, sId)}
                          />
                        ) : (
                          <div className="min-w-[120px] h-16 flex items-center justify-center text-xs text-muted">
                            —
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <HeatMapLegend />
    </div>
  );
}
