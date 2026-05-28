import { NextResponse } from 'next/server';

// Liveness: proves the event loop is responsive. NO external calls.
// If this fails, K8s restarts the container — keep it zero-cost.
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
