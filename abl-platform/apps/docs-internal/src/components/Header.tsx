'use client';

import { LogOut } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { DocsSearchResult } from '../lib/docs-search';
import SearchDocs from './SearchDocs';

interface HeaderProps {
  user: { email: string; name: string; picture: string };
  siteName: string;
  searchIndex: DocsSearchResult[];
}

export default function Header({ user, siteName, searchIndex }: HeaderProps) {
  const initials = user.name?.charAt(0)?.toUpperCase() || '?';

  return (
    <header className="flex h-[49px] items-center justify-between gap-3 border-b border-[hsl(220,4%,83%)] bg-white px-6 py-3">
      <Link
        href="/docs/getting-started"
        className="max-w-[35vw] shrink-0 truncate text-sm font-semibold text-[hsl(220,3%,9%)] hover:text-[hsl(220,3%,36%)]"
      >
        {siteName}
      </Link>

      <div className="min-w-0 flex-1">
        <SearchDocs searchIndex={searchIndex} />
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-2">
          {user.picture ? (
            <Image
              src={user.picture}
              alt={user.name}
              width={28}
              height={28}
              className="h-7 w-7 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[hsl(220,5%,13%)] text-xs font-medium text-white">
              {initials}
            </div>
          )}
          <span className="hidden text-[13px] text-[hsl(220,3%,36%)] sm:inline">{user.name}</span>
        </div>

        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-[hsl(220,3%,44%)] transition-colors hover:bg-[hsl(220,3%,94%)] hover:text-[hsl(220,3%,9%)]"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </form>
      </div>
    </header>
  );
}
