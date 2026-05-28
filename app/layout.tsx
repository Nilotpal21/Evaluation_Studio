import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Eltropy — Agentic AI Platform for Credit Unions',
  description:
    'Upload your SOP. The platform builds the agentic app. An AI Helper guides you. Evaluation runs continuously.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} dark`}>
      <body
        suppressHydrationWarning
        className="min-h-screen bg-background text-foreground font-sans antialiased"
      >
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
