/**
 * Proxy Addon — Configures proxy routing for outgoing requests.
 */

export function applyProxy(
  request: { proxyUrl?: string; proxyHeaders?: Record<string, string> },
  proxy: { url: string },
  proxyCredentials?: { authType: string; secrets: Record<string, unknown> },
): void {
  request.proxyUrl = proxy.url;
  if (proxyCredentials) {
    // Apply proxy auth (basic/bearer/api_key only)
    request.proxyHeaders = request.proxyHeaders ?? {};
    if (proxyCredentials.authType === 'basic') {
      const { username, password } = proxyCredentials.secrets as {
        username: string;
        password: string;
      };
      request.proxyHeaders['Proxy-Authorization'] =
        `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    } else if (proxyCredentials.authType === 'bearer') {
      const { token } = proxyCredentials.secrets as { token: string };
      request.proxyHeaders['Proxy-Authorization'] = `Bearer ${token}`;
    }
  }
}
