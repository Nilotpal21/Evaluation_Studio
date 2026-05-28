export function checkIsSuperAdmin(userId: string): boolean {
  const raw = process.env.SUPER_ADMIN_USER_IDS || '';
  if (!raw) {
    return false;
  }

  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return ids.includes(userId);
}
