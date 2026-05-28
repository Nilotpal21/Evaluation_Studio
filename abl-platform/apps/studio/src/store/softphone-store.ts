/**
 * Softphone Store
 *
 * Manages WebRTC softphone state with Zustand.
 * No persistence — WebRTC connections are ephemeral.
 */

import { create } from 'zustand';
import type { RegistrationStatus, CallState } from '../lib/softphone-manager';
import type { SoftphoneNumber } from '../api/softphone';

// =============================================================================
// TYPES
// =============================================================================

type PanelView = 'number-select' | 'dialer' | 'in-call';

interface SoftphoneState {
  // Connection
  registrationStatus: RegistrationStatus;
  sipDomain: string | null;
  wsServers: string[] | null;

  // Readiness (from Jambonz account config)
  ready: boolean;
  warnings: string[];
  projectWarning: string | null;
  projectWarningDetails: string[];

  // Phone numbers
  phoneNumbers: SoftphoneNumber[];
  selectedNumber: string | null;

  // Call
  callState: CallState;
  callStartTime: number | null;
  isMuted: boolean;
  isOnHold: boolean;
  lastCallCause: string | null;

  // UI
  isOpen: boolean;
  view: PanelView;
  showKeypad: boolean;

  // Recording
  recordingEnabled: boolean;
  recordingUrl: string | null;

  // Error
  lastError: string | null;

  // Actions
  setConfig: (sipDomain: string, wsServers: string[], ready: boolean, warnings: string[]) => void;
  setProjectWarning: (warning: string | null, details?: string[]) => void;
  setPhoneNumbers: (numbers: SoftphoneNumber[]) => void;
  setSelectedNumber: (number: string | null) => void;
  setRegistrationStatus: (status: RegistrationStatus) => void;
  setCallState: (state: CallState) => void;
  setCallStartTime: (time: number | null) => void;
  setMuted: (muted: boolean) => void;
  setOnHold: (onHold: boolean) => void;
  setLastCallCause: (cause: string | null) => void;
  setOpen: (open: boolean) => void;
  setView: (view: PanelView) => void;
  setShowKeypad: (show: boolean) => void;
  setRecordingEnabled: (enabled: boolean) => void;
  setRecordingUrl: (url: string | null) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

// =============================================================================
// STORE
// =============================================================================

const initialState = {
  registrationStatus: 'idle' as RegistrationStatus,
  sipDomain: null as string | null,
  wsServers: null as string[] | null,
  ready: false,
  warnings: [] as string[],
  projectWarning: null as string | null,
  projectWarningDetails: [] as string[],
  phoneNumbers: [] as SoftphoneNumber[],
  selectedNumber: null as string | null,
  callState: 'idle' as CallState,
  callStartTime: null as number | null,
  isMuted: false,
  isOnHold: false,
  lastCallCause: null as string | null,
  isOpen: false,
  view: 'dialer' as PanelView,
  showKeypad: false,
  recordingEnabled: false,
  recordingUrl: null as string | null,
  lastError: null as string | null,
};

export const useSoftphoneStore = create<SoftphoneState>((set) => ({
  ...initialState,

  setConfig: (sipDomain, wsServers, ready, warnings) =>
    set({ sipDomain, wsServers, ready, warnings }),
  setProjectWarning: (projectWarning, projectWarningDetails = []) =>
    set({ projectWarning, projectWarningDetails }),
  setPhoneNumbers: (phoneNumbers) =>
    set((state) => ({
      phoneNumbers,
      // Auto-select first number if none selected
      selectedNumber:
        state.selectedNumber ?? (phoneNumbers.length > 0 ? phoneNumbers[0].number : null),
    })),
  setSelectedNumber: (selectedNumber) => set({ selectedNumber }),
  setRegistrationStatus: (registrationStatus) => set({ registrationStatus }),
  setCallState: (callState) =>
    set((state) => ({
      callState,
      // Auto-switch view based on call state
      view: callState === 'idle' ? 'dialer' : 'in-call',
      // Reset mute/hold on call end
      isMuted: callState === 'idle' ? false : state.isMuted,
      isOnHold: callState === 'idle' ? false : state.isOnHold,
      showKeypad: callState === 'idle' ? false : state.showKeypad,
      // Set call start time when connected
      callStartTime:
        callState === 'connected' && !state.callStartTime
          ? Date.now()
          : callState === 'idle'
            ? null
            : state.callStartTime,
    })),
  setCallStartTime: (callStartTime) => set({ callStartTime }),
  setMuted: (isMuted) => set({ isMuted }),
  setOnHold: (isOnHold) => set({ isOnHold }),
  setLastCallCause: (lastCallCause) => set({ lastCallCause }),
  setOpen: (isOpen) => set({ isOpen }),
  setView: (view) => set({ view }),
  setShowKeypad: (showKeypad) => set({ showKeypad }),
  setRecordingEnabled: (recordingEnabled) => set({ recordingEnabled }),
  setRecordingUrl: (recordingUrl) => set({ recordingUrl }),
  setError: (lastError) => set({ lastError }),
  reset: () => set(initialState),
}));
