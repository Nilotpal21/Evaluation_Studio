'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { filterDocsSearchIndex, type DocsSearchResult } from '../lib/docs-search';

interface SearchDocsProps {
  searchIndex: DocsSearchResult[];
}

const MAX_VISIBLE_RESULTS = 8;

export default function SearchDocs({ searchIndex }: SearchDocsProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();
  const results = useMemo(
    () => filterDocsSearchIndex(searchIndex, query).slice(0, MAX_VISIBLE_RESULTS),
    [searchIndex, query],
  );
  const showResults = trimmedQuery.length > 0;

  return (
    <form
      role="search"
      aria-label="Search docs"
      className="relative w-full max-w-md"
      onSubmit={(event) => {
        event.preventDefault();

        const firstResult = results[0];
        if (firstResult) {
          setQuery('');
          router.push(firstResult.href);
        }
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(220,3%,44%)]" />
      <input
        type="search"
        aria-label="Search docs"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search docs"
        className="h-8 w-full rounded-md border border-[hsl(220,3%,90%)] bg-[hsl(220,3%,98%)] pl-9 pr-3 text-[13px] text-[hsl(220,3%,9%)] outline-none transition-colors placeholder:text-[hsl(220,3%,44%)] focus:border-[hsl(220,4%,83%)] focus:bg-white focus:ring-2 focus:ring-[hsl(220,3%,90%)]"
      />

      {showResults && (
        <div className="absolute left-0 right-0 top-10 z-50 overflow-hidden rounded-md border border-[hsl(220,3%,90%)] bg-white shadow-lg">
          {results.length > 0 ? (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((result) => (
                <li key={result.href}>
                  <Link
                    href={result.href}
                    className="block px-3 py-2 text-[13px] transition-colors hover:bg-[hsl(220,3%,94%)]"
                    onClick={() => setQuery('')}
                  >
                    <span className="block font-medium text-[hsl(220,3%,9%)]">{result.title}</span>
                    <span className="mt-0.5 block text-[12px] text-[hsl(220,3%,44%)]">
                      {result.sectionTitle}
                      {result.description ? ` - ${result.description}` : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[13px] text-[hsl(220,3%,44%)]">No docs found</p>
          )}
        </div>
      )}
    </form>
  );
}
