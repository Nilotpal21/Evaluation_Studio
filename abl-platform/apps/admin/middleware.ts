/**
 * Next.js Middleware — Admin Page Redirects Only
 *
 * API routes handle their own auth via `withAdminRoute`.
 * This middleware only redirects unauthenticated page requests to /login.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only handle page requests, not API routes
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Public pages
  if (pathname === '/login' || pathname.startsWith('/_next/')) {
    return NextResponse.next();
  }

  // Check for session cookie — if missing, redirect to login
  const session = request.cookies.get('admin-session');
  if (!session?.value) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
