import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getAllSections } from '../../../lib/docs/content';
import { DocsSidebar } from '../../../components/docs/DocsSidebar';

type AccessResult = { status: 'allowed' } | { status: 'unauthenticated' } | { status: 'denied' };

async function checkDocsAccess(
  refreshToken: string | undefined,
  host: string,
  cookie: string,
): Promise<AccessResult> {
  if (!refreshToken) {
    return { status: 'unauthenticated' };
  }

  try {
    // Call the lightweight API route — keeps heavy DB/crypto deps out of this
    // layout's module graph so Turbopack doesn't choke compiling it.
    const protocol = host.startsWith('localhost') ? 'http' : 'https';
    const res = await fetch(`${protocol}://${host}/api/docs/access`, {
      headers: { cookie },
      cache: 'no-store',
    });

    if (res.status === 401) {
      return { status: 'unauthenticated' };
    }
    if (!res.ok) {
      return { status: 'denied' };
    }

    const body = await res.json();
    return body.data?.allowed ? { status: 'allowed' } : { status: 'denied' };
  } catch {
    return { status: 'denied' };
  }
}

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('refresh_token')?.value;
  const headerStore = await headers();
  const host = headerStore.get('host') || 'localhost:5173';
  const cookie = headerStore.get('cookie') || '';

  const access = await checkDocsAccess(refreshToken, host, cookie);

  if (access.status === 'unauthenticated') {
    redirect('/auth/login');
  }

  if (access.status === 'denied') {
    notFound(); // Returns 404, not 403 — no existence leaking
  }

  // Fetch sections for sidebar
  const sections = await getAllSections();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <DocsSidebar sections={sections} />
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-12">
        <article className="docs-prose prose mx-auto max-w-4xl dark:prose-invert">
          {children}
        </article>
      </main>
    </div>
  );
}
