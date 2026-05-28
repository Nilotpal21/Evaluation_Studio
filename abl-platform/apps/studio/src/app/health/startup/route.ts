import { NextResponse } from 'next/server';

// Startup: if this handler executes, the Next.js server has started.
export function GET() {
  return NextResponse.json({ status: 'started' });
}
