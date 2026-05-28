/**
 * OrgProfileGenerator Component
 *
 * LLM-assisted organization profile generation with three modes:
 * 1. URL Mode - Fetch from company website
 * 2. Name + Industry Mode - Generate from organization name and industry
 * 3. Paragraph Mode - Extract from description paragraph
 *
 * Part of RFC-001 Phase 2: LLM-Assisted Org Profile Generation
 */

'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  Sparkles,
  Globe,
  Building2,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle,
  DollarSign,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { generateOrgProfile } from '../../api/search-ai';
import type { OrgProfile } from '../../api/search-ai';

interface OrgProfileGeneratorProps {
  indexId: string;
  onGenerated: (profile: OrgProfile) => void;
  className?: string;
}

type GenerationMode = 'url' | 'name-industry' | 'paragraph';

interface GenerationResult {
  profile: OrgProfile;
  cost: number;
  durationMs: number;
}

export function OrgProfileGenerator({ indexId, onGenerated, className }: OrgProfileGeneratorProps) {
  const t = useTranslations('search_ai.kg');

  const [mode, setMode] = useState<GenerationMode>('url');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state for each mode
  const [urlInput, setUrlInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [industryInput, setIndustryInput] = useState('');
  const [paragraphInput, setParagraphInput] = useState('');

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    setResult(null);

    try {
      let input: any;
      if (mode === 'url') {
        if (!urlInput.trim()) {
          setError(t('org_profile_url_required'));
          setIsGenerating(false);
          return;
        }
        input = { url: urlInput.trim() };
      } else if (mode === 'name-industry') {
        if (!nameInput.trim() || !industryInput.trim()) {
          setError(t('org_profile_name_industry_required'));
          setIsGenerating(false);
          return;
        }
        input = { name: nameInput.trim(), industry: industryInput.trim() };
      } else {
        if (!paragraphInput.trim()) {
          setError(t('org_profile_paragraph_required'));
          setIsGenerating(false);
          return;
        }
        input = { description: paragraphInput.trim() };
      }

      const response = await generateOrgProfile(indexId, { mode, input });

      setResult({
        profile: response.data.profile,
        cost: response.data.cost,
        durationMs: response.data.metadata.durationMs,
      });

      toast.success(t('org_profile_generated', { org: response.data.profile.organizationName }));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsGenerating(false);
    }
  }, [mode, urlInput, nameInput, industryInput, paragraphInput, indexId, t]);

  const handleAccept = useCallback(() => {
    if (!result) return;
    onGenerated(result.profile);
    toast.success(t('org_profile_accepted'));
  }, [result, onGenerated, t]);

  const handleReset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  // Mode tabs
  const modes = [
    { id: 'url' as const, label: t('org_profile_mode_url'), icon: Globe },
    { id: 'name-industry' as const, label: t('org_profile_mode_name_industry'), icon: Building2 },
    { id: 'paragraph' as const, label: t('org_profile_mode_paragraph'), icon: FileText },
  ];

  return (
    <Card className={clsx('p-4', className)}>
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-accent" />
        <h4 className="text-sm font-semibold">{t('org_profile_generator_title')}</h4>
        <Badge variant="accent" className="ml-auto text-xs">
          {t('org_profile_llm_powered')}
        </Badge>
      </div>

      <p className="text-xs text-muted mb-4">{t('org_profile_generator_description')}</p>

      {/* Mode selection tabs */}
      <div className="flex gap-2 mb-4 overflow-x-auto">
        {modes.map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              disabled={isGenerating}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 text-xs rounded-lg transition-default whitespace-nowrap',
                'border disabled:opacity-50 disabled:cursor-not-allowed',
                mode === m.id
                  ? 'bg-accent/10 text-accent border-accent'
                  : 'bg-background border-default hover:border-accent/50',
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Input form based on mode */}
      {!result && (
        <div className="space-y-3 mb-4">
          {mode === 'url' && (
            <div>
              <label className="block text-xs font-medium mb-2">{t('org_profile_url_label')}</label>
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/about"
                disabled={isGenerating}
                className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:border-border-focus focus:outline-none transition-default disabled:opacity-50"
              />
              <p className="text-xs text-muted mt-1">{t('org_profile_url_help')}</p>
            </div>
          )}

          {mode === 'name-industry' && (
            <>
              <div>
                <label className="block text-xs font-medium mb-2">
                  {t('org_profile_name_label')}
                </label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Acme Corp"
                  disabled={isGenerating}
                  className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:border-border-focus focus:outline-none transition-default disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-2">
                  {t('org_profile_industry_label')}
                </label>
                <input
                  type="text"
                  value={industryInput}
                  onChange={(e) => setIndustryInput(e.target.value)}
                  placeholder="Financial Services"
                  disabled={isGenerating}
                  className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:border-border-focus focus:outline-none transition-default disabled:opacity-50"
                />
              </div>
            </>
          )}

          {mode === 'paragraph' && (
            <div>
              <label className="block text-xs font-medium mb-2">
                {t('org_profile_paragraph_label')}
              </label>
              <textarea
                value={paragraphInput}
                onChange={(e) => setParagraphInput(e.target.value)}
                placeholder={t('org_profile_paragraph_placeholder')}
                rows={4}
                disabled={isGenerating}
                className="w-full px-3 py-2 text-sm rounded-md border border-default bg-background focus:border-border-focus focus:outline-none transition-default resize-y disabled:opacity-50"
              />
              <p className="text-xs text-muted mt-1">{t('org_profile_paragraph_help')}</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/30">
              <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-medium text-error">{t('common.error')}</p>
                <p className="text-xs text-error/80 mt-1">{error}</p>
              </div>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className={clsx(
              'w-full px-4 py-2.5 text-sm font-medium rounded-md transition-default',
              'bg-accent text-accent-foreground hover:opacity-90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                {t('org_profile_generating')}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 inline mr-2" />
                {t('org_profile_generate_button')}
              </>
            )}
          </button>
        </div>
      )}

      {/* Generated result */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-success/10 border border-success/30">
            <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-success">{t('org_profile_generated_title')}</p>
              <p className="text-xs text-success/80 mt-1">
                {result.profile.organizationName} • {result.profile.keyTerms.length}{' '}
                {t('org_profile_key_terms')} • {Object.keys(result.profile.acronyms).length}{' '}
                {t('org_profile_acronyms')}
              </p>
            </div>
          </div>

          {/* Cost and duration */}
          <div className="flex items-center gap-3 text-xs text-muted">
            <div className="flex items-center gap-1">
              <DollarSign className="w-3 h-3" />
              <span>${result.cost.toFixed(4)}</span>
            </div>
            <div className="flex items-center gap-1">
              <span>{(result.durationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          {/* Profile preview */}
          <div className="p-3 rounded-lg bg-background-muted border border-default">
            <div className="space-y-2">
              <div>
                <p className="text-xs font-medium text-muted">
                  {t('org_profile_organization_name')}
                </p>
                <p className="text-sm">{result.profile.organizationName}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted">{t('org_profile_industry')}</p>
                <p className="text-sm">{result.profile.industry}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted mb-1">
                  {t('org_profile_key_terms')} ({result.profile.keyTerms.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.profile.keyTerms.slice(0, 8).map((term, i) => (
                    <Badge key={i} variant="default" className="text-xs">
                      {term}
                    </Badge>
                  ))}
                  {result.profile.keyTerms.length > 8 && (
                    <Badge variant="default" className="text-xs">
                      +{result.profile.keyTerms.length - 8}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              className="flex-1 px-4 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-default"
            >
              {t('org_profile_accept_button')}
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 text-sm font-medium rounded-md border border-default hover:bg-background-muted transition-default"
            >
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
