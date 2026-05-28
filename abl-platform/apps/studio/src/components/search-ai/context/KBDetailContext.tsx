'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { KnowledgeBaseDetail, SearchAISource } from '../../../api/search-ai';

export interface KBDetailContextValue {
  knowledgeBase: KnowledgeBaseDetail;
  sources: SearchAISource[];
  sourceCount: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  refreshSources: () => void;
}

const KBDetailContext = createContext<KBDetailContextValue | null>(null);

export function KBDetailProvider({
  value,
  children,
}: {
  value: KBDetailContextValue;
  children: ReactNode;
}) {
  return <KBDetailContext.Provider value={value}>{children}</KBDetailContext.Provider>;
}

export function useKBDetail(): KBDetailContextValue {
  const context = useContext(KBDetailContext);
  if (!context) {
    throw new Error('useKBDetail must be used within KBDetailProvider');
  }
  return context;
}
