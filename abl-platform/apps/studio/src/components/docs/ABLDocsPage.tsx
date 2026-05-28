/**
 * ABL Documentation Page
 *
 * Browsable documentation with sidebar topic list and markdown content area.
 * Topics are loaded from /api/abl/docs and rendered as preformatted markdown.
 */

'use client';

import { Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Search, BookOpen, ChevronRight, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopicMeta {
  id: string;
  title: string;
  category: string;
}

interface TopicContent {
  id: string;
  title: string;
  category: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Inner component that uses useSearchParams (requires Suspense boundary)
// ---------------------------------------------------------------------------

function ABLDocsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [topics, setTopics] = useState<TopicMeta[]>([]);
  const [activeTopic, setActiveTopic] = useState<TopicContent | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);

  // Load topic index on mount
  useEffect(() => {
    let cancelled = false;
    async function loadTopics() {
      try {
        const res = await apiFetch('/api/abl/docs');
        const data = await res.json();
        if (!cancelled && data.success) {
          setTopics(data.topics);
        }
      } catch (err) {
        console.error('Failed to load docs topics:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadTopics();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadTopic = useCallback(async (topicId: string) => {
    setContentLoading(true);
    try {
      const res = await apiFetch(`/api/abl/docs?topic=${encodeURIComponent(topicId)}`);
      const data = await res.json();
      if (data.success && data.topic) {
        setActiveTopic(data.topic);
      }
    } catch (err) {
      console.error('Failed to load topic:', err);
    } finally {
      setContentLoading(false);
    }
  }, []);

  // Load topic from URL param or default to first available topic
  const topicParam = searchParams.get('topic');
  useEffect(() => {
    if (topics.length === 0) return;
    const firstTopicId = topics[0]?.id;
    const targetTopic = topicParam || firstTopicId;
    if (!targetTopic) return;
    if (!activeTopic || activeTopic.id !== targetTopic) {
      loadTopic(targetTopic);
    }
  }, [topicParam, topics, loadTopic, activeTopic]);

  const selectTopic = useCallback(
    (topicId: string) => {
      router.push(`/docs/abl?topic=${topicId}`, { scroll: false });
      loadTopic(topicId);
    },
    [router, loadTopic],
  );

  // Group topics by category, filtered by search
  const groupedTopics = useMemo(() => {
    const groups: Record<string, TopicMeta[]> = {};
    const filtered = searchQuery
      ? topics.filter((t) => t.title.toLowerCase().includes(searchQuery.toLowerCase()))
      : topics;
    for (const topic of filtered) {
      if (!groups[topic.category]) groups[topic.category] = [];
      groups[topic.category].push(topic);
    }
    return groups;
  }, [topics, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
        <span className="ml-2 text-muted text-sm">Loading documentation...</span>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar */}
      <div className="w-[260px] flex-shrink-0 border-r border-default bg-background-subtle flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-default">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BookOpen className="w-4 h-4 text-accent" />
            ABL Documentation
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-default">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-subtle" />
            <input
              type="text"
              placeholder="Filter topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-background-muted border border-default rounded-md focus:outline-none focus:border-border-focus transition-default placeholder:text-subtle"
            />
          </div>
        </div>

        {/* Topic list */}
        <div className="flex-1 overflow-y-auto py-2">
          {Object.entries(groupedTopics).map(([category, categoryTopics]) => (
            <div key={category} className="mb-3">
              <div className="px-4 py-1 text-xs font-semibold uppercase tracking-wider text-subtle">
                {category}
              </div>
              {categoryTopics.map((topic) => (
                <button
                  key={topic.id}
                  onClick={() => selectTopic(topic.id)}
                  className={clsx(
                    'w-full text-left px-4 py-1.5 text-xs transition-default flex items-center gap-2',
                    activeTopic?.id === topic.id
                      ? 'text-accent bg-accent-subtle font-medium'
                      : 'text-muted hover:text-foreground hover:bg-background-muted',
                  )}
                >
                  <ChevronRight
                    className={clsx(
                      'w-3 h-3 flex-shrink-0 transition-transform',
                      activeTopic?.id === topic.id && 'rotate-90',
                    )}
                  />
                  {topic.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {contentLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
            <span className="ml-2 text-muted text-sm">Loading...</span>
          </div>
        ) : activeTopic ? (
          <div className="max-w-4xl mx-auto px-8 py-6">
            {/* Topic header */}
            <div className="mb-6 pb-4 border-b border-default">
              <div className="text-xs text-subtle mb-1">{activeTopic.category}</div>
              <h1 className="text-xl font-semibold text-foreground">{activeTopic.title}</h1>
            </div>

            {/* Markdown content rendered as preformatted text */}
            <div className="prose prose-sm max-w-none">
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground-muted bg-transparent p-0 border-none">
                {activeTopic.content}
              </pre>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted">
            <BookOpen className="w-12 h-12 mb-4 text-subtle" />
            <p className="text-sm">Select a topic from the sidebar</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public export with Suspense boundary (required for useSearchParams)
// ---------------------------------------------------------------------------

export function ABLDocsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full bg-background">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
          <span className="ml-2 text-muted text-sm">Loading documentation...</span>
        </div>
      }
    >
      <ABLDocsContent />
    </Suspense>
  );
}
