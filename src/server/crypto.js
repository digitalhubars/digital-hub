import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for API keys and OAuth tokens at rest (store_secrets).
// TOKEN_ENCRYPTION_KEY: 32 random bytes as 64 hex characters (or base64).
// Changing the key makes saved credentials unreadable: stores then need re-authorizing.

const PREFIX = 'enc:v1:';

function key() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || '';
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY is missing or not 32 bytes. Add it to the environment variables.');
  return buf;
}

export const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

export function encrypt(text) {
  if (text == null || text === '') return text ?? null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Decrypts a value written by encrypt(). Plain values (saved before encryption existed) pass through. */
export function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const encryptJson = (value) => encrypt(JSON.stringify(value));
export const decryptJson = (value) => (value ? JSON.parse(decrypt(value)) : null);
