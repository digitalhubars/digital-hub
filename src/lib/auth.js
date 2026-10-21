import { supabase } from './supabase/client';

// Sign-in with Supabase Auth (email + password).
// Profiles live in public.profiles. A database trigger creates one for every new account:
// the owner (confirmed email, see src/config/owner.js) as admin, everyone else as a
// client with no stores. Row Level Security decides who may change what.

const FRIENDLY = {
  invalid_credentials: 'Email or password is wrong.',
  email_not_confirmed: 'Confirm your email first. Open the link we sent you, then sign in.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
  email_exists: 'An account with this email already exists. Sign in instead.',
  weak_password: 'Pick a stronger password.',
  email_address_invalid: 'Enter a valid email.',
  validation_failed: 'Enter a valid email.',
  user_banned: 'This account is suspended. Ask your admin.',
  over_request_rate_limit: 'Too many tries. Wait a minute and try again.',
  over_email_send_rate_limit: 'Too many emails sent. Wait a few minutes and try again.',
  same_password: 'Use a password you haven’t used here before.',
  42501: 'You don’t have access to this. Ask your admin.',
};

export const authMessage = (err) => {
  if (!err) return 'Something went wrong.';
  if (FRIENDLY[err.code]) return FRIENDLY[err.code];
  if (err.name === 'AuthRetryableFetchError' || /fetch/i.test(err.message || '')) return 'Can’t reach the server. Check your connection.';
  return err.message || 'Something went wrong.';
};

// The parts of a Supabase user the app uses.
const toUser = (u) =>
  u ? { uid: u.id, email: u.email, displayName: u.user_metadata?.full_name || '', emailVerified: !!u.email_confirmed_at } : null;

const origin = () => (typeof window === 'undefined' ? '' : window.location.origin);

/** Calls back with the signed-in user (or null) now and on every change. Returns an unsubscribe function. */
export function watchAuth(callback) {
  const { data } = supabase().auth.onAuthStateChange((_event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => callback(toUser(session?.user)), 0);
  });
  return () => data.subscription.unsubscribe();
}

/** The signed-in user's profile. The sign-up trigger creates it, so wait briefly if it's brand new. */
export async function ensureProfile() {
  const { data: auth } = await supabase().auth.getUser();
  if (!auth.user) throw new Error('Sign in first.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase().from('profiles').select('*').eq('id', auth.user.id).maybeSingle();
    if (error) throw error;
    if (data) return data;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error('Your account has no profile. Ask your admin to check Settings → Users & roles.');
}

export async function signIn(email, password) {
  const { data, error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return toUser(data.user);
}

/** Returns { needsConfirmation } — true when Supabase emailed a confirmation link first. */
export async function signUp({ email, password, fullName }) {
  const { data, error } = await supabase().auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: fullName.trim() }, emailRedirectTo: `${origin()}/dashboard` },
  });
  if (error) throw error;
  // Supabase hides "already registered" behind an empty identities list.
  if (data.user && !data.user.identities?.length) throw Object.assign(new Error('exists'), { code: 'user_already_exists' });
  return { needsConfirmation: !data.session };
}

export const resendVerification = (email) =>
  supabase().auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${origin()}/dashboard` } });

export async function signOut() {
  await supabase().auth.signOut();
}

export async function sendReset(email) {
  const { error } = await supabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${origin()}/reset-password` });
  if (error) throw error;
}

/** Sets a new password for the signed-in user (also used by the reset link page). */
export async function setNewPassword(next) {
  const { error } = await supabase().auth.updateUser({ password: next });
  if (error) throw error;
}

/** Checks the current password before changing it. */
export async function changePassword(current, next) {
  const { data } = await supabase().auth.getUser();
  const email = data.user?.email;
  const check = await supabase().auth.signInWithPassword({ email, password: current });
  if (check.error) throw Object.assign(new Error('wrong'), { code: 'invalid_credentials' });
  await setNewPassword(next);
}

// Name and phone live in profiles; a new email is confirmed by a link Supabase sends.
export async function updateOwnProfile(uid, { full_name, phone, email }) {
  const { error } = await supabase().from('profiles').update({ full_name, phone }).eq('id', uid);
  if (error) throw error;
  const { data } = await supabase().auth.getUser();
  if (email && data.user && email.trim().toLowerCase() !== (data.user.email || '').toLowerCase()) {
    const res = await supabase().auth.updateUser({ email: email.trim() }, { emailRedirectTo: `${origin()}/dashboard` });
    if (res.error) throw res.error;
    return { emailPending: true };
  }
  return { emailPending: false };
}
