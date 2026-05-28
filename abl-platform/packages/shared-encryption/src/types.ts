export type EncryptionScope = 'user' | 'tenant' | 'contact';

export interface PreviousKeyConfig {
  version: number;
  masterKeyHex: string;
}

export interface EncryptionServiceConfig {
  masterKeyHex: string;
  cache?: {
    maxSize?: number;
    ttlMs?: number;
  };
  previous?: PreviousKeyConfig[];
}
