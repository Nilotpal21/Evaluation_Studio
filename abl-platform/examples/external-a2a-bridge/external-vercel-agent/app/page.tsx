const envStatus = [
  {
    label: 'PUBLIC_BASE_URL',
    value: process.env.PUBLIC_BASE_URL ?? 'unset',
  },
  {
    label: 'PLATFORM_A2A_URL',
    value: process.env.PLATFORM_A2A_URL ?? 'unset',
  },
  {
    label: 'GOOGLE_MODEL',
    value: process.env.GOOGLE_MODEL ?? 'gemini-2.5-flash',
  },
];

export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 860,
        margin: '0 auto',
        padding: '72px 24px 96px',
      }}
    >
      <div
        style={{
          padding: 28,
          borderRadius: 24,
          background: 'rgba(15, 23, 42, 0.72)',
          border: '1px solid rgba(148, 163, 184, 0.22)',
          boxShadow: '0 30px 80px rgba(15, 23, 42, 0.45)',
        }}
      >
        <p
          style={{
            margin: 0,
            color: '#fbbf24',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          External A2A Bridge
        </p>
        <h1
          style={{
            margin: '14px 0 12px',
            fontSize: 'clamp(2.4rem, 6vw, 4.6rem)',
            lineHeight: 1,
          }}
        >
          Hosted Vercel Agent
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: 640,
            color: '#cbd5e1',
            fontSize: 18,
            lineHeight: 1.6,
          }}
        >
          This app exposes a small A2A server at <code>/api/a2a</code> and an agent card at{' '}
          <code>/.well-known/agent-card.json</code>. It expects the platform to forward long-running
          conversation context through <code>contextId</code> and message history.
        </p>
        <p
          style={{
            margin: '14px 0 0',
            maxWidth: 640,
            color: '#94a3b8',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          If <code>PUBLIC_BASE_URL</code> is unset, the agent card now falls back to the incoming
          request host instead of the framework-derived origin. That keeps localhost cards stable
          during local bridge testing.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
            marginTop: 28,
          }}
        >
          {envStatus.map((item) => (
            <div
              key={item.label}
              style={{
                padding: 16,
                borderRadius: 18,
                background: 'rgba(30, 41, 59, 0.78)',
                border: '1px solid rgba(148, 163, 184, 0.16)',
              }}
            >
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{item.label}</div>
              <div style={{ fontSize: 14, lineHeight: 1.5, wordBreak: 'break-word' }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
