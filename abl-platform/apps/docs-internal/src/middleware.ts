import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

export async function middleware(request: NextRequest) {
  const token = request.cookies.get('docs-session')?.value;

  if (!token) {
    return redirectToSignIn(request);
  }

  const secret = process.env.DOCS_JWT_SECRET;
  if (!secret) {
    return redirectToSignIn(request);
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return NextResponse.next();
  } catch {
    return redirectToSignIn(request);
  }
}

function redirectToSignIn(request: NextRequest): NextResponse {
  const redirectPath = request.nextUrl.pathname + request.nextUrl.search;
  const signInUrl = new URL('/auth/signin', request.url);
  signInUrl.searchParams.set('redirect', redirectPath);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ['/((?!auth/|api/auth/|_next/|favicon\\.ico).*)'],
};
