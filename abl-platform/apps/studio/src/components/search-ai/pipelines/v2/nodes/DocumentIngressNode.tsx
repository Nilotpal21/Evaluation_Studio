/**
 * Document Ingress Node
 *
 * Simple entry point indicator for the pipeline DAG.
 * Shows a "Documents" label with a file icon.
 * Non-interactive — source handle on right side only.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';
import { getIntentStyles } from '@agent-platform/design-tokens';

function DocumentIngressNodeInner(_props: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const styles = getIntentStyles('muted');

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-4 py-3 ${styles.bgSubtle} ${styles.border}`}
    >
      <FileText className={`h-4 w-4 ${styles.text}`} />
      <span className="text-sm font-medium text-foreground">{t('v2_document_ingress')}</span>
      <Handle type="source" position={Position.Right} className="h-2 w-2" />
    </div>
  );
}

export const DocumentIngressNode = memo(DocumentIngressNodeInner);
