/**
 * EmbedCodeDialog Component
 *
 * Shows the embed code snippet for a channel/project.
 */

import { useState, useEffect } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { sanitizeError } from '../../lib/sanitize-error';
import { fetchSdkEmbedCode, SDK_EMBED_FETCH_ERROR } from '../../lib/sdk-embed';

interface EmbedCodeDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  channelId?: string;
  channelName?: string;
}

export function EmbedCodeDialog({
  open,
  onClose,
  projectId,
  channelId,
  channelName,
}: EmbedCodeDialogProps) {
  const t = useTranslations('deployments.embed_dialog');
  const [embedCode, setEmbedCode] = useState('');
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;

    setLoading(true);
    setEmbedError(null);
    fetchSdkEmbedCode(projectId, channelId)
      .then((snippet) => setEmbedCode(snippet))
      .catch((error) => {
        setEmbedCode('');
        setEmbedError(sanitizeError(error, SDK_EMBED_FETCH_ERROR));
      })
      .finally(() => setLoading(false));
  }, [channelId, open, projectId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={channelName ? t('title_with_channel', { name: channelName }) : t('title')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        {loading ? (
          <div className="py-8 text-center text-muted text-sm">{t('loading')}</div>
        ) : embedError ? (
          <div className="flex items-start gap-3 rounded-lg border border-warning bg-warning-subtle p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">{embedError}</p>
          </div>
        ) : (
          <>
            <div className="relative">
              <pre className="p-4 bg-background-muted border border-default rounded-lg overflow-x-auto text-sm text-foreground font-mono">
                <code>{embedCode}</code>
              </pre>
              <button
                onClick={handleCopy}
                className="absolute top-3 right-3 p-1.5 bg-background-elevated border border-default rounded-md hover:bg-background-muted transition-default"
                title={t('copy_to_clipboard')}
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-muted" />
                )}
              </button>
            </div>

            <div className="p-3 rounded-lg bg-accent-subtle border border-accent/20">
              <h4 className="text-sm font-medium text-foreground mb-1">{t('quick_start_title')}</h4>
              <ol className="space-y-0.5 text-xs text-muted">
                <li>{t('quick_start_step1')}</li>
                <li>{t('quick_start_step2')}</li>
                <li>
                  {t('quick_start_step3_prefix')} <code className="text-muted">&lt;/body&gt;</code>{' '}
                  {t('quick_start_step3_suffix')}
                </li>
              </ol>
            </div>
          </>
        )}

        <Button variant="secondary" onClick={onClose} className="w-full">
          {t('close')}
        </Button>
      </div>
    </Dialog>
  );
}
