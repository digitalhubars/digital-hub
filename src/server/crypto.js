import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM for API keys and OAuth tokens at rest (store_secrets).
// Key: TOKEN_ENCRYPTION_KEY (32 random bytes as 64 hex characters, or base64) when it's set;
// otherwise derived from SUPABASE_SECRET_KEY, which every deployment already has, so
// connecting stores works without extra setup. Changing whichever key is used makes saved
// credentials unreadable: those stores then need their keys entered again.

const PREFIX = 'enc:v1:';

function key() {
  const raw = (process.env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Fix it or remove it from the environment variables.');
    return buf;
  }
  const base = process.env.SUPABASE_SECRET_KEY;
  if (!base) throw new Error('The server is missing SUPABASE_SECRET_KEY. Add it to the environment variables.');
  return createHash('sha256').update(`digital-hub:store-credentials:v1:${base}`).digest();
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
