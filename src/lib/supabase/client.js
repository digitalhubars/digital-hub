import { createClient } from '@supabase/supabase-js';

// Browser client for Supabase. The publishable key is public by design;
// Row Level Security policies decide what each user can read and write.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(url && key);

let client;

export function supabase() {
  if (!client) {
    client = createClient(url, key, {
      // Implicit flow: email links (confirm, reset password) work in any browser.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
  }
  return client;
}

/** Throws the Supabase error (if any) and returns the data. */
export function must({ data, error }) {
  if (error) throw error;
  return data;
}

/**
 * Calls one of the app's API routes (src/app/api/...) as the signed-in user.
 * Returns the JSON answer; a failed request throws with the server's message.
 */
export async function callApi(path, body = {}) {
  const { data } = await supabase().auth.getSession();
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(json?.message || `The server answered ${res.status}.`);
  return json;
}
