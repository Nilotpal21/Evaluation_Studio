import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import './globals.css';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import { verifyToken } from '../lib/auth';
import { getDocsConfig } from '../lib/config';
import { getAllSections } from '../lib/content';
import { buildDocsSearchIndex } from '../lib/docs-search';

const fontSans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Agent Platform 2.0 — Internal Docs',
  description: 'Internal documentation for the Agent Platform 2.0 (ABL). Google OAuth protected.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('docs-session');

  let user: { email: string; name: string; picture: string } | null = null;
  let sections: Awaited<ReturnType<typeof getAllSections>> = [];

  if (sessionCookie?.value) {
    user = await verifyToken(sessionCookie.value);
    if (user) {
      sections = await getAllSections();
    }
  }

  return (
    <html lang="en" className={`${fontSans.variable} ${fontMono.variable}`}>
      <body className="min-h-screen bg-[hsl(220,5%,96%)] font-sans antialiased text-[hsl(220,3%,9%)]">
        {user ? (
          <>
            <Header
              user={user}
              siteName={getDocsConfig().siteName}
              searchIndex={buildDocsSearchIndex(sections)}
            />
            <div className="flex h-[calc(100vh-49px)]">
              <Sidebar sections={sections} />
              <main className="flex-1 overflow-y-auto bg-[hsl(220,5%,96%)] p-8">{children}</main>
            </div>
          </>
        ) : (
          <div className="flex min-h-screen items-center justify-center">{children}</div>
        )}
      </body>
    </html>
  );
}
