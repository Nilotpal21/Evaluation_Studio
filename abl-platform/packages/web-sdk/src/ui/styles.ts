/**
 * Widget Styles - Professional UI with smooth animations
 */

import type { WidgetTheme, WidgetPosition } from '../core/types.js';

// SVG Icons
export const icons = {
  chat: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  send: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
  mic: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>`,
  micOff: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  phone: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  phoneOff: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  minimize: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};

// Position styles
const positionStyles: Record<WidgetPosition, string> = {
  'bottom-right': 'bottom: 20px; right: 20px;',
  'bottom-left': 'bottom: 20px; left: 20px;',
  'top-right': 'top: 20px; right: 20px;',
  'top-left': 'top: 20px; left: 20px;',
};

// Generate CSS with theme variables
export function getWidgetStyles(theme: WidgetTheme, position: WidgetPosition): string {
  const primaryColor = theme.primaryColor || '#6366f1';
  const textColor = theme.textColor || '#1f2937';
  const bgColor = theme.backgroundColor || '#ffffff';
  const borderRadius = theme.borderRadius ?? 16;
  const fontFamily =
    theme.fontFamily ||
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
  const isDark = theme.darkMode || false;

  return `
    :host {
      --primary: ${primaryColor};
      --primary-hover: ${adjustColor(primaryColor, -10)};
      --text: ${isDark ? '#f9fafb' : textColor};
      --text-secondary: ${isDark ? '#9ca3af' : '#6b7280'};
      --bg: ${isDark ? '#1f2937' : bgColor};
      --bg-secondary: ${isDark ? '#374151' : '#f3f4f6'};
      --border: ${isDark ? '#4b5563' : '#e5e7eb'};
      --shadow: ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.1)'};
      --radius: ${borderRadius}px;
      --font: ${fontFamily};
      
      position: fixed;
      ${positionStyles[position]}
      z-index: 999999;
      font-family: var(--font);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* Launcher button */
    .launcher {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: var(--primary);
      color: white;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px var(--shadow);
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), 
                  box-shadow 0.3s ease,
                  background 0.2s ease;
    }

    .launcher:hover {
      transform: scale(1.08);
      background: var(--primary-hover);
      box-shadow: 0 6px 28px var(--shadow);
    }

    .launcher:active {
      transform: scale(0.95);
    }

    /* Widget container */
    .widget-container {
      width: 380px;
      height: 560px;
      max-height: calc(100vh - 40px);
      background: var(--bg);
      border-radius: var(--radius);
      box-shadow: 0 8px 40px var(--shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    /* Header */
    .header {
      padding: 16px 20px;
      background: var(--primary);
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-title {
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.01em;
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .header-btn {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255,255,255,0.15);
      border: none;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s ease;
    }

    .header-btn:hover {
      background: rgba(255,255,255,0.25);
    }

    /* Messages area */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }

    .message {
      max-width: 85%;
      padding: 12px 16px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.5;
      overflow-wrap: break-word;
      word-break: break-word;
      white-space: pre-wrap;
      animation: messageIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes messageIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message.user {
      align-self: flex-end;
      background: var(--primary);
      color: white;
      border-bottom-right-radius: 4px;
    }

    .message.assistant {
      align-self: flex-start;
      background: var(--bg-secondary);
      color: var(--text);
      border-bottom-left-radius: 4px;
    }

    .message.system {
      align-self: center;
      background: transparent;
      color: var(--text-secondary);
      font-size: 13px;
    }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      gap: 4px;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-radius: 16px;
      width: fit-content;
    }

    .typing-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-secondary);
      animation: typingBounce 1.4s infinite;
    }

    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typingBounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    .status-indicator {
      align-self: flex-start;
      width: fit-content;
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 16px;
      background: var(--bg-secondary);
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.4;
    }

    /* Input area */
    .input-area {
      padding: 16px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 12px;
      align-items: flex-end;
      background: var(--bg);
    }

    .input-field {
      flex: 1;
      display: block;
      width: 100%;
      min-height: 44px;
      max-height: 120px;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 24px;
      font-size: 14px;
      line-height: 1.5;
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      outline: none;
      resize: none;
      overflow-y: hidden;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .input-field:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .input-field::placeholder {
      color: var(--text-secondary);
    }

    .send-btn {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--primary);
      color: white;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, background 0.2s ease, opacity 0.2s ease;
    }

    .send-btn:hover:not(:disabled) {
      background: var(--primary-hover);
      transform: scale(1.05);
    }

    .send-btn:active:not(:disabled) {
      transform: scale(0.95);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Voice panel */
    .voice-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 32px;
    }

    .voice-btn {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .voice-btn.idle {
      background: var(--primary);
      color: white;
    }

    .voice-btn.idle:hover {
      transform: scale(1.08);
      box-shadow: 0 8px 30px var(--shadow);
    }

    .voice-btn.connecting {
      background: var(--bg-secondary);
      color: var(--primary);
      animation: pulse 1.5s infinite;
    }

    .voice-btn.ready,
    .voice-btn.listening {
      background: #22c55e;
      color: white;
      animation: pulse 2s infinite;
    }

    .voice-btn.processing {
      background: #f59e0b;
      color: white;
    }

    .voice-btn.speaking {
      background: var(--primary);
      color: white;
      animation: speakPulse 0.6s infinite alternate;
    }

    .voice-btn.error {
      background: #ef4444;
      color: white;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
      50% { box-shadow: 0 0 0 20px rgba(99, 102, 241, 0); }
    }

    @keyframes speakPulse {
      from { transform: scale(1); }
      to { transform: scale(1.05); }
    }

    .status-text {
      font-size: 15px;
      color: var(--text-secondary);
      text-align: center;
    }

    .transcript {
      padding: 16px 20px;
      background: var(--bg-secondary);
      border-radius: 12px;
      font-size: 14px;
      color: var(--text);
      max-width: 100%;
      text-align: center;
      font-style: italic;
    }

    .controls {
      display: flex;
      gap: 16px;
    }

    .control-btn {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .control-btn:hover {
      background: var(--bg-secondary);
    }

    .control-btn.muted {
      background: #ef4444;
      color: white;
      border-color: #ef4444;
    }

    /* Mode toggle */
    .mode-toggle {
      display: flex;
      padding: 8px;
      gap: 4px;
      background: var(--bg-secondary);
      margin: 12px 16px 0;
      border-radius: 12px;
    }

    .mode-btn {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .mode-btn:hover {
      color: var(--text);
    }

    .mode-btn.active {
      background: var(--bg);
      color: var(--primary);
      box-shadow: 0 2px 8px var(--shadow);
    }

    /* Branding */
    .branding {
      padding: 12px;
      text-align: center;
      font-size: 11px;
      color: var(--text-secondary);
      border-top: 1px solid var(--border);
    }

    .branding a {
      color: var(--primary);
      text-decoration: none;
    }

    .branding a:hover {
      text-decoration: underline;
    }

    /* ================================================================
       RICH CONTENT STYLES
       ================================================================ */

    /* Rich text (markdown/html rendered content) */
    .rich-text {
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .rich-text h1, .rich-text h2, .rich-text h3,
    .rich-text h4, .rich-text h5, .rich-text h6 {
      margin: 8px 0 4px;
      line-height: 1.3;
    }

    .rich-text h1 { font-size: 1.4em; }
    .rich-text h2 { font-size: 1.25em; }
    .rich-text h3 { font-size: 1.1em; }

    .rich-text p { margin: 4px 0; }

    .rich-text a {
      color: var(--primary);
      text-decoration: underline;
    }

    .rich-text code {
      background: rgba(0,0,0,0.06);
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    }

    .rich-text pre {
      background: rgba(0,0,0,0.06);
      padding: 10px 12px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 8px 0;
    }

    .rich-text pre code {
      background: none;
      padding: 0;
    }

    .rich-text ul, .rich-text ol {
      padding-left: 20px;
      margin: 6px 0;
    }

    .rich-text li { margin: 2px 0; }

    .rich-text img {
      max-width: 100%;
      border-radius: 8px;
      margin: 6px 0;
    }

    .rich-text hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 8px 0;
    }

    .rich-text blockquote {
      border-left: 3px solid var(--primary);
      padding-left: 12px;
      margin: 6px 0;
      color: var(--text-secondary);
    }

    .rich-text-table-wrapper {
      overflow-x: auto;
      max-width: 100%;
    }

    .rich-text table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 0.95em;
      min-width: 100%;
    }

    .rich-text th,
    .rich-text td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }

    .rich-text thead {
      background: rgba(0,0,0,0.04);
    }

    .rich-text tbody tr:nth-child(even) {
      background: rgba(0,0,0,0.02);
    }

    /* Actions container */
    .rich-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }

    /* Button group */
    .rich-button-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }

    /* Button */
    .rich-btn {
      padding: 7px 14px;
      border: 1px solid var(--primary);
      border-radius: 18px;
      background: transparent;
      color: var(--primary);
      font-size: 13px;
      font-family: var(--font);
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
      white-space: nowrap;
    }

    .rich-btn:hover:not(:disabled) {
      background: var(--primary);
      color: white;
    }

    .rich-btn:disabled, .rich-btn-clicked {
      opacity: 0.5;
      cursor: default;
    }

    .rich-btn-primary {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
      margin-top: 4px;
    }

    .rich-btn-primary:hover:not(:disabled) {
      background: var(--primary-hover);
    }

    /* Select */
    .rich-select-wrapper {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .rich-select-label {
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .rich-select {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      font-family: var(--font);
      cursor: pointer;
      outline: none;
    }

    .rich-select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
    }

    /* Input */
    .rich-input-wrapper {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .rich-input-label {
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .rich-input {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      font-family: var(--font);
      outline: none;
    }

    .rich-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
    }

    .rich-input::placeholder {
      color: var(--text-secondary);
    }

    /* Carousel */
    .rich-carousel {
      position: relative;
      margin-top: 8px;
    }

    .rich-carousel-track {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
      -ms-overflow-style: none;
      padding: 4px 0;
    }

    .rich-carousel-track::-webkit-scrollbar {
      display: none;
    }

    .rich-carousel-card {
      flex: 0 0 200px;
      scroll-snap-align: start;
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      background: var(--bg);
      transition: box-shadow 0.2s ease;
    }

    .rich-carousel-card:hover {
      box-shadow: 0 2px 12px var(--shadow);
    }

    .rich-carousel-image {
      width: 100%;
      height: 120px;
      object-fit: cover;
      display: block;
    }

    .rich-carousel-body {
      padding: 10px 12px;
    }

    .rich-carousel-title {
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
      margin-bottom: 2px;
    }

    .rich-carousel-subtitle {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .rich-carousel-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1;
      box-shadow: 0 2px 8px var(--shadow);
      transition: background 0.15s ease;
    }

    .rich-carousel-nav:hover {
      background: var(--bg-secondary);
    }

    .rich-carousel-nav-left { left: -6px; }
    .rich-carousel-nav-right { right: -6px; }

    /* Quick replies */
    .rich-quick-replies {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .rich-quick-reply {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border: 1px solid rgba(99, 102, 241, 0.18);
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.08);
      color: var(--primary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }

    .rich-quick-reply:hover {
      background: rgba(99, 102, 241, 0.14);
      border-color: rgba(99, 102, 241, 0.28);
      transform: translateY(-1px);
    }

    .rich-quick-reply-icon {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }

    /* List */
    .rich-list {
      margin-top: 8px;
      display: grid;
      gap: 10px;
    }

    .rich-list-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }

    .rich-list-items {
      display: grid;
      gap: 10px;
    }

    .rich-list-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--bg) 92%, var(--bg-secondary) 8%);
      transition: box-shadow 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }

    .rich-list-item:hover {
      border-color: color-mix(in srgb, var(--border) 65%, var(--primary) 35%);
      box-shadow: 0 8px 20px var(--shadow);
      transform: translateY(-1px);
    }

    .rich-list-image {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      object-fit: cover;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .rich-list-item-text {
      min-width: 0;
    }

    .rich-list-item-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 3px;
    }

    .rich-list-item-subtitle {
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-secondary);
    }

    /* Media */
    .rich-image,
    .rich-video,
    .rich-audio,
    .rich-file {
      margin-top: 8px;
    }

    .rich-image,
    .rich-video {
      display: grid;
      gap: 8px;
    }

    .rich-image-content,
    .rich-video-player {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg-secondary) 88%, black 12%);
      display: block;
    }

    .rich-audio-player {
      width: 100%;
      border-radius: 14px;
    }

    .rich-image-caption,
    .rich-video-caption,
    .rich-audio-caption {
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-secondary);
    }

    .rich-image-blocked,
    .rich-video-blocked,
    .rich-audio-blocked,
    .rich-file-blocked {
      min-height: 88px;
      border: 1px dashed var(--border);
      border-radius: 14px;
      background: repeating-linear-gradient(
        -45deg,
        color-mix(in srgb, var(--bg-secondary) 84%, transparent),
        color-mix(in srgb, var(--bg-secondary) 84%, transparent) 12px,
        transparent 12px,
        transparent 24px
      );
    }

    /* File */
    .rich-file {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--bg) 90%, var(--bg-secondary) 10%);
    }

    .rich-file-info {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .rich-file-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      word-break: break-word;
    }

    .rich-file-size {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .rich-file-download {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      min-width: 92px;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.1);
      color: var(--primary);
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .rich-file-download:hover {
      background: rgba(99, 102, 241, 0.16);
      transform: translateY(-1px);
    }

    /* KPI */
    .rich-kpi {
      margin-top: 8px;
      display: grid;
      gap: 6px;
      padding: 16px;
      border-radius: 16px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--primary) 8%, var(--bg) 92%),
        color-mix(in srgb, var(--bg-secondary) 94%, var(--bg) 6%)
      );
      border: 1px solid color-mix(in srgb, var(--border) 70%, var(--primary) 30%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }

    .rich-kpi-icon {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      object-fit: cover;
    }

    .rich-kpi-label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--text-secondary);
    }

    .rich-kpi-value {
      font-size: 28px;
      line-height: 1.1;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--text);
    }

    .rich-kpi-trend {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      width: fit-content;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }

    .rich-kpi-trend-up {
      background: rgba(34, 197, 94, 0.12);
      color: #15803d;
    }

    .rich-kpi-trend-down {
      background: rgba(239, 68, 68, 0.12);
      color: #dc2626;
    }

    .rich-kpi-trend-flat {
      background: rgba(148, 163, 184, 0.16);
      color: var(--text-secondary);
    }

    /* Table */
    .rich-table {
      margin-top: 8px;
      display: grid;
      gap: 10px;
      overflow: hidden;
    }

    .rich-table-element {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      background: var(--bg);
      font-size: 12px;
    }

    .rich-table-th,
    .rich-table-td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }

    .rich-table-th {
      background: color-mix(in srgb, var(--bg-secondary) 85%, var(--primary) 15%);
      color: var(--text);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .rich-table-row:nth-child(even) .rich-table-td {
      background: color-mix(in srgb, var(--bg-secondary) 70%, transparent);
    }

    .rich-table-row:last-child .rich-table-td,
    .rich-table-element thead tr:last-child .rich-table-th {
      border-bottom: none;
    }

    .rich-table-toggle {
      justify-self: start;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--primary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .rich-table-toggle:hover {
      text-decoration: underline;
    }

    /* Chart */
    .rich-chart {
      margin-top: 8px;
      display: grid;
      gap: 10px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: color-mix(in srgb, var(--bg) 90%, var(--bg-secondary) 10%);
    }

    .rich-chart-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }

    .rich-chart-svg {
      width: 100%;
      height: auto;
      color: var(--text-secondary);
      overflow: visible;
    }

    .rich-chart-loading,
    .rich-chart-error {
      padding: 18px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
      color: var(--text-secondary);
      font-size: 12px;
    }

    .rich-chart-error {
      color: #dc2626;
    }

    /* Form */
    .rich-form {
      margin-top: 8px;
      display: grid;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: color-mix(in srgb, var(--bg) 92%, var(--bg-secondary) 8%);
    }

    .rich-form-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }

    .rich-form-field {
      display: grid;
      gap: 6px;
    }

    .rich-form-submit {
      justify-self: start;
    }

    /* Progress */
    .rich-progress {
      margin-top: 8px;
    }

    .rich-progress-bar {
      display: grid;
      gap: 8px;
    }

    .rich-progress-label,
    .rich-progress-value {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .rich-progress-track {
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--bg-secondary) 82%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
    }

    .rich-progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--primary), color-mix(in srgb, var(--primary) 70%, white 30%));
    }

    .rich-progress-circle {
      display: inline-grid;
      gap: 8px;
      justify-items: center;
    }

    .rich-progress-svg {
      width: 92px;
      height: 92px;
    }

    .rich-progress-circle-bg {
      stroke: color-mix(in srgb, var(--border) 76%, transparent);
    }

    .rich-progress-circle-fill {
      stroke: var(--primary);
    }

    .rich-progress-circle-text {
      fill: var(--text);
      font-weight: 700;
    }

    /* Feedback */
    .rich-feedback {
      margin-top: 8px;
      display: grid;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: color-mix(in srgb, var(--bg) 92%, var(--bg-secondary) 8%);
    }

    .rich-feedback-prompt {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }

    .rich-feedback-options {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .rich-feedback-option {
      min-width: 38px;
      min-height: 38px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }

    .rich-feedback-option:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--border) 60%, var(--primary) 40%);
      transform: translateY(-1px);
    }

    .rich-feedback-option:disabled {
      cursor: default;
      opacity: 0.65;
    }

    .rich-feedback-star {
      font-size: 18px;
      color: #f59e0b;
    }

    .rich-feedback-scale {
      min-width: 42px;
      font-size: 12px;
      font-weight: 600;
    }

    .rich-feedback-selected {
      border-color: color-mix(in srgb, var(--primary) 60%, transparent);
      background: color-mix(in srgb, var(--primary) 14%, var(--bg) 86%);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }

    /* Per-message feedback controls */
    .message-feedback {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
    }

    .message-feedback-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .message-feedback-btn {
      font: inherit;
      font-size: 14px;
      line-height: 1;
      padding: 4px 8px;
      border-radius: 8px;
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }

    .message-feedback-btn:hover:not(:disabled) {
      opacity: 1;
      border-color: color-mix(in srgb, var(--border) 60%, var(--primary) 40%);
      background: color-mix(in srgb, var(--primary) 8%, transparent);
    }

    .message-feedback-btn:disabled {
      cursor: default;
    }

    .message-feedback-up {
      opacity: 1;
      border-color: rgba(34, 197, 94, 0.6);
      background: rgba(34, 197, 94, 0.1);
    }

    .message-feedback-down {
      opacity: 1;
      border-color: rgba(239, 68, 68, 0.6);
      background: rgba(239, 68, 68, 0.1);
    }

    .message-feedback-sent {
      opacity: 1;
    }

    .message-feedback-status {
      font-size: 11.5px;
      color: var(--text-secondary);
      margin-left: 4px;
    }

    .message-feedback-error {
      color: #ef4444;
    }

    .message-feedback-comment {
      margin-top: 8px;
      background: color-mix(in srgb, var(--bg-secondary) 85%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
    }

    .message-feedback-comment-input {
      width: 100%;
      resize: vertical;
      min-height: 44px;
      max-height: 160px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      font: inherit;
      font-size: 13px;
      outline: none;
    }

    .message-feedback-comment-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 18%, transparent);
    }

    .message-feedback-comment-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }

    .message-feedback-counter {
      flex: 1;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .message-feedback-ghost-btn,
    .message-feedback-primary-btn {
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }

    .message-feedback-ghost-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-secondary);
    }

    .message-feedback-primary-btn {
      border: 1px solid var(--primary);
      background: var(--primary);
      color: white;
      font-weight: 600;
    }

    /* Rich message wrapper — override default message constraints */
    .message.rich {
      max-width: 95%;
    }

    /* ================================================================
       LIVE SESSION STYLES
       ================================================================ */

    /* Live badge in header */
    .live-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 10px;
      background: #ef4444;
      color: white;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      animation: livePulse 2s infinite;
    }

    @keyframes livePulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    /* Join prompt */
    .join-prompt {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      margin: 8px 16px;
      background: var(--bg-secondary);
      border-radius: 12px;
      border: 1px solid var(--border);
    }

    .join-prompt-text {
      font-size: 13px;
      color: var(--text);
      text-align: center;
    }

    .join-btn {
      padding: 8px 20px;
      border: none;
      border-radius: 20px;
      background: var(--primary);
      color: white;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s ease, transform 0.2s ease;
    }

    .join-btn:hover {
      background: var(--primary-hover);
      transform: scale(1.02);
    }

    .dismiss-join-btn {
      padding: 4px 12px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      transition: color 0.2s ease;
    }

    .dismiss-join-btn:hover {
      color: var(--text);
    }

    /* Live session layout: voice controls + transcript + input */
    .live-session-layout {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .voice-controls-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }

    .voice-btn-compact {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      flex-shrink: 0;
    }

    .voice-btn-compact svg {
      width: 18px;
      height: 18px;
    }

    .voice-btn-compact.idle {
      background: var(--primary);
      color: white;
    }

    .voice-btn-compact.connecting {
      background: var(--bg-secondary);
      color: var(--primary);
      border: 2px solid var(--primary);
    }

    .voice-btn-compact.ready,
    .voice-btn-compact.listening {
      background: #22c55e;
      color: white;
    }

    .voice-btn-compact.processing {
      background: #f59e0b;
      color: white;
    }

    .voice-btn-compact.speaking {
      background: var(--primary);
      color: white;
    }

    .voice-btn-compact.error {
      background: #ef4444;
      color: white;
    }

    .voice-status-compact {
      flex: 1;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .mute-btn-compact {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s ease;
    }

    .mute-btn-compact svg {
      width: 16px;
      height: 16px;
    }

    .mute-btn-compact:hover {
      background: var(--bg-secondary);
    }

    .mute-btn-compact.muted {
      background: #ef4444;
      color: white;
      border-color: #ef4444;
    }

    .live-transcript-preview {
      padding: 6px 16px;
      font-size: 12px;
      color: var(--text-secondary);
      font-style: italic;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }

    /* Source channel badges */
    .channel-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 500;
      margin-right: 6px;
      vertical-align: middle;
    }

    .channel-badge svg {
      width: 10px;
      height: 10px;
    }

    .channel-badge-voice {
      background: rgba(34, 197, 94, 0.15);
      color: #16a34a;
    }

    .channel-badge-text {
      background: rgba(99, 102, 241, 0.15);
      color: var(--primary);
    }

    .channel-badge-system {
      background: rgba(107, 114, 128, 0.15);
      color: var(--text-secondary);
    }

    /* Responsive */
    @media (max-width: 420px) {
      .widget-container {
        width: calc(100vw - 24px);
        height: calc(100vh - 100px);
        border-radius: 16px;
      }

      .rich-carousel-card {
        flex: 0 0 170px;
      }
    }
  `;
}

// Aliases for specific widgets
export const getUnifiedWidgetStyles = getWidgetStyles;
export const getChatWidgetStyles = getWidgetStyles;
export const getVoiceWidgetStyles = getWidgetStyles;

// Color adjustment helper
function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount));
  return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}
