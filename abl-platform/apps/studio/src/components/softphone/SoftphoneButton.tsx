/**
 * SoftphoneButton — Header phone icon with popover.
 *
 * Renders the phone icon in the Studio header. When clicked, opens the
 * SoftphonePopover for making calls. Shows a green pulse when a call is active.
 * Hides itself if no voice channel connections with phone numbers exist.
 */

'use client';

import { useRef, useEffect, useCallback } from 'react';
import { Phone, AlertTriangle } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import Script from 'next/script';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '../../store/auth-store';
import { useSoftphone } from '../../hooks/useSoftphone';
import { useSoftphoneStore } from '../../store/softphone-store';
import { SoftphonePopover } from './SoftphonePopover';

interface SoftphoneButtonProps {
  projectId: string;
}

export function SoftphoneButton({ projectId }: SoftphoneButtonProps) {
  const t = useTranslations('app_shell');
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const user = useAuthStore((s) => s.user);

  // Don't initialize softphone until auth is complete
  if (isAuthLoading || !user) {
    return null;
  }

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const isOpen = useSoftphoneStore((s) => s.isOpen);
  const setOpen = useSoftphoneStore((s) => s.setOpen);

  const {
    registrationStatus,
    callState,
    phoneNumbers,
    selectedNumber,
    callStartTime,
    isMuted,
    isOnHold,
    showKeypad,
    view,
    lastError,
    makeCall,
    hangup,
    sendDTMF,
    toggleMute,
    toggleHold,
    hasVoiceNumbers,
    ready,
    projectWarning,
    projectWarningDetails,
  } = useSoftphone({ projectId, remoteAudioRef });

  const setSelectedNumber = useSoftphoneStore((s) => s.setSelectedNumber);
  const setShowKeypad = useSoftphoneStore((s) => s.setShowKeypad);
  const setView = useSoftphoneStore((s) => s.setView);
  const setError = useSoftphoneStore((s) => s.setError);
  const recordingEnabled = useSoftphoneStore((s) => s.recordingEnabled);
  const setRecordingEnabled = useSoftphoneStore((s) => s.setRecordingEnabled);
  const recordingUrl = useSoftphoneStore((s) => s.recordingUrl);
  const setRecordingUrl = useSoftphoneStore((s) => s.setRecordingUrl);

  // Clear errors when popover opens
  useEffect(() => {
    if (isOpen) {
      setError(null);
    }
  }, [isOpen, setError]);

  const handleCall = useCallback(
    (number: string) => {
      setError(null);
      void makeCall(number);
    },
    [makeCall, setError],
  );

  const isCallActive = callState !== 'idle';

  // Don't render if no voice numbers configured
  if (!hasVoiceNumbers) return null;

  return (
    <>
      {/* Load AudioCodes SDK lazily */}
      <Script src="/js/ac_webrtc.min.js" strategy="lazyOnload" />

      {/* Hidden audio element for remote call audio — rendered at header level for persistence */}
      <audio ref={remoteAudioRef} autoPlay style={{ display: 'none' }} />

      {!ready ? (
        /* Grayed-out phone icon with warning badge when Jambonz not configured */
        <button
          className="relative p-2 text-muted/40 cursor-not-allowed rounded-lg hidden sm:block"
          title="Kore Voicegateway not configured for making test calls"
          disabled
        >
          <Phone className="w-4 h-4" />
          <AlertTriangle className="absolute -top-0.5 -right-0.5 w-3 h-3 text-warning" />
        </button>
      ) : (
        <Popover.Root open={isOpen} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              className="relative p-2 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default hidden sm:block"
              title={t('softphone')}
            >
              <Phone className="w-4 h-4" />
              {/* Active call pulse indicator */}
              {isCallActive && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-success animate-pulse" />
              )}
              {/* Registered indicator (subtle) */}
              {!isCallActive && projectWarning && (
                <AlertTriangle className="absolute -top-0.5 -right-0.5 w-3 h-3 text-warning" />
              )}
              {!isCallActive && !projectWarning && registrationStatus === 'registered' && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-success" />
              )}
            </button>
          </Popover.Trigger>

          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={8}
              className="z-50 animate-in fade-in-0 zoom-in-95"
            >
              <SoftphonePopover
                registrationStatus={registrationStatus}
                callState={callState}
                phoneNumbers={phoneNumbers}
                selectedNumber={selectedNumber}
                callStartTime={callStartTime}
                isMuted={isMuted}
                isOnHold={isOnHold}
                showKeypad={showKeypad}
                view={view}
                lastError={lastError}
                projectWarning={projectWarning}
                projectWarningDetails={projectWarningDetails}
                onSelectNumber={(num) => {
                  setSelectedNumber(num);
                  setError(null);
                }}
                onCall={handleCall}
                onHangup={hangup}
                onSendDTMF={sendDTMF}
                onToggleMute={toggleMute}
                onToggleHold={toggleHold}
                onToggleKeypad={setShowKeypad}
                onSetView={setView}
                onDismissError={() => setError(null)}
                recordingEnabled={recordingEnabled}
                recordingUrl={recordingUrl}
                onToggleRecording={setRecordingEnabled}
                onClearRecording={() => {
                  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
                  setRecordingUrl(null);
                }}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </>
  );
}
