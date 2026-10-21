import 'server-only';
import { createClient } from '@supabase/supabase-js';

// Server-side Supabase access for the API routes.
// SUPABASE_SECRET_KEY bypasses Row Level Security: never import this file from browser code.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let admin;

export function adminDb() {
  if (!url || !secretKey) throw new HttpError(500, 'The server is missing SUPABASE_SECRET_KEY. Add it to the environment variables.');
  if (!admin) admin = createClient(url, secretKey, noSession);
  return admin;
}

/** A client that acts as the caller, so Row Level Security applies to what it reads. */
export const userDb = (token) => createClient(url, publishableKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } });

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function must({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ---- Who is calling --------------------------------------------------------------

export async function caller(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sign in first.');
  const { data, error } = await adminDb().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session expired. Sign in again.');
  const profile = must(await adminDb().from('profiles').select('*').eq('id', data.user.id).maybeSingle());
  if (!profile || profile.status !== 'active') throw new HttpError(403, 'Your account isn’t active.');
  return { uid: data.user.id, profile, token };
}

export async function requireAdmin(request) {
  const who = await caller(request);
  if (who.profile.role !== 'admin') throw new HttpError(403, 'Only an admin can do this.');
  return who;
}

// Admins can sync any store; managers only the stores in their group.
export async function requireStoreAccess(request, storeId) {
  const who = await caller(request);
  if (who.profile.role === 'admin') return who;
  const store = must(await adminDb().from('stores').select('group_id').eq('id', storeId).maybeSingle());
  if (who.profile.role === 'manager' && store && store.group_id && store.group_id === who.profile.group_id) return who;
  throw new HttpError(403, 'You can’t sync this store.');
}

/** Wraps a route handler: JSON in, JSON out, errors as { message }. */
export function route(handler) {
  return async (request) => {
    try {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const result = await handler(request, body);
      return Response.json(result ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[api]', err);
      return Response.json({ message: err.message || 'Something went wrong.' }, { status });
    }
  };
}
