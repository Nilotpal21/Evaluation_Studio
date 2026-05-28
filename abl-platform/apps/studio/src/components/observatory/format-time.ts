/**
 * Consistent absolute timestamp formatting for the Observatory debug panel.
 * Format: "HH:mm:ss" (24h) — compact, sortable, unambiguous.
 */

export function formatAbsoluteTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '--:--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
