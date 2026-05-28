'use client';

import { useState } from 'react';
import {
  User,
  Bell,
  Sparkles,
  Building2,
  KeyRound,
  Shield,
  Eye,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { personas, tenant } from '@/lib/mock-data';
import { useActivePersona } from '@/lib/persona';
import { Footer } from '@/components/shell/Footer';
import { cn } from '@/lib/utils';

export default function SettingsPage() {
  const persona = useActivePersona();

  const isAdmin = persona.role === 'Credit Union Admin';

  return (
    <div className="space-y-5">
      <header className="pb-4 border-b border-border-muted">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-foreground-muted mt-1.5">
          Manage your profile, notifications, and{' '}
          {isAdmin ? 'tenant-wide' : 'app-author'} preferences.
        </p>
      </header>

      <Section
        icon={User}
        title="Profile"
        description="Your identity within Eltropy. Federated from your CU's directory."
      >
        <FieldGrid>
          <Field label="Name">
            <input
              defaultValue={persona.name}
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            />
          </Field>
          <Field label="Email">
            <input
              defaultValue={persona.email}
              type="email"
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            />
          </Field>
          <Field label="Role">
            <div className="h-9 bg-background-muted/40 border border-border-muted rounded-md px-3 text-sm flex items-center text-foreground-muted">
              {persona.role}
            </div>
          </Field>
          <Field label="Initials avatar">
            <div className="flex items-center gap-2.5">
              <span className="size-9 rounded-full bg-purple/20 text-purple flex items-center justify-center text-xs font-medium">
                {persona.initials}
              </span>
              <button
                type="button"
                className="text-xs text-foreground-muted hover:text-foreground transition-colors"
              >
                Change
              </button>
            </div>
          </Field>
        </FieldGrid>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => toast.success('Profile saved')}
            className="h-8 px-3 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors"
          >
            Save changes
          </button>
        </div>
      </Section>

      <Section
        icon={Bell}
        title="Notifications"
        description="How and when you hear from Eltropy."
      >
        <div className="space-y-2.5">
          <Toggle
            label="In-app notifications"
            description="Bell icon in the topbar — submission updates, evaluation results, Helper suggestions."
            defaultChecked
          />
          <Toggle
            label="Email notifications"
            description="Daily digest of pending submissions and key events."
            defaultChecked
          />
          <Toggle
            label="Mention me when the Helper proposes an action"
            description="Get notified out-of-band when the Helper suggests something that needs your confirmation."
            defaultChecked={false}
          />
          {persona.role === 'Compliance Reviewer' && (
            <Toggle
              label="Page me on high-risk submissions"
              description="SMS notification for submissions touching money-moving tools or member NPI."
              defaultChecked
            />
          )}
        </div>
      </Section>

      <Section
        icon={Sparkles}
        title="AI Helper preferences"
        description="Control how the Helper interacts with you."
      >
        <FieldGrid>
          <Field label="Helper memory">
            <select
              defaultValue="conversation"
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            >
              <option value="conversation">This conversation only</option>
              <option value="session">This session</option>
              <option value="long">Long-term (90 days)</option>
            </select>
          </Field>
          <Field label="Helper opens with">
            <select
              defaultValue="suggestions"
              className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            >
              <option value="suggestions">Contextual suggestions</option>
              <option value="blank">A blank prompt</option>
            </select>
          </Field>
        </FieldGrid>
        <Toggle
          label="Show citations inline"
          description="Display source citations beneath every Helper answer."
          defaultChecked
        />
        <Toggle
          label="Require confirmation for all Helper actions"
          description="The Helper never bypasses approval workflows."
          defaultChecked
          disabled
        />
      </Section>

      {isAdmin && (
        <>
          <Section
            icon={Building2}
            title="Tenant settings"
            description={`Tenant-wide configuration for ${tenant.name}.`}
            adminOnly
          >
            <FieldGrid>
              <Field label="Credit union name">
                <input
                  defaultValue={tenant.name}
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                />
              </Field>
              <Field label="Charter type">
                <select
                  defaultValue={tenant.charter}
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="federal">Federal</option>
                  <option value="state">State</option>
                </select>
              </Field>
              <Field label="Region">
                <input
                  defaultValue={tenant.region}
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                />
              </Field>
              <Field label="Data residency">
                <select
                  defaultValue="us-east"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option>us-east (Virginia)</option>
                  <option>us-west (Oregon)</option>
                  <option>eu-west (Ireland)</option>
                </select>
              </Field>
            </FieldGrid>
          </Section>

          <Section
            icon={KeyRound}
            title="Authentication & session"
            description="Identity provider, MFA, and session lifetime."
            adminOnly
          >
            <FieldGrid>
              <Field label="SSO provider">
                <div className="h-9 bg-background-muted/40 border border-border-muted rounded-md px-3 text-sm flex items-center text-foreground-muted gap-2">
                  <KeyRound className="size-3.5 text-foreground-subtle" />
                  Cornerstone SSO · SAML 2.0
                </div>
              </Field>
              <Field label="MFA requirement">
                <div className="h-9 bg-background-muted/40 border border-border-muted rounded-md px-3 text-sm flex items-center text-success gap-2">
                  <Shield className="size-3.5" />
                  Mandatory (per FFIEC)
                </div>
              </Field>
              <Field label="Idle timeout">
                <select
                  defaultValue="30"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="5">5 minutes</option>
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                </select>
              </Field>
              <Field label="Absolute session lifetime">
                <select
                  defaultValue="8"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="4">4 hours</option>
                  <option value="8">8 hours</option>
                  <option value="12">12 hours</option>
                  <option value="24">24 hours</option>
                </select>
              </Field>
            </FieldGrid>
            <Toggle
              label="Require step-up MFA for sensitive actions"
              description="Approve, deploy, baseline-guardrail edits, credential rotation, membership changes."
              defaultChecked
              disabled
            />
          </Section>

          <Section
            icon={Eye}
            title="Audit & retention"
            description="How long the platform keeps record."
            adminOnly
          >
            <FieldGrid>
              <Field label="Audit log retention">
                <select
                  defaultValue="7"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="3">3 years</option>
                  <option value="5">5 years</option>
                  <option value="7">7 years (recommended)</option>
                  <option value="10">10 years</option>
                </select>
              </Field>
              <Field label="Conversation transcripts">
                <select
                  defaultValue="90"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="365">1 year</option>
                </select>
              </Field>
              <Field label="Helper conversation history">
                <select
                  defaultValue="conversation"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="conversation">This conversation only</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </Field>
              <Field label="Sandbox / synthetic data">
                <select
                  defaultValue="14"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                >
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                </select>
              </Field>
            </FieldGrid>
          </Section>
        </>
      )}

      {isAdmin && (
        <Section
          icon={Trash2}
          title="Delete app"
          description="Permanently delete this tenant's Eltropy workspace, all apps, SOPs, evaluations, and audit history. This cannot be undone."
        >
          <button
            type="button"
            onClick={() => {
              toast.error('Delete app is disabled in this prototype.');
            }}
            className="h-9 px-3.5 rounded-md text-xs font-medium border border-error/30 text-error hover:bg-error-subtle transition-colors flex items-center gap-1.5"
          >
            <Trash2 className="size-3.5" />
            Delete app
          </button>
        </Section>
      )}

      <Footer />
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
  adminOnly,
}: {
  icon: typeof User;
  title: string;
  description: string;
  children: React.ReactNode;
  adminOnly?: boolean;
}) {
  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle p-5">
      <header className="flex items-start gap-3 mb-4">
        <div className="size-8 rounded-md bg-background-elevated border border-border-muted flex items-center justify-center shrink-0">
          <Icon className="size-4 text-foreground-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {adminOnly && (
              <span className="text-[10px] uppercase tracking-wide bg-info-subtle text-info px-1.5 py-0.5 rounded font-medium">
                Admin
              </span>
            )}
          </div>
          <p className="text-xs text-foreground-muted mt-0.5">{description}</p>
        </div>
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  description,
  defaultChecked = false,
  disabled = false,
}: {
  label: string;
  description?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <label
      className={cn(
        'flex items-start gap-3 px-3 py-2.5 rounded-md border border-border-muted bg-background-muted/40 cursor-pointer hover:bg-background-muted/60 transition-colors',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => !disabled && setChecked((c) => !c)}
        disabled={disabled}
        className="mt-0.5 size-3.5 accent-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-[11px] text-foreground-muted mt-0.5 leading-relaxed">
            {description}
          </div>
        )}
      </div>
    </label>
  );
}
