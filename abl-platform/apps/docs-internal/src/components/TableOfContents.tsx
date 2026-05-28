'use client';

import clsx from 'clsx';

interface TocHeading {
  level: number;
  text: string;
  id: string;
}

interface TableOfContentsProps {
  content: string;
}

function extractHeadings(content: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const regex = /^(#{2,3})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    headings.push({ level, text, id });
  }

  return headings;
}

export default function TableOfContents({ content }: TableOfContentsProps) {
  const headings = extractHeadings(content);

  if (headings.length === 0) {
    return null;
  }

  return (
    <aside className="sticky top-20 hidden w-48 shrink-0 lg:block">
      <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-500">
        On this page
      </h4>
      <nav>
        <ul className="space-y-1.5 border-l border-gray-200">
          {headings.map((heading) => (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                className={clsx(
                  'block border-l-2 border-transparent py-0.5 text-sm text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-900',
                  heading.level === 2 ? 'pl-3' : 'pl-6',
                )}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
