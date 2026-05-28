'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DeployPanel } from '@/components/deploy';
import { useAuthStore } from '@/store/auth-store';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface Project {
  id: string;
  name: string;
  slug: string;
}

function DeployPageContent() {
  const t = useTranslations('deploy.page');
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  const { accessToken, isAuthenticated } = useAuthStore();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !isAuthenticated) {
      setLoading(false);
      return;
    }

    const fetchProject = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setProject(data.project ?? data);
        } else {
          setError(t('project_not_found'));
        }
      } catch (err) {
        setError(t('failed_to_load'));
      } finally {
        setLoading(false);
      }
    };

    fetchProject();
  }, [projectId, accessToken, isAuthenticated, t]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted mb-4">{t('sign_in_required')}</p>
          <Link href="/auth/signin" className="text-info hover:underline">
            {t('sign_in')}
          </Link>
        </div>
      </div>
    );
  }

  if (!projectId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted mb-4">{t('no_project')}</p>
          <Link href="/" className="text-info hover:underline">
            {t('go_to_dashboard')}
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-error mb-4">{error || t('project_not_found')}</p>
          <Link href="/" className="text-info hover:underline">
            {t('go_to_dashboard')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-muted hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('back_to_dashboard')}
          </Link>
          <h1 className="text-2xl font-bold text-foreground">
            {t('title', { name: project.name })}
          </h1>
          <p className="text-muted text-sm mt-1">{t('subtitle')}</p>
        </div>

        {/* Deploy Panel */}
        <DeployPanel projectId={project.id} projectName={project.name} />
      </div>
    </div>
  );
}

export default function DeployPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
        </div>
      }
    >
      <DeployPageContent />
    </Suspense>
  );
}
