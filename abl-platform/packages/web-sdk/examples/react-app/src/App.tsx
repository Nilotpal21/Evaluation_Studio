import React, { useState } from 'react';
import {
  AgentProvider,
  ChatWidget,
  VoiceWidget,
  useAgent,
  useChat,
  useVoice,
} from '@agent-platform/web-sdk/react';

// =============================================================================
// CUSTOM CHAT COMPONENT (using hooks)
// =============================================================================

function CustomChat() {
  const { isConnected, connectionState } = useAgent();
  const { messages, isTyping, send } = useChat();
  const [input, setInput] = useState('');

  const handleSend = async () => {
    if (!input.trim() || !isConnected) return;
    const text = input;
    setInput('');
    await send(text);
  };

  return (
    <div className="custom-chat">
      <div className="custom-chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`custom-chat-message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {isTyping && (
          <div className="custom-chat-message assistant" style={{ opacity: 0.6 }}>
            Typing...
          </div>
        )}
      </div>
      <div className="custom-chat-input">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder={isConnected ? 'Type a message...' : 'Connecting...'}
          disabled={!isConnected}
        />
        <button className="btn btn-primary" onClick={handleSend} disabled={!input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// VOICE STATUS COMPONENT
// =============================================================================

function VoiceStatus() {
  const { state, transcript, isActive, start, stop, toggleMute, isMuted, isSupported } = useVoice();

  if (!isSupported) {
    return <p style={{ color: '#ef4444' }}>Voice is not supported in this browser</p>;
  }

  return (
    <div style={{ textAlign: 'center', padding: '24px' }}>
      <p style={{ marginBottom: '16px' }}>
        Voice State: <strong>{state}</strong>
      </p>

      {transcript && <p style={{ marginBottom: '16px', fontStyle: 'italic' }}>"{transcript}"</p>}

      <div className="controls" style={{ justifyContent: 'center' }}>
        {!isActive ? (
          <button className="btn btn-primary" onClick={start}>
            Start Voice
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={stop}>
              Stop
            </button>
            <button className="btn btn-secondary" onClick={toggleMute}>
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN APP CONTENT
// =============================================================================

function AppContent() {
  const { connectionState, sessionId, reconnect, disconnect } = useAgent();
  const [activeTab, setActiveTab] = useState<'widget' | 'hooks' | 'voice'>('widget');

  return (
    <div className="app">
      <div className="container">
        <h1>Agent Platform Web SDK</h1>
        <p className="subtitle">React Integration Example</p>

        {/* Connection Status */}
        <div className="status">
          <div className={`status-dot ${connectionState}`} />
          <span>
            {connectionState === 'connected'
              ? `Connected (Session: ${sessionId?.slice(0, 8)}...)`
              : connectionState === 'connecting'
                ? 'Connecting...'
                : connectionState === 'reconnecting'
                  ? 'Reconnecting...'
                  : 'Disconnected'}
          </span>
        </div>

        <div className="controls" style={{ marginBottom: '24px' }}>
          <button className="btn btn-secondary" onClick={reconnect}>
            Reconnect
          </button>
          <button className="btn btn-secondary" onClick={disconnect}>
            Disconnect
          </button>
        </div>

        {/* Tabs */}
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'widget' ? 'active' : ''}`}
            onClick={() => setActiveTab('widget')}
          >
            Widget Component
          </button>
          <button
            className={`tab ${activeTab === 'hooks' ? 'active' : ''}`}
            onClick={() => setActiveTab('hooks')}
          >
            Custom with Hooks
          </button>
          <button
            className={`tab ${activeTab === 'voice' ? 'active' : ''}`}
            onClick={() => setActiveTab('voice')}
          >
            Voice
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'widget' && (
          <>
            <h3 style={{ marginBottom: '12px' }}>Using ChatWidget Component</h3>
            <div className="code-block">
              <code>{`import { AgentProvider, ChatWidget } from '@agent-platform/web-sdk/react';

function App() {
  return (
    <AgentProvider projectId="xxx" apiKey="pk_xxx">
      <ChatWidget position="bottom-right" />
    </AgentProvider>
  );
}`}</code>
            </div>
            <p style={{ color: '#666', fontSize: '14px' }}>
              Look for the chat bubble in the bottom-right corner!
            </p>
          </>
        )}

        {activeTab === 'hooks' && (
          <>
            <h3 style={{ marginBottom: '12px' }}>Custom UI with useChat Hook</h3>
            <div className="code-block">
              <code>{`import { useChat, useAgent } from '@agent-platform/web-sdk/react';

function CustomChat() {
  const { isConnected } = useAgent();
  const { messages, isTyping, send } = useChat();

  return (
    <div>
      {messages.map(msg => <Message key={msg.id} {...msg} />)}
      <input onSubmit={(text) => send(text)} />
    </div>
  );
}`}</code>
            </div>
            <CustomChat />
          </>
        )}

        {activeTab === 'voice' && (
          <>
            <h3 style={{ marginBottom: '12px' }}>Voice with useVoice Hook</h3>
            <div className="code-block">
              <code>{`import { useVoice } from '@agent-platform/web-sdk/react';

function VoiceControl() {
  const { state, transcript, start, stop, toggleMute } = useVoice();

  return (
    <div>
      <p>State: {state}</p>
      <p>Transcript: {transcript}</p>
      <button onClick={start}>Start</button>
      <button onClick={stop}>Stop</button>
    </div>
  );
}`}</code>
            </div>
            <VoiceStatus />
          </>
        )}
      </div>

      {/* Chat Widget - always visible in widget tab */}
      {activeTab === 'widget' && (
        <ChatWidget
          position="bottom-right"
          welcomeMessage="Hello! I'm your AI assistant. How can I help you today?"
          placeholder="Ask me anything..."
        />
      )}
    </div>
  );
}

// =============================================================================
// APP WITH PROVIDER
// =============================================================================

function App() {
  return (
    <AgentProvider
      projectId="demo_project"
      apiKey="pk_demo_key"
      endpoint="http://localhost:3001"
      debug={true}
    >
      <AppContent />
    </AgentProvider>
  );
}

export default App;
