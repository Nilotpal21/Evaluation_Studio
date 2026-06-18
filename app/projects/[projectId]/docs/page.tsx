'use client';

import { notFound, useParams } from 'next/navigation';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { DocsContent } from '@/components/docs/DocsContent';
import { useResolvedProject } from '@/lib/project-state';

export default function ProjectDocsPage() {
  const params = useParams<{ projectId: string }>();
  const project = useResolvedProject(params.projectId);

  if (!project) notFound();

  return (
    <>
      <SyncActiveProject projectId={project.id} />
      <DocsContent />
    </>
  );
}
