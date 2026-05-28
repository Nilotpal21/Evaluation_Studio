/**
 * Connection OAuth Callback Page
 *
 * Loaded inside the OAuth popup after the provider redirects back.
 * Extracts code+state from URL, posts them to the parent window
 * via postMessage, and the parent (OAuthFlowDialog) handles the API call.
 */

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

const OAUTH_MESSAGE_TYPE = 'oauth-callback';

export default function ConnectionOAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      }
    >
      <ConnectionOAuthCallbackContent />
    </Suspense>
  );
}

function ConnectionOAuthCallbackContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setErrorMessage(error === 'access_denied' ? 'Authorization was denied' : error);
      setStatus('error');
      window.opener?.postMessage({ type: OAUTH_MESSAGE_TYPE, error }, window.location.origin);
      return;
    }

    if (!code || !state) {
      setErrorMessage('Missing authorization code or state');
      setStatus('error');
      window.opener?.postMessage(
        { type: OAUTH_MESSAGE_TYPE, error: 'missing_params' },
        window.location.origin,
      );
      return;
    }

    // Post code+state to parent — parent handles the API call.
    window.opener?.postMessage({ type: OAUTH_MESSAGE_TYPE, code, state }, window.location.origin);
    setStatus('success');

    // Close popup after short delay
    setTimeout(() => window.close(), 1500);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-8">
        {status === 'loading' && (
          <>
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <p className="text-sm text-muted">Processing authorization...</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle className="w-8 h-8 text-success mx-auto" />
            <p className="text-sm text-foreground">
              Authorization complete. This window will close.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="w-8 h-8 text-error mx-auto" />
            <p className="text-sm text-foreground">Authorization failed</p>
            {errorMessage && <p className="text-xs text-muted">{errorMessage}</p>}
            <p className="text-xs text-muted">You can close this window.</p>
          </>
        )}
      </div>
    </div>
  );
}
