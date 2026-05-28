export const ALGORITHM = 'aes-256-gcm' as const;
export const IV_LENGTH = 12; // 96 bits — NIST SP 800-38D recommended for AES-GCM
export const AUTH_TAG_LENGTH = 16;
export const KEY_LENGTH = 32;
export const MASTER_KEY_HEX_LENGTH = 64;

// User-scoped encryption keeps its existing derivation settings for backward compatibility.
export const USER_KEY_DERIVATION_ITERATIONS = 100_000;
export const USER_KEY_DERIVATION_DIGEST = 'sha256';

// HKDF
export const HKDF_HASH = 'sha256';

// Compression
export const ZSTD_COMPRESSION_LEVEL = 3;
export const MIN_COMPRESS_BYTES = 64;

// Tenant key cache defaults
export const DEFAULT_CACHE_MAX_SIZE = 1000;
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
