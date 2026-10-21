import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, sendEmailVerification, sendPasswordResetEmail, signOut, updateProfile } from 'firebase/auth';
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
import { fb } from './firebase/client';

// Admin user management from the browser. firestore.rules allow these writes only for admins.

/** Creates a sign-in account without signing the admin out (uses a second, temporary Firebase app). */
export async function adminCreateUser({ email, password, fullName, role, groupId, clientId }) {
  const { app, db } = fb();
  const temp = initializeApp(app.options, `create-${Date.now()}`);
  try {
    const tempAuth = getAuth(temp);
    if (process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === 'true') connectAuthEmulator(tempAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    const cred = await createUserWithEmailAndPassword(tempAuth, email.trim(), password);
    await updateProfile(cred.user, { displayName: fullName });
    await sendEmailVerification(cred.user).catch(() => {});
    const profile = {
      email: cred.user.email,
      full_name: fullName,
      phone: '',
      role,
      group_id: role === 'manager' ? groupId || null : null,
      client_id: role === 'client' ? clientId || null : null,
      status: 'active',
      created_at: new Date().toISOString(),
    };
    await setDoc(doc(db, 'users', cred.user.uid), profile);
    await signOut(tempAuth);
    return { uid: cred.user.uid, profile };
  } finally {
    await deleteApp(temp).catch(() => {});
  }
}

/** Changes role / links / status. Refuses to leave the workspace without an active admin. */
export async function adminUpdateUser(account, { role, groupId, clientId, status }, allUsers) {
  const next = {
    role,
    status: status === 'suspended' ? 'suspended' : 'active',
    group_id: role === 'manager' ? groupId || null : null,
    client_id: role === 'client' ? clientId || null : null,
  };
  const losingAdmin = account.role === 'admin' && account.status === 'active' && (next.role !== 'admin' || next.status !== 'active');
  if (losingAdmin && !allUsers.some((u) => u.id !== account.id && u.role === 'admin' && u.status === 'active')) {
    throw new Error('At least one active admin must remain.');
  }
  await updateDoc(doc(fb().db, 'users', account.id), next);
  return { ...account, ...next };
}

export const adminSendPasswordReset = (email) => sendPasswordResetEmail(fb().auth, email);

// Removes the profile, so the account can't open any dashboard. If the person signs in again
// they start over as a client with no stores.
export const adminDeleteUser = (uid) => deleteDoc(doc(fb().db, 'users', uid));
