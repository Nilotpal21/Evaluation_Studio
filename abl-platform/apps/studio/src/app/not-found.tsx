import { FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('auth.not_found');

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-8">
      <FileQuestion className="w-16 h-16 text-muted mb-6" />
      <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
      <p className="text-muted text-lg mb-8 text-center max-w-md">{t('message')}</p>
      <Link
        href="/"
        className="px-6 py-2.5 text-sm font-medium text-accent-foreground bg-accent rounded-lg hover:bg-accent/90 transition-default"
      >
        {t('go_home')}
      </Link>
    </div>
  );
}
