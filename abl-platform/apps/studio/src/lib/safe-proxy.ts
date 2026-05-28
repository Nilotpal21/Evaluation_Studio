/**
 * Safe Proxy Helpers
 *
 * Utilities for safely proxying responses from upstream services (runtime, etc.).
 * Prevents JSON parse errors when upstream returns non-JSON (HTML error pages,
 * empty bodies, etc.).
 */

/**
 * Safely parse a fetch Response as JSON.
 * If the body is not valid JSON (HTML error page, empty body, etc.),
 * returns a structured error object instead of throwing.
 */
export async function safeJsonParse(
  response: Response,
): Promise<{ data: unknown; ok: boolean; status: number }> {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return { data, ok: response.ok, status: response.status };
  } catch {
    return {
      data: {
        success: false,
        error: `Upstream returned non-JSON response (status ${response.status})`,
      },
      ok: false,
      status: response.ok ? 502 : response.status,
    };
  }
}
