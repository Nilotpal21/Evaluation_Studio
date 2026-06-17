'use client';

import { useEffect } from 'react';
import { notFound, useParams, useRouter } from 'next/navigation';
import { useProjectContext, useProjectStateHydrated, useResolvedProject } from '@/lib/project-state';

export default function ProjectRootRedirect() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;
  const project = useResolvedProject(projectId);
  const context = useProjectContext(projectId);
  const hydrated = useProjectStateHydrated();

  useEffect(() => {
    if (!hydrated) return;
    if (!project) return;

    if (context) {
      if (context.lastLaunchedRunId) {
        router.replace(`/projects/${projectId}/evaluations/${context.lastLaunchedRunId}`);
        return;
      }

      const params = new URLSearchParams({
        mode: context.environment,
        agentId: context.selectedAgentId,
      });

      if (context.environment === 'pre_prod' && context.selectedVersionId) {
        params.set('versionId', context.selectedVersionId);
      }

      if (context.environment === 'prod' && context.duration) {
        params.set('duration', context.duration);
      }

      router.replace(`/projects/${projectId}/evaluations/new?${params.toString()}`);
      return;
    }

    router.replace(`/projects/${projectId}/evaluations`);
  }, [context, hydrated, project, projectId, router]);

  if (!project) notFound();

  return null;
}
