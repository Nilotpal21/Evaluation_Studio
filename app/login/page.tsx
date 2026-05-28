'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { KeyRound, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';

type Stage = 'credentials' | 'mfa';

export default function LoginPage() {
  const signIn = useAuth((s) => s.signIn);
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('credentials');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('demo@cornerstone.cu');
  const [password, setPassword] = useState('demo-password');
  const [otp, setOtp] = useState('');

  const handleSSO = () => {
    signIn('sso');
    router.push('/');
  };

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    setStage('mfa');
  };

  const handleVerify = (e: FormEvent) => {
    e.preventDefault();
    if (otp.length === 6) {
      signIn('password');
      router.push('/');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10 bg-background">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/eltropy-logo.png"
        alt="Eltropy"
        className="h-9 w-auto mb-6"
      />

      <div className="w-full max-w-[420px] rounded-2xl border border-border bg-background-elevated p-8 shadow-xl">
        {stage === 'credentials' && (
          <>
            <h1 className="text-xl font-semibold tracking-tight text-center">
              Sign in to Eltropy
            </h1>
            <p className="text-xs text-foreground-muted text-center mt-1.5">
              Build, evaluate, and deploy credit-union AI apps.
            </p>

            <button
              type="button"
              onClick={handleSSO}
              className="w-full mt-6 h-10 rounded-md bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center justify-center gap-2 text-sm font-medium"
            >
              <KeyRound className="size-4" />
              Continue with Cornerstone SSO
            </button>
            <p className="text-[11px] text-foreground-subtle text-center mt-2">
              Federated via your credit union&apos;s identity provider.
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
                placeholder="you@cornerstone.cu"
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
  );
}
