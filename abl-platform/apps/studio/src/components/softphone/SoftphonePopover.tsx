/**
 * SoftphonePopover — The main softphone UI panel.
 *
 * Three views:
 * 1. Number Select — pick a phone number from voice connections
 * 2. Dialer — shows selected number + dial pad + call button
 * 3. In-Call — call status, duration, call controls, optional DTMF pad
 */

import { useState, useEffect, useCallback } from 'react';
import { Phone, ChevronDown, X, Download, AlertTriangle, PanelRightOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DialPad } from './DialPad';
import { CallControls } from './CallControls';
import type { SoftphoneNumber } from '../../api/softphone';
import type { RegistrationStatus, CallState } from '../../lib/softphone-manager';

interface SoftphonePopoverProps {
  registrationStatus: RegistrationStatus;
  callState: CallState;
  phoneNumbers: SoftphoneNumber[];
  selectedNumber: string | null;
  callStartTime: number | null;
  isMuted: boolean;
  isOnHold: boolean;
  showKeypad: boolean;
  view: 'number-select' | 'dialer' | 'in-call';
  lastError: string | null;
  projectWarning: string | null;
  projectWarningDetails: string[];
  onSelectNumber: (number: string) => void;
  onCall: (number: string) => void;
  onHangup: () => void;
  onSendDTMF: (key: string) => void;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleKeypad: (show: boolean) => void;
  onSetView: (view: 'number-select' | 'dialer' | 'in-call') => void;
  onDismissError: () => void;
  recordingEnabled: boolean;
  recordingUrl: string | null;
  onToggleRecording: (enabled: boolean) => void;
  onClearRecording: () => void;
}

function CallDuration({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return (
    <span className="text-sm text-muted tabular-nums">
      {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
    </span>
  );
}

function RegistrationBadge({ status }: { status: RegistrationStatus }) {
  const t = useTranslations('softphone');
  const colors: Record<RegistrationStatus, string> = {
    idle: 'bg-muted/20 text-muted',
    connecting: 'bg-warning/15 text-warning',
    registered: 'bg-success/15 text-success',
    failed: 'bg-error/15 text-error',
    disconnected: 'bg-error/15 text-error',
  };
  const labels: Record<RegistrationStatus, string> = {
    idle: '',
    connecting: t('connecting'),
    registered: t('registered'),
    failed: t('registration_failed'),
    disconnected: t('disconnected'),
  };

  if (status === 'idle') return null;

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colors[status]}`}>{labels[status]}</span>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-error/10 text-error text-xs">
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 hover:text-error/70 transition-default"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function WarningBanner({
  message,
  expanded,
  detailsLabel,
  hideLabel,
  onToggle,
}: {
  message: string;
  expanded: boolean;
  detailsLabel: string;
  hideLabel: string;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate leading-5">{message}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-warning
            hover:bg-warning/10 hover:text-warning transition-default"
          aria-expanded={expanded}
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
          <span>{expanded ? hideLabel : detailsLabel}</span>
        </button>
      </div>
    </div>
  );
}

function WarningDetailsPanel({
  message,
  details,
  title,
  emptyMessage,
  closeLabel,
  onClose,
}: {
  message: string;
  details: string[];
  title: string;
  emptyMessage: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div
      className="w-96 max-w-[calc(100vw-22rem)] border border-default border-l-0
        bg-background-elevated shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-default px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted hover:bg-background-muted hover:text-foreground transition-default"
          aria-label={closeLabel}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[28rem] overflow-y-auto px-4 py-3">
        <p className="mb-3 text-sm leading-6 text-warning">{message}</p>
        {details.length > 0 ? (
          <ul className="space-y-2 text-xs leading-5 text-muted">
            {details.map((detail, index) => (
              <li
                key={`${index}-${detail}`}
                className="rounded-lg border border-warning/15 bg-warning/5 px-3 py-2 text-warning/90"
              >
                {detail}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">{emptyMessage}</p>
        )}
      </div>
    </div>
  );
}

export function SoftphonePopover({
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
  projectWarning,
  projectWarningDetails,
  onSelectNumber,
  onCall,
  onHangup,
  onSendDTMF,
  onToggleMute,
  onToggleHold,
  onToggleKeypad,
  onSetView,
  onDismissError,
  recordingEnabled,
  recordingUrl,
  onToggleRecording,
  onClearRecording,
}: SoftphonePopoverProps) {
  const t = useTranslations('softphone');
  const [dialInput, setDialInput] = useState('');
  const [showProjectDiagnostics, setShowProjectDiagnostics] = useState(false);

  // When a number is selected, populate the dial input
  useEffect(() => {
    if (selectedNumber) {
      setDialInput(selectedNumber);
    }
  }, [selectedNumber]);

  const handleCall = useCallback(() => {
    const number = dialInput.trim();
    if (number) {
      onCall(number);
    }
  }, [dialInput, onCall]);

  const handleDialPadPress = useCallback(
    (key: string) => {
      if (callState !== 'idle') {
        // During a call, send DTMF
        onSendDTMF(key);
      } else {
        // In dialer mode, append to input
        setDialInput((prev) => prev + key);
      }
    },
    [callState, onSendDTMF],
  );

  const isCallActive = callState !== 'idle';

  return (
    <div className="flex items-start">
      <div className="w-80 bg-background-elevated border border-default rounded-xl shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-default">
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-foreground" />
            <span className="text-sm font-medium text-foreground">{t('title')}</span>
          </div>
          <RegistrationBadge status={registrationStatus} />
        </div>

        {/* Error banner with auto-dismiss */}
        {lastError && <ErrorBanner message={lastError} onDismiss={onDismissError} />}
        {!lastError && projectWarning && (
          <WarningBanner
            message={projectWarning}
            expanded={showProjectDiagnostics}
            detailsLabel={t('project_diagnostics_details')}
            hideLabel={t('project_diagnostics_hide')}
            onToggle={() => setShowProjectDiagnostics((value) => !value)}
          />
        )}

        {/* Body */}
        <div className="p-4">
          {/* Number selector (always visible in dialer mode) */}
          {!isCallActive && phoneNumbers.length > 1 && (
            <div className="mb-3">
              <button
                type="button"
                onClick={() => onSetView(view === 'number-select' ? 'dialer' : 'number-select')}
                className="flex items-center justify-between w-full px-3 py-2 rounded-lg
                bg-background-subtle hover:bg-background-muted text-sm text-foreground transition-default"
              >
                <span className="truncate">{selectedNumber || t('select_number')}</span>
                <ChevronDown
                  className={`w-4 h-4 text-muted transition-transform ${
                    view === 'number-select' ? 'rotate-180' : ''
                  }`}
                />
              </button>
            </div>
          )}

          {/* Number selection list */}
          {view === 'number-select' && !isCallActive && (
            <div className="mb-3 max-h-40 overflow-y-auto space-y-1">
              {phoneNumbers.map((num) => (
                <button
                  key={num.connectionId}
                  type="button"
                  onClick={() => {
                    onSelectNumber(num.number);
                    setDialInput(num.number);
                    onSetView('dialer');
                  }}
                  className={`flex flex-col w-full px-3 py-2 rounded-lg text-left transition-default ${
                    selectedNumber === num.number
                      ? 'bg-accent/10 text-accent'
                      : 'hover:bg-background-muted text-foreground'
                  }`}
                >
                  <span className="text-sm font-medium">{num.number}</span>
                  <span className="text-xs text-muted">{num.channelName}</span>
                </button>
              ))}
            </div>
          )}

          {/* Dialer view */}
          {(view === 'dialer' || (view === 'number-select' && isCallActive)) && !isCallActive && (
            <>
              {/* Dial input */}
              <div className="mb-3">
                <input
                  type="text"
                  value={dialInput}
                  onChange={(e) => setDialInput(e.target.value)}
                  placeholder={t('select_number')}
                  className="w-full px-3 py-2 text-center text-lg font-medium
                  bg-background-subtle border border-default rounded-lg
                  text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              {/* Dial pad */}
              <div className="mb-3">
                <DialPad onPress={handleDialPadPress} />
              </div>

              {/* Record call checkbox */}
              <label className="flex items-center gap-2 mb-3 px-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={recordingEnabled}
                  onChange={(e) => onToggleRecording(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-default accent-accent"
                />
                <span className="text-xs text-muted">{t('record_call')}</span>
              </label>

              {/* Download recording from previous call */}
              {recordingUrl && (
                <div className="flex items-center justify-between mb-3 px-3 py-2 rounded-lg bg-accent/10">
                  <span className="text-xs text-accent">{t('recording_ready')}</span>
                  <div className="flex items-center gap-2">
                    <a
                      href={recordingUrl}
                      download={`call-${new Date().toISOString().slice(0, 19)}.webm`}
                      className="text-accent hover:text-accent/80 transition-default"
                      title={t('download_recording')}
                    >
                      <Download className="w-4 h-4" />
                    </a>
                    <button
                      type="button"
                      onClick={onClearRecording}
                      className="text-muted hover:text-foreground transition-default"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}

              {/* Call button */}
              <button
                type="button"
                onClick={handleCall}
                disabled={!dialInput.trim() || registrationStatus !== 'registered'}
                className="w-full py-3 rounded-lg bg-success text-success-foreground font-medium
                hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-default
                flex items-center justify-center gap-2"
              >
                <Phone className="w-4 h-4" />
                {t('call')}
              </button>
            </>
          )}

          {/* In-call view */}
          {isCallActive && (
            <>
              {/* Call info */}
              <div className="text-center mb-4">
                <p className="text-lg font-medium text-foreground">{selectedNumber || dialInput}</p>
                <p className="text-sm text-muted mt-1">
                  {callState === 'dialing' && t('dialing')}
                  {callState === 'ringing' && t('ringing')}
                  {callState === 'connected' && callStartTime && (
                    <CallDuration startTime={callStartTime} />
                  )}
                  {callState === 'on-hold' && t('hold')}
                </p>
              </div>

              {/* Call controls */}
              <div className="mb-4">
                <CallControls
                  isMuted={isMuted}
                  isOnHold={isOnHold}
                  showKeypad={showKeypad}
                  onToggleMute={onToggleMute}
                  onToggleHold={onToggleHold}
                  onToggleKeypad={() => onToggleKeypad(!showKeypad)}
                  onHangup={onHangup}
                />
              </div>

              {/* DTMF pad (collapsible during call) */}
              {showKeypad && (
                <div className="pt-3 border-t border-default">
                  <DialPad onPress={handleDialPadPress} />
                </div>
              )}
            </>
          )}

          {/* No numbers message */}
          {phoneNumbers.length === 0 && (
            <p className="text-sm text-muted text-center py-4">{t('no_numbers')}</p>
          )}
        </div>
      </div>
      {!lastError && projectWarning && showProjectDiagnostics && (
        <WarningDetailsPanel
          message={projectWarning}
          details={projectWarningDetails}
          title={t('project_diagnostics')}
          emptyMessage={t('project_diagnostics_empty')}
          closeLabel={t('project_diagnostics_close')}
          onClose={() => setShowProjectDiagnostics(false)}
        />
      )}
    </div>
  );
}
