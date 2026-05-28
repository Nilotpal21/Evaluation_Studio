/**
 * CallControls — In-call action buttons.
 *
 * Mute/unmute, hold/resume, show keypad, and hangup.
 */

import { Mic, MicOff, Pause, Play, Grid3X3, PhoneOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface CallControlsProps {
  isMuted: boolean;
  isOnHold: boolean;
  showKeypad: boolean;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleKeypad: () => void;
  onHangup: () => void;
}

export function CallControls({
  isMuted,
  isOnHold,
  showKeypad,
  onToggleMute,
  onToggleHold,
  onToggleKeypad,
  onHangup,
}: CallControlsProps) {
  const t = useTranslations('softphone');

  return (
    <div className="flex items-center justify-center gap-3">
      {/* Mute */}
      <button
        type="button"
        onClick={onToggleMute}
        className={`p-3 rounded-full transition-default ${
          isMuted
            ? 'bg-error/15 text-error'
            : 'bg-background-subtle hover:bg-background-muted text-foreground'
        }`}
        title={isMuted ? t('unmute') : t('mute')}
      >
        {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
      </button>

      {/* Hold */}
      <button
        type="button"
        onClick={onToggleHold}
        className={`p-3 rounded-full transition-default ${
          isOnHold
            ? 'bg-warning/15 text-warning'
            : 'bg-background-subtle hover:bg-background-muted text-foreground'
        }`}
        title={isOnHold ? t('resume') : t('hold')}
      >
        {isOnHold ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
      </button>

      {/* Keypad */}
      <button
        type="button"
        onClick={onToggleKeypad}
        className={`p-3 rounded-full transition-default ${
          showKeypad
            ? 'bg-accent/15 text-accent'
            : 'bg-background-subtle hover:bg-background-muted text-foreground'
        }`}
        title={t('keypad')}
      >
        <Grid3X3 className="w-5 h-5" />
      </button>

      {/* Hangup */}
      <button
        type="button"
        onClick={onHangup}
        className="p-3 rounded-full bg-error text-error-foreground hover:bg-error/90 transition-default"
        title={t('hangup')}
      >
        <PhoneOff className="w-5 h-5" />
      </button>
    </div>
  );
}
