'use client';

import { AuthCallback } from '@/components/AuthCallback';

export default function AuthCallbackPage() {
  return (
    <AuthCallback
      onComplete={() => {
        window.location.href = '/';
      }}
    />
  );
}
