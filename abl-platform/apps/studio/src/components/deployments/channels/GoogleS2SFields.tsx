/**
 * Google Gemini Live S2S Configuration Fields
 */

'use client';

import { useTranslations } from 'next-intl';
import { Select } from '../../ui/Select';
import { Input } from '../../ui/Input';

interface GoogleS2SFieldsProps {
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

function parseOptionalNumberInput(value: string): number | undefined {
  if (value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const GEMINI_MODELS = [
  { value: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live (Latest)' },
  { value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (Experimental)' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Stable)' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
];

const GEMINI_VOICES = [
  // Popular — most recommended across tutorials and community
  { value: 'Puck', label: '⭐ Puck — Upbeat' },
  { value: 'Kore', label: '⭐ Kore — Firm' },
  { value: 'Charon', label: '⭐ Charon — Informative' },
  { value: 'Aoede', label: '⭐ Aoede — Breezy' },
  { value: 'Fenrir', label: '⭐ Fenrir — Excitable' },
  // All voices A-Z
  { value: 'Achernar', label: 'Achernar — Soft' },
  { value: 'Achird', label: 'Achird — Friendly' },
  { value: 'Algenib', label: 'Algenib — Gravelly' },
  { value: 'Algieba', label: 'Algieba — Smooth' },
  { value: 'Alnilam', label: 'Alnilam — Firm' },
  { value: 'Autonoe', label: 'Autonoe — Bright' },
  { value: 'Callirrhoe', label: 'Callirrhoe — Easy-going' },
  { value: 'Despina', label: 'Despina — Smooth' },
  { value: 'Enceladus', label: 'Enceladus — Breathy' },
  { value: 'Erinome', label: 'Erinome — Clear' },
  { value: 'Gacrux', label: 'Gacrux — Mature' },
  { value: 'Iapetus', label: 'Iapetus — Clear' },
  { value: 'Laomedeia', label: 'Laomedeia — Upbeat' },
  { value: 'Leda', label: 'Leda — Youthful' },
  { value: 'Orus', label: 'Orus — Firm' },
  { value: 'Pulcherrima', label: 'Pulcherrima — Forward' },
  { value: 'Rasalgethi', label: 'Rasalgethi — Informative' },
  { value: 'Sadachbia', label: 'Sadachbia — Lively' },
  { value: 'Sadaltager', label: 'Sadaltager — Knowledgeable' },
  { value: 'Schedar', label: 'Schedar — Even' },
  { value: 'Sulafat', label: 'Sulafat — Warm' },
  { value: 'Umbriel', label: 'Umbriel — Easy-going' },
  { value: 'Vindemiatrix', label: 'Vindemiatrix — Gentle' },
  { value: 'Zephyr', label: 'Zephyr — Bright' },
  { value: 'Zubenelgenubi', label: 'Zubenelgenubi — Casual' },
];

const START_SENSITIVITY_OPTIONS = [
  { value: 'START_SENSITIVITY_UNSPECIFIED', label: 'Default' },
  { value: 'START_SENSITIVITY_LOW', label: 'Low - fewer false starts' },
  { value: 'START_SENSITIVITY_HIGH', label: 'High - detect speech sooner' },
];

const END_SENSITIVITY_OPTIONS = [
  { value: 'END_SENSITIVITY_UNSPECIFIED', label: 'Default' },
  { value: 'END_SENSITIVITY_LOW', label: 'Low - allow longer pauses' },
  { value: 'END_SENSITIVITY_HIGH', label: 'High - end turns sooner' },
];

const RECOMMENDED_SILENCE_DURATION_MS = 100;
const RECOMMENDED_PREFIX_PADDING_MS = 20;

export function GoogleS2SFields({ config, onChange }: GoogleS2SFieldsProps) {
  const t = useTranslations('channels.config.google_s2s');
  const temperature = (config.s2sTemperature as number | undefined) ?? 1.0;
  const startSensitivity =
    (config.s2sStartSensitivity as string | undefined) || 'START_SENSITIVITY_UNSPECIFIED';
  const endSensitivity =
    (config.s2sEndSensitivity as string | undefined) || 'END_SENSITIVITY_UNSPECIFIED';
  const hasSilenceDuration = Object.prototype.hasOwnProperty.call(config, 's2sSilenceDuration');
  const hasPrefixPadding = Object.prototype.hasOwnProperty.call(config, 's2sPrefixPadding');
  const silenceDuration =
    (config.s2sSilenceDuration as number | undefined) ??
    (hasSilenceDuration ? '' : RECOMMENDED_SILENCE_DURATION_MS);
  const prefixPadding =
    (config.s2sPrefixPadding as number | undefined) ??
    (hasPrefixPadding ? '' : RECOMMENDED_PREFIX_PADDING_MS);

  return (
    <div className="space-y-4 p-4 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        Google Gemini Live Configuration
      </h5>

      <Select
        label="Model"
        options={GEMINI_MODELS}
        value={(config.s2sModel as string) || 'gemini-2.0-flash-exp'}
        onChange={(value) => onChange('s2sModel', value)}
      />

      <Select
        label="Voice"
        options={GEMINI_VOICES}
        value={(config.s2sVoice as string) || 'Puck'}
        onChange={(value) => onChange('s2sVoice', value)}
      />

      <div>
        <label
          htmlFor="gemini-temperature"
          className="block text-sm font-medium text-foreground mb-2"
        >
          Temperature: {temperature}
        </label>
        <input
          type="range"
          id="gemini-temperature"
          min="0"
          max="2"
          step="0.1"
          value={temperature}
          onChange={(e) => onChange('s2sTemperature', parseFloat(e.target.value))}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-xs text-muted mt-1">
          <span>Deterministic (0.0)</span>
          <span>Creative (2.0)</span>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-default bg-background-subtle p-4">
        <div>
          <h6 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            {t('vad_title')}
          </h6>
          <p className="mt-1 text-xs text-muted">{t('vad_description')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Select
              label="Start Sensitivity"
              options={START_SENSITIVITY_OPTIONS}
              value={startSensitivity}
              onChange={(value) => onChange('s2sStartSensitivity', value)}
            />
            <p className="text-xs text-muted mt-1">{t('start_sensitivity_help')}</p>
          </div>

          <div>
            <Select
              label="End Sensitivity"
              options={END_SENSITIVITY_OPTIONS}
              value={endSensitivity}
              onChange={(value) => onChange('s2sEndSensitivity', value)}
            />
            <p className="text-xs text-muted mt-1">{t('end_sensitivity_help')}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Input
              id="gemini-silence-duration"
              label="Silence Duration (ms)"
              type="number"
              placeholder={String(RECOMMENDED_SILENCE_DURATION_MS)}
              value={String(silenceDuration)}
              aria-describedby="gemini-silence-duration-help"
              onChange={(e) =>
                onChange('s2sSilenceDuration', parseOptionalNumberInput(e.target.value))
              }
            />
            <p id="gemini-silence-duration-help" className="text-xs text-muted mt-1">
              {t('silence_duration_help')}
            </p>
          </div>
          <div>
            <Input
              id="gemini-prefix-padding"
              label="Prefix Padding (ms)"
              type="number"
              placeholder={String(RECOMMENDED_PREFIX_PADDING_MS)}
              value={String(prefixPadding)}
              aria-describedby="gemini-prefix-padding-help"
              onChange={(e) =>
                onChange('s2sPrefixPadding', parseOptionalNumberInput(e.target.value))
              }
            />
            <p id="gemini-prefix-padding-help" className="text-xs text-muted mt-1">
              {t('prefix_padding_help')}
            </p>
          </div>
        </div>
      </div>

      <div className="pt-2 border-t border-default">
        <p className="text-xs text-muted">
          Google Gemini Live provides multimodal voice conversations with low latency.{' '}
          <a
            href="https://ai.google.dev/gemini-api/docs/models/gemini-v2"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            View documentation →
          </a>
        </p>
      </div>
    </div>
  );
}
