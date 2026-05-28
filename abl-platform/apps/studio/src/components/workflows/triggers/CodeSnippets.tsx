'use client';

/**
 * CodeSnippets
 *
 * Displays tabbed curl command snippets for Sync, Async+Poll, and
 * Async Push webhook invocation modes. Each tab shows one or more
 * copyable code blocks. Async+Poll splits into two separate blocks
 * (start execution + poll for result) so each can be copied independently.
 * When a fullApiKey is provided, snippets are copy-paste-ready; otherwise
 * a masked placeholder is shown with a replacement note.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check } from 'lucide-react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CodeSnippetsProps {
  workflowId: string;
  projectId: string;
  apiKeyPrefix: string;
  baseUrl: string;
  fullApiKey?: string;
  callbackUrl?: string;
  callbackAccessToken?: string;
  /** Workflow version to pin in URL (e.g. 'v0.2.0', 'draft') */
  version?: string;
  /**
   * Sample input payload derived from the workflow's inputSchema. When
   * provided, curl `-d` uses this sample; otherwise falls back to an empty
   * object so users see a contract-aligned example out of the box.
   */
  sampleInput?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SnippetMode = 'sync' | 'async_poll' | 'async_push';

interface SnippetBlock {
  /** Optional label rendered above the code block. */
  title?: string;
  /** The curl command text. Does not include a leading `#` comment. */
  code: string;
}

function buildCurl(
  baseUrl: string,
  _projectId: string,
  workflowId: string,
  authKey: string,
  mode: SnippetMode,
  callbackUrl?: string,
  callbackAccessToken?: string,
  version?: string,
  sampleInput?: Record<string, unknown> | null,
): SnippetBlock[] {
  const encodedWfId = encodeURIComponent(workflowId);
  const shortBase = `${baseUrl}/api/v1/workflows/${encodedWfId}/execute`;
  // Compact JSON so the curl line stays copy-paste-safe inside single quotes
  // (pretty-printed JSON with newlines would break shell parsing).
  const inputJson = sampleInput ? JSON.stringify(sampleInput) : '{}';

  // Build query string: mode (when not sync) + version (when set)
  function buildQuery(modeValue?: string): string {
    const parts: string[] = [];
    if (modeValue) parts.push(`mode=${modeValue}`);
    if (version) parts.push(`version=${encodeURIComponent(version)}`);
    return parts.length > 0 ? `?${parts.join('&')}` : '';
  }

  if (mode === 'sync') {
    return [
      {
        code: [
          `curl -X POST '${shortBase}${buildQuery()}' \\`,
          `  -H 'x-api-key: ${authKey}' \\`,
          `  -H 'Content-Type: application/json' \\`,
          `  -d '{"input": ${inputJson}}'`,
        ].join('\n'),
      },
    ];
  }

  if (mode === 'async_push') {
    const cbUrl = callbackUrl || 'https://your-server.com/callback';
    const cbToken = callbackAccessToken || 'your-access-token';
    return [
      {
        code: [
          `curl -X POST '${shortBase}${buildQuery('async_push')}' \\`,
          `  -H 'x-api-key: ${authKey}' \\`,
          `  -H 'Content-Type: application/json' \\`,
          `  -d '{"input": ${inputJson}, "callbackUrl": "${cbUrl}", "accessToken": "${cbToken}"}'`,
        ].join('\n'),
      },
    ];
  }

  // async_poll — two separate blocks so each can be copied independently.
  return [
    {
      title: '1. Start async execution',
      code: [
        `curl -X POST '${shortBase}${buildQuery('async')}' \\`,
        `  -H 'x-api-key: ${authKey}' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"input": ${inputJson}}'`,
      ].join('\n'),
    },
    {
      title: '2. Poll for result (use executionId from step 1)',
      code: [
        `curl '${baseUrl}/api/v1/workflows/${encodedWfId}/executions/{executionId}' \\`,
        `  -H 'x-api-key: ${authKey}'`,
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// SnippetBlockView — one code block with its own copy button
// ---------------------------------------------------------------------------

interface SnippetBlockViewProps {
  displayCode: string;
  copyCode: string;
  title?: string;
  copyAriaLabel: string;
  testId?: string;
}

function SnippetBlockView({
  displayCode,
  copyCode,
  title,
  copyAriaLabel,
  testId,
}: SnippetBlockViewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }, [copyCode]);

  return (
    <div className="space-y-1">
      {title && <p className="text-xs font-medium text-muted">{title}</p>}
      <div className="relative">
        <pre
          className={clsx(
            'text-xs font-mono p-3 rounded-lg overflow-x-auto',
            'bg-background-muted text-foreground border border-default',
            'leading-relaxed whitespace-pre-wrap break-all',
          )}
          data-testid={testId}
        >
          {displayCode}
        </pre>
        <button
          onClick={handleCopy}
          className={clsx(
            'absolute top-2 right-2 p-1.5 rounded-md transition-fast',
            'bg-background-elevated/80 hover:bg-background-elevated',
            'text-muted hover:text-foreground border border-default',
          )}
          aria-label={copyAriaLabel}
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CodeSnippets({
  workflowId,
  projectId,
  apiKeyPrefix,
  baseUrl,
  fullApiKey,
  callbackUrl,
  callbackAccessToken,
  version,
  sampleInput,
}: CodeSnippetsProps) {
  const t = useTranslations('workflows.triggers');
  const [activeTab, setActiveTab] = useState<SnippetMode>('sync');

  const displayKey = fullApiKey
    ? fullApiKey.slice(0, 8) + '************'
    : apiKeyPrefix
      ? apiKeyPrefix + '****...'
      : 'YOUR_API_KEY';

  // Clipboard must carry the same masked string the user sees — never the raw
  // fullApiKey. The earlier mismatch (display masked, copy raw) was a
  // credential-leak vector: users would paste curl snippets into tickets or
  // chats expecting the asterisks they saw on screen.
  const copyKey = displayKey;

  // Snippet is never runnable as-is now (the user must substitute their real
  // key for the asterisks), so always show the replacement note.
  const needsKeyNote = true;

  const tabs: { value: SnippetMode; label: string }[] = useMemo(
    () => [
      { value: 'sync', label: t('sync_mode') },
      { value: 'async_poll', label: t('async_poll_mode') },
      { value: 'async_push', label: t('async_push_mode') },
    ],
    [t],
  );

  const displayBlocks = useMemo(
    () =>
      buildCurl(
        baseUrl,
        projectId,
        workflowId,
        displayKey,
        activeTab,
        callbackUrl,
        callbackAccessToken,
        version,
        sampleInput,
      ),
    [
      baseUrl,
      projectId,
      workflowId,
      displayKey,
      activeTab,
      callbackUrl,
      callbackAccessToken,
      version,
      sampleInput,
    ],
  );

  const copyBlocks = useMemo(
    () =>
      buildCurl(
        baseUrl,
        projectId,
        workflowId,
        copyKey,
        activeTab,
        callbackUrl,
        callbackAccessToken,
        version,
        sampleInput,
      ),
    [
      baseUrl,
      projectId,
      workflowId,
      copyKey,
      activeTab,
      callbackUrl,
      callbackAccessToken,
      version,
      sampleInput,
    ],
  );

  return (
    <div className="space-y-2">
      {/* Replace API key note */}
      {needsKeyNote && <p className="text-xs text-warning">{t('replace_api_key')}</p>}

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-default">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            data-testid={`snippet-tab-${tab.value}`}
            onClick={() => setActiveTab(tab.value)}
            className={clsx(
              'px-3 py-1.5 text-xs font-medium transition-default border-b-2 -mb-px',
              activeTab === tab.value
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Code blocks — one <pre> per block, each with its own copy button */}
      <div className="space-y-2">
        {displayBlocks.map((block, i) => (
          <SnippetBlockView
            key={`${activeTab}-${i}`}
            displayCode={block.code}
            copyCode={copyBlocks[i]?.code ?? block.code}
            title={block.title}
            copyAriaLabel={t('copy_curl')}
            testId={`snippet-code-${activeTab}-${i}`}
          />
        ))}
      </div>
    </div>
  );
}
