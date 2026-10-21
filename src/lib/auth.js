import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { isOwnerEmail } from '../config/owner';
import { fb } from './firebase/client';

// Sign-in with Firebase Authentication (email + password).
// Roles live in Firestore users/{uid}; firestore.rules decide who may set them.

const FRIENDLY = {
  'auth/invalid-credential': 'Email or password is wrong.',
  'auth/wrong-password': 'Email or password is wrong.',
  'auth/user-not-found': 'Email or password is wrong.',
  'auth/invalid-email': 'Enter a valid email.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Pick a stronger password.',
  'auth/user-disabled': 'This account is suspended. Ask your admin.',
  'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
  'auth/network-request-failed': 'Can’t reach the server. Check your connection.',
  'auth/requires-recent-login': 'Sign out and in again, then retry.',
  'permission-denied': 'You don’t have access to this. Ask your admin.',
  unavailable: 'Can’t reach the database. Check your connection and try again.',
};

export const authMessage = (err) => FRIENDLY[err?.code] || err?.message?.replace(/^Firebase: /, '') || 'Something went wrong.';

export const watchAuth = (callback) => onAuthStateChanged(fb().auth, callback);

// Starting point for a brand-new workspace (written once the owner is admin).
async function seedWorkspace() {
  const { db } = fb();
  await setDoc(doc(db, 'workspace', 'settings'), { workspaceName: 'Digital Hub', currency: 'USD', lowStockThreshold: 10 }, { merge: true });
  await setDoc(doc(db, 'groups', 'g_main'), { name: 'Main' }, { merge: true });
}

/**
 * Creates users/{uid} on first sign-in: the owner (confirmed email) as admin, everyone
 * else as a client with no stores. Promotes the owner once their email is confirmed.
 * Safe to call on every load; firestore.rules enforce the same limits.
 */
export async function ensureProfile(fullName = '') {
  const { auth, db } = fb();
  let user = auth.currentUser;
  if (!user) throw new Error('Sign in first.');
  if (!user.emailVerified) {
    await user.reload();
    user = auth.currentUser;
    if (user.emailVerified) await user.getIdToken(true); // so the rules see the confirmed email
  }
  const owner = isOwnerEmail(user.email) && user.emailVerified;
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email,
      full_name: String(fullName || user.displayName || '').trim().slice(0, 120),
      phone: '',
      role: owner ? 'admin' : 'client',
      group_id: null,
      client_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    if (owner) await seedWorkspace();
    return { created: true, role: owner ? 'admin' : 'client' };
  }

  const current = snap.data();
  if (user.email && current.email !== user.email) await updateDoc(ref, { email: user.email });
  if (owner && current.role === 'client' && !current.client_id) {
    await updateDoc(ref, { role: 'admin' });
    await seedWorkspace();
    return { created: false, role: 'admin' };
  }
  return { created: false, role: current.role };
}

export const resendVerification = () => sendEmailVerification(fb().auth.currentUser);

export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(fb().auth, email.trim(), password);
  await ensureProfile(cred.user.displayName || '');
  return cred.user;
}

export async function signUp({ email, password, fullName }) {
  const cred = await createUserWithEmailAndPassword(fb().auth, email.trim(), password);
  await updateProfile(cred.user, { displayName: fullName.trim() });
  await sendEmailVerification(cred.user).catch(() => {});
  return ensureProfile(fullName.trim());
}

export const signOut = () => firebaseSignOut(fb().auth);

export const sendReset = (email) => sendPasswordResetEmail(fb().auth, email.trim());

export async function changePassword(current, next) {
  const user = fb().auth.currentUser;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
  await updatePassword(user, next);
}

// Name and phone live in Firestore; a new email is confirmed by a link Firebase sends.
export async function updateOwnProfile(uid, { full_name, phone, email }) {
  await updateDoc(doc(fb().db, 'users', uid), { full_name, phone });
  const user = fb().auth.currentUser;
  if (email && user && email.trim().toLowerCase() !== (user.email || '').toLowerCase()) {
    await verifyBeforeUpdateEmail(user, email.trim());
    return { emailPending: true };
  }
  return { emailPending: false };
}
