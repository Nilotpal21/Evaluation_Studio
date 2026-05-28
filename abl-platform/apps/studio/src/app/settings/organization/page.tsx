'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, Plus } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { DetailPageShell } from '@/components/ui/DetailPageShell';

export default function OrganizationSettingsPage() {
  const t = useTranslations('settings.organization');
  const router = useRouter();
  const { accessToken, tenantId } = useAuthStore();

  const [orgName, setOrgName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!orgName.trim() || orgName.trim().length < 2) {
      setError(t('name_min_length'));
      return;
    }
    if (!billingEmail) {
      setError(t('billing_required'));
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/organizations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          name: orgName.trim(),
          billingEmail,
          linkWorkspaceId: tenantId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('create_failed'));
        return;
      }

      setSuccess(true);
      setTimeout(() => router.push('/'), 2000);
    } catch {
      setError(t('error_generic'));
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center">
          <Building2 className="w-12 h-12 text-success mx-auto mb-4" />
          <h1 className="text-xl font-bold text-foreground mb-2">{t('success_title')}</h1>
          <p className="text-muted">{t('success_message')}</p>
        </div>
      </div>
    );
  }

  return (
    <DetailPageShell title={t('title')} description={t('description')} maxWidth="sm">
      <div className="bg-background-subtle border border-default rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-accent-subtle rounded-lg flex items-center justify-center">
            <Plus className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('create_title')}</h2>
            <p className="text-sm text-muted">{t('create_subtitle')}</p>
          </div>
        </div>

        <form onSubmit={handleCreateOrg} className="space-y-4">
          {error && (
            <div className="p-3 bg-error-subtle border border-error rounded-lg text-error text-sm">
              {error}
            </div>
          )}

          <Input
            id="orgName"
            label={t('name_label')}
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            required
            placeholder={t('name_placeholder')}
          />

          <Input
            id="billingEmail"
            label={t('email_label')}
            type="email"
            value={billingEmail}
            onChange={(e) => setBillingEmail(e.target.value)}
            required
            placeholder={t('email_placeholder')}
          />

          <Button
            type="submit"
            loading={isLoading}
            icon={!isLoading ? <Plus className="w-4 h-4" /> : undefined}
          >
            {t('create_button')}
          </Button>
        </form>
      </div>
    </DetailPageShell>
  );
}
