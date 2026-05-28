'use client';

import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { initializeAuth } from '@/api/auth';

const DeviceAuth = dynamic(
  () => import('@/components/DeviceAuth').then((m) => ({ default: m.DeviceAuth })),
  { ssr: false },
);

export default function DeviceAuthPage() {
  const initRef = useRef(false);

  // This page bypasses the SPA shell (App.tsx), so auth must be initialized here.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    initializeAuth();
  }, []);

  return <DeviceAuth />;
}
