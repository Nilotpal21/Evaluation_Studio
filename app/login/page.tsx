'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { KeyRound, Eye, EyeOff, ArrowRight, Sparkles, Radar, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';

type Stage = 'credentials' | 'mfa';

export default function LoginPage() {
  const signIn = useAuth((s) => s.signIn);
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('credentials');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('pm@evaluation.studio');
  const [password, setPassword] = useState('demo-password');
  const [otp, setOtp] = useState('');

  const handleSSO = () => {
    signIn('sso');
    router.push('/projects');
  };

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    setStage('mfa');
  };

  const handleVerify = (e: FormEvent) => {
    e.preventDefault();
    if (otp.length === 6) {
      signIn('password');
      router.push('/projects');
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.14),_transparent_26%),radial-gradient(circle_at_bottom_left,_rgba(16,185,129,0.08),_transparent_22%),linear-gradient(180deg,rgba(248,250,252,1),rgba(241,245,249,1))] px-4 py-10">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background-subtle px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-foreground-muted">
            <Sparkles className="size-3.5" />
            Evaluation Studio
          </div>
          <div className="space-y-4">
            <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-foreground lg:text-5xl">
              Sign in to evaluate agents before and after production.
            </h1>
            <p className="max-w-xl text-sm leading-7 text-foreground-muted">
              Prototype access includes project-scoped pre-prod qualification, production analysis on
              real traffic windows, validator benchmark policies, live monitoring, revert, and kill
              switch controls.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ['Project -> Pre-prod or Prod', 'Choose a project first, then branch into candidate evaluation or production analysis.'],
              ['Validators drive promotion', 'Platform defaults plus project overrides decide whether a pre-prod version should promote.'],
              ['Monitor, revert, kill', 'Live dashboards track drift and incidents while operators can still revert or stop traffic immediately.'],
            ].map(([title, body], index) => (
              <div key={title} className="rounded-2xl border border-border bg-background-subtle p-4 shadow-sm">
                <div className="mb-3 flex size-8 items-center justify-center rounded-xl border border-border-muted bg-background-muted/70">
                  {index === 0 ? (
                    <Sparkles className="size-4 text-accent" />
                  ) : index === 1 ? (
                    <ShieldCheck className="size-4 text-success" />
                  ) : (
                    <Radar className="size-4 text-info" />
                  )}
                </div>
                <p className="text-sm font-medium text-foreground">{title}</p>
                <p className="mt-2 text-sm leading-6 text-foreground-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/netomi-logo.png"
            alt="netomi"
            className="mb-6 h-12 w-auto"
          />

          <div className="w-full max-w-[420px] rounded-[28px] border border-border bg-background-subtle p-8 shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
        {stage === 'credentials' && (
          <>
            <h1 className="text-xl font-semibold tracking-tight text-center">
              Sign in to Evaluation Studio
            </h1>
            <p className="text-xs text-foreground-muted text-center mt-1.5">
              Manage projects, agent versions, validators, and production controls.
            </p>

            <button
              type="button"
              onClick={handleSSO}
              className="w-full mt-6 h-10 rounded-md bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center justify-center gap-2 text-sm font-medium"
            >
              <KeyRound className="size-4" />
              Continue with Workspace SSO
            </button>
            <p className="text-[11px] text-foreground-subtle text-center mt-2">
              Recommended for project admins, reviewers, and operator workspaces.
            </p>

            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-border-muted" />
              <span className="text-[10px] uppercase tracking-wide text-foreground-meta">
                or sign in with email
              </span>
              <div className="flex-1 h-px bg-border-muted" />
            </div>

            <form onSubmit={handlePasswordSubmit} className="space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
              />
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 pr-9 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground-muted transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <button
                type="submit"
                className="w-full h-10 rounded-md bg-foreground text-background hover:bg-foreground-muted transition-colors flex items-center justify-center gap-2 text-sm font-medium"
              >
                Sign in
                <ArrowRight className="size-3.5" />
              </button>
            </form>

            <div className="flex items-center justify-center mt-5">
              <Link
                href="/forgot-password"
                className="text-xs text-foreground-muted hover:text-foreground transition-colors"
              >
                Forgot password?
              </Link>
            </div>
          </>
        )}

        {stage === 'mfa' && (
          <>
            <h1 className="text-xl font-semibold tracking-tight text-center">
              Verify it&apos;s you
            </h1>
            <p className="text-xs text-foreground-muted text-center mt-1.5">
              Enter the 6-digit code from your authenticator app.
            </p>

            <form onSubmit={handleVerify} className="mt-6 space-y-3">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="w-full h-12 bg-background-muted/60 border border-border-muted rounded-md px-3 text-center text-xl font-mono tracking-[0.5em] text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                autoFocus
              />
              <button
                type="submit"
                disabled={otp.length !== 6}
                className="w-full h-10 rounded-md bg-foreground text-background hover:bg-foreground-muted transition-colors flex items-center justify-center gap-2 text-sm font-medium disabled:bg-background-elevated disabled:text-foreground-subtle disabled:cursor-not-allowed"
              >
                Verify
                <ArrowRight className="size-3.5" />
              </button>
            </form>

            <div className="flex items-center justify-between mt-5 text-xs">
              <button
                type="button"
                onClick={() => setStage('credentials')}
                className="text-foreground-muted hover:text-foreground transition-colors"
              >
                ← Back to sign in
              </button>
              <button
                type="button"
                className="text-foreground-muted hover:text-foreground transition-colors"
              >
                Use a different method
              </button>
            </div>
          </>
        )}
      </div>

          <footer className="mt-6 flex items-center gap-3 text-[11px] text-foreground-subtle">
        <Link href="#" className="hover:text-foreground-muted transition-colors">
          Privacy
        </Link>
        <span>·</span>
        <Link href="#" className="hover:text-foreground-muted transition-colors">
          Terms
        </Link>
        <span>·</span>
        <Link href="#" className="hover:text-foreground-muted transition-colors">
          Need help?
        </Link>
          </footer>
        </div>
      </div>
    </div>
  );
}
