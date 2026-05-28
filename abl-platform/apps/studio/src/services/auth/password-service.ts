/**
 * Password Service
 *
 * Password hashing, verification, and strength validation.
 * Uses bcryptjs (same as MFA recovery codes).
 * All constants read from centralized config (auth.password.*).
 */

import { getConfig, isConfigLoaded } from '@/config';

function getPasswordConfig() {
  if (!isConfigLoaded()) {
    // Fallback for early bootstrap / test environments
    return {
      bcryptCost: 12,
      minLength: 8,
      requireUppercase: true,
      requireLowercase: true,
      requireDigit: true,
      requireSpecialChar: false,
      commonPasswords: [
        'password',
        'password1',
        'Password1',
        '12345678',
        '123456789',
        'qwerty123',
        'abc12345',
        'iloveyou',
        'admin123',
        'welcome1',
        'monkey123',
        'dragon12',
        'master12',
        'letmein1',
        'football',
        'baseball',
        'trustno1',
        'sunshine',
        'princess',
        'whatever',
      ],
      historyCount: 5,
    };
  }
  return getConfig().auth.password;
}

export async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(password, getPasswordConfig().bcryptCost);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(password, hash);
}

interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePasswordStrength(password: string): PasswordValidation {
  const config = getPasswordConfig();
  const errors: string[] = [];

  if (password.length < config.minLength) {
    errors.push(`Password must be at least ${config.minLength} characters long`);
  }
  if (config.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (config.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (config.requireDigit && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (config.requireSpecialChar && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  if (config.commonPasswords.some((cp) => cp.toLowerCase() === password.toLowerCase())) {
    errors.push('Password is too common, please choose a stronger password');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if a password matches any entry in the password history.
 * Used to prevent password reuse on reset.
 */
export async function isPasswordInHistory(
  password: string,
  history: Array<{ hash: string }>,
): Promise<boolean> {
  if (!history?.length) return false;
  const bcrypt = await import('bcryptjs');
  for (const entry of history) {
    if (!entry?.hash) continue;
    if (await bcrypt.compare(password, entry.hash)) return true;
  }
  return false;
}
