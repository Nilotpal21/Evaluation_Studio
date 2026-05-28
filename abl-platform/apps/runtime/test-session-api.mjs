import WebSocket from 'ws';
import http from 'http';
import { buildWebDebugWSProtocols } from '@agent-platform/shared/websocket-auth';

function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  // Login
  const login = await httpFetch('http://localhost:3112/api/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({ email: 'dev@kore.ai' }),
  });
  const token = login.accessToken;
  console.log('Token OK');

  // Create session via WS
  const sessionId = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3112/ws', buildWebDebugWSProtocols(token));
    const timer = setTimeout(() => reject(new Error('Timeout')), 15000);
    const projectId = process.env.WEB_DEBUG_PROJECT_ID || 'flow-test';

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'flow-test/simple_booking',
          projectId,
        }),
      );
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'agent_loaded') {
        ws.send(
          JSON.stringify({
            type: 'send_message',
            sessionId: msg.sessionId,
            text: 'book a hotel in paris',
          }),
        );
      }
      if (msg.type === 'response_end') {
        clearTimeout(timer);
        const sid = msg.sessionId;
        setTimeout(() => {
          ws.close();
          setTimeout(() => resolve(sid), 1000);
        }, 200);
      }
    });
    ws.on('error', reject);
  });

  console.log('Session:', sessionId);
  console.log('');

  // Wait a bit for WS close to propagate
  await new Promise((r) => setTimeout(r, 1000));

  // Check list
  console.log('=== SESSION LIST ===');
  const list = await httpFetch('http://localhost:3112/api/sessions', {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('Total:', list.total);
  for (const s of list.sessions || []) {
    console.log(
      `  ${s.id.slice(0, 16)}... agent=${s.agentName} msgs=${s.messageCount} traces=${s.traceEventCount}`,
    );
  }

  // Check detail
  console.log('');
  console.log('=== SESSION DETAIL ===');
  const detail = await httpFetch(`http://localhost:3112/api/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const sess = detail.session;
  if (!sess) {
    console.log('NOT FOUND:', detail.error);
    return;
  }

  console.log('Messages:', sess.messages?.length);
  console.log('TraceEvents:', sess.traceEvents?.length);
  console.log('CreatedAt:', sess.createdAt);
  console.log('LastActivity:', sess.lastActivityAt);
  console.log('');

  console.log('Messages:');
  for (const m of sess.messages || []) {
    console.log(
      `  ${m.role.padEnd(10)} id=${m.id.padEnd(20)} content=${JSON.stringify(m.content || '').slice(0, 50)}`,
    );
  }

  console.log('');
  console.log('Trace events (first 8):');
  for (const e of (sess.traceEvents || []).slice(0, 8)) {
    console.log(`  ${e.type.padEnd(20)} id=${(e.id || '').slice(0, 12)} ts=${e.timestamp}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
