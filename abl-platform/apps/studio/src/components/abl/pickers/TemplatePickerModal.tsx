'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, MessageSquare, Copy, CheckCircle } from 'lucide-react';
import { BasePickerModal, type PickerItem, type PickerTab } from './BasePickerModal';
import { Button } from '../../ui/Button';
import { generateTemplateSnippet } from '../commands/SnippetGenerator';

type TemplatePickerTabId = 'all' | 'multiformat' | 'simple' | 'voice';
type TemplateFormatId = 'default' | 'markdown' | 'html' | 'slack' | 'whatsapp' | 'voice';

interface Template {
  name: string;
  description: string;
  content: string;
  formats?: {
    markdown?: string;
    html?: string;
    slack?: string;
    whatsapp?: string;
  };
  voiceInstructions?: string;
  category: string;
}

interface TemplatePickerItem extends PickerItem {
  templateData: Template;
}

interface TemplatePickerModalProps {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
  initialTab?: TemplatePickerTabId;
}

// Sample system templates
const SYSTEM_TEMPLATES: Template[] = [
  {
    name: 'greeting_formal',
    description: 'Formal greeting message',
    content: 'Hello! Thank you for contacting us. How may I assist you today?',
    formats: {
      markdown: '**Hello!** Thank you for contacting us. How may I assist you today?',
      html: '<p><strong>Hello!</strong> Thank you for contacting us. How may I assist you today?</p>',
    },
    voiceInstructions:
      'Speak warmly with a short pause after the greeting, then ask how you can help.',
    category: 'Greetings',
  },
  {
    name: 'greeting_casual',
    description: 'Casual greeting message',
    content: 'Hey there! 👋 What can I help you with?',
    formats: {
      markdown: 'Hey there! 👋 What can I help you with?',
    },
    category: 'Greetings',
  },
  {
    name: 'escalation_handoff',
    description: 'Escalation to human agent',
    content:
      "I need to connect you with a specialist who can assist you further with this matter. Please hold while I transfer you. Your conversation history will be shared so you don't need to repeat yourself.",
    formats: {
      markdown:
        "I need to connect you with a **specialist** who can assist you further with this matter.\n\nPlease hold while I transfer you. Your conversation history will be shared so you don't need to repeat yourself.",
    },
    voiceInstructions:
      'Use a calm tone. Pause briefly before explaining that the conversation history will be shared.',
    category: 'Coordination',
  },
  {
    name: 'error_fallback',
    description: 'Generic error fallback message',
    content:
      'I apologize, but I encountered an issue processing your request. Please try again or contact support.',
    formats: {
      markdown:
        'I apologize, but I encountered an issue processing your request.\n\nPlease try again or contact support.',
    },
    category: 'Error Handling',
  },
  {
    name: 'session_timeout',
    description: 'Session timeout notification',
    content:
      "Your session has been inactive for a while. For security, I'll need to verify your identity again.",
    formats: {
      markdown:
        "Your session has been inactive for a while.\n\nFor security, I'll need to verify your identity again.",
    },
    voiceInstructions:
      'Speak clearly and keep the security message concise without sounding alarming.',
    category: 'System',
  },
];

const TEMPLATE_TAB_FILTERS: Record<
  TemplatePickerTabId,
  ((item: PickerItem) => boolean) | undefined
> = {
  all: undefined,
  multiformat: (item) => !!(item as TemplatePickerItem).templateData.formats,
  simple: (item) => !(item as TemplatePickerItem).templateData.formats,
  voice: (item) => !!(item as TemplatePickerItem).templateData.voiceInstructions,
};

export function TemplatePickerModal({
  open,
  onClose,
  onInsert,
  initialTab = 'all',
}: TemplatePickerModalProps) {
  const t = useTranslations('abl_editor.template_picker');
  const [copied, setCopied] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<TemplateFormatId>('default');

  const templateTabs: PickerTab[] = useMemo(
    () => [
      { id: 'all', label: t('tab_all') },
      { id: 'multiformat', label: t('tab_multiformat'), filter: TEMPLATE_TAB_FILTERS.multiformat },
      { id: 'simple', label: t('tab_simple'), filter: TEMPLATE_TAB_FILTERS.simple },
      { id: 'voice', label: t('tab_voice'), filter: TEMPLATE_TAB_FILTERS.voice },
    ],
    [t],
  );

  const pickerItems: TemplatePickerItem[] = useMemo(
    () =>
      SYSTEM_TEMPLATES.map((template) => ({
        id: template.name,
        name: template.name,
        description: template.description,
        category: template.category,
        templateData: template,
      })),
    [],
  );

  const generateSnippet = (template: Template): string => {
    return generateTemplateSnippet({
      name: template.name,
      content: template.content,
      formats: template.formats,
      voiceInstructions: template.voiceInstructions,
    });
  };

  const handleCopy = (snippet: string) => {
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderItem = (item: TemplatePickerItem, isSelected: boolean) => {
    const template = item.templateData;
    const hasFormats = template.formats && Object.keys(template.formats).length > 0;
    const hasVoiceInstructions = !!template.voiceInstructions;

    return (
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="mt-0.5">
          <FileText className="w-4 h-4 text-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-sm font-medium text-foreground">{template.name}</span>
            {hasFormats && (
              <span className="text-xs px-1.5 py-0.5 bg-info-subtle text-info border border-info/20 rounded">
                {t('multiformat_badge')}
              </span>
            )}
            {hasVoiceInstructions && (
              <span className="text-xs px-1.5 py-0.5 bg-warning-subtle text-warning border border-warning/20 rounded">
                {t('voice_badge')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted line-clamp-2">{template.description}</p>
        </div>
      </div>
    );
  };

  const renderPreview = (item: TemplatePickerItem | null) => {
    if (!item) {
      return <div className="text-center text-muted">{t('select_preview')}</div>;
    }

    const template = item.templateData;
    const snippet = generateSnippet(template);

    const availableFormats: Array<{ id: TemplateFormatId; label: string }> = [
      { id: 'default', label: 'Default' },
    ];
    if (template.formats?.markdown) availableFormats.push({ id: 'markdown', label: 'Markdown' });
    if (template.formats?.html) availableFormats.push({ id: 'html', label: 'HTML' });
    if (template.formats?.slack) availableFormats.push({ id: 'slack', label: 'Slack' });
    if (template.formats?.whatsapp) availableFormats.push({ id: 'whatsapp', label: 'WhatsApp' });
    if (template.voiceInstructions) availableFormats.push({ id: 'voice', label: 'Voice' });

    const getFormatContent = () => {
      switch (selectedFormat) {
        case 'markdown':
          return template.formats?.markdown || template.content;
        case 'html':
          return template.formats?.html || template.content;
        case 'slack':
          return template.formats?.slack || template.content;
        case 'whatsapp':
          return template.formats?.whatsapp || template.content;
        case 'voice':
          return template.voiceInstructions || template.content;
        default:
          return template.content;
      }
    };

    return (
      <div className="space-y-4">
        {/* Template header */}
        <div>
          <h3 className="text-lg font-semibold text-foreground mb-2">{template.name}</h3>
          <p className="text-sm text-muted">{template.description}</p>
        </div>

        {/* Format tabs */}
        {availableFormats.length > 1 && (
          <div>
            <div className="text-xs font-semibold text-subtle mb-2">{t('formats_label')}</div>
            <div className="flex gap-2 flex-wrap">
              {availableFormats.map((format) => (
                <button
                  key={format.id}
                  onClick={() => setSelectedFormat(format.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-default ${
                    selectedFormat === format.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted hover:text-foreground hover:bg-background-muted border border-default'
                  }`}
                >
                  {format.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Content preview */}
        <div>
          <div className="text-xs font-semibold text-subtle mb-2">{t('preview_label')}</div>
          <div className="p-4 bg-background-muted border border-default rounded-lg text-sm text-foreground whitespace-pre-wrap">
            {getFormatContent()}
          </div>
        </div>

        {/* Generated DSL */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-foreground">{t('generated_dsl')}</h4>
            <button
              onClick={() => handleCopy(snippet)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
            >
              {copied ? (
                <>
                  <CheckCircle className="w-3 h-3" />
                  <span>{t('copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>{t('copy')}</span>
                </>
              )}
            </button>
          </div>
          <pre className="p-4 bg-background-muted border border-default rounded-lg text-xs font-mono text-foreground overflow-x-auto">
            {snippet}
          </pre>
        </div>

        {/* Insert button */}
        <Button
          variant="primary"
          size="md"
          className="w-full"
          onClick={() => {
            onInsert(snippet);
            onClose();
          }}
        >
          {t('insert_at_cursor')}
        </Button>
      </div>
    );
  };

  const createOptions = [
    {
      id: 'multiformat',
      label: t('create_multiformat'),
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => {
        console.log('Create multi-format template');
      },
    },
    {
      id: 'voice',
      label: t('create_voice'),
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => {
        console.log('Create voice template');
      },
    },
    {
      id: 'simple',
      label: t('create_simple'),
      icon: <FileText className="w-4 h-4" />,
      onClick: () => {
        console.log('Create simple template');
      },
    },
  ];

  const footer = (
    <div className="flex items-center gap-4 text-xs text-subtle">
      <span>
        <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-[10px] font-mono">↑↓</kbd>{' '}
        {t('navigate_hint')}
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-[10px] font-mono">⏎</kbd>{' '}
        {t('insert_hint')}
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-[10px] font-mono">Esc</kbd>{' '}
        {t('close_hint')}
      </span>
    </div>
  );

  return (
    <BasePickerModal
      open={open}
      onClose={onClose}
      title={t('title')}
      searchPlaceholder={t('search_placeholder')}
      tabs={templateTabs}
      initialTab={initialTab}
      items={pickerItems}
      categories={['Greetings', 'Coordination', 'Error Handling', 'System']}
      renderItem={renderItem}
      renderPreview={renderPreview}
      onSelect={(item) => {
        const snippet = generateSnippet(item.templateData);
        onInsert(snippet);
        onClose();
      }}
      createOptions={createOptions}
      footer={footer}
      emptyMessage={t('empty_message')}
      loading={false}
    />
  );
}
