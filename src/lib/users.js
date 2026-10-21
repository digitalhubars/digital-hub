import { callApi, must, supabase } from './supabase/client';
import { sendReset } from './auth';

// Admin user management. Creating and deleting sign-in accounts needs the secret key,
// so it goes through the API route; profile changes are plain updates that Row Level
// Security allows only for admins.

/** Creates a sign-in account (email already confirmed) and its profile. */
export async function adminCreateUser({ email, password, fullName, role, groupId, clientId }) {
  return callApi('admin/users', { action: 'create', email: email.trim(), password, fullName, role, groupId, clientId });
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
  must(await supabase().from('profiles').update(next).eq('id', account.id));
  return { ...account, ...next };
}

export const adminSendPasswordReset = (email) => sendReset(email);

// Deletes the sign-in account and its profile.
export const adminDeleteUser = (uid) => callApi('admin/users', { action: 'delete', uid });
