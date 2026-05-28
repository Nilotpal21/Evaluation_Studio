import type { HelixConfig, PipelineTemplate, Session, WorkItemType } from '../types.js';
import { SessionManager } from './session-manager.js';

export interface ManagedSessionLoad {
  config: HelixConfig;
  session: Session;
}

type PipelineSelector = (workItemType: WorkItemType) => PipelineTemplate;

export async function loadManagedSessionFromConfigs(
  sessionId: string,
  configs: readonly HelixConfig[],
): Promise<ManagedSessionLoad | null> {
  for (const config of configs) {
    const manager = new SessionManager(config);

    try {
      const session = await manager.load(sessionId);
      return { config, session };
    } catch {
      // Keep trying candidate session directories until one resolves.
    }
  }

  return null;
}

export function resolveResumePipeline(
  session: Pick<Session, 'pipelineSnapshot' | 'workItem'>,
  selectPipeline: PipelineSelector,
): PipelineTemplate {
  const latestPipeline = selectPipeline(session.workItem.type);
  const persistedPipeline = session.pipelineSnapshot;
  if (!persistedPipeline) {
    return latestPipeline;
  }

  return canRefreshPersistedPipeline(persistedPipeline, latestPipeline)
    ? latestPipeline
    : persistedPipeline;
}

function canRefreshPersistedPipeline(
  persistedPipeline: PipelineTemplate,
  latestPipeline: PipelineTemplate,
): boolean {
  if (persistedPipeline.name !== latestPipeline.name) {
    return false;
  }

  if (persistedPipeline.stages.length !== latestPipeline.stages.length) {
    return false;
  }

  return persistedPipeline.stages.every((stage, index) => {
    const latestStage = latestPipeline.stages[index];
    return (
      latestStage != null && stage.name === latestStage.name && stage.type === latestStage.type
    );
  });
}
