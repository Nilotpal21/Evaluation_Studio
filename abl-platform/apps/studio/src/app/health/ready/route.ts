import { NextResponse } from 'next/server';

// Readiness: checks if the pod can serve traffic.
// Failure removes pod from Service endpoints (no restart).
export async function GET() {
  const { dbReady, isDatabaseAvailable } = await import('@/db');
  await dbReady;
  if (!isDatabaseAvailable()) {
    return NextResponse.json({ status: 'not_ready', reason: 'database' }, { status: 503 });
  }
  return NextResponse.json({ status: 'ready' });
}
