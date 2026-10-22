import { useState } from 'react';
import { KeyRound, Pencil, Trash2, UserPlus } from 'lucide-react';
import ActionMenu from '../../../components/ui/ActionMenu';
import { Badge } from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Callout from '../../../components/ui/Callout';
import { Card } from '../../../components/ui/Card';
import DataTable from '../../../components/ui/DataTable';
import Field from '../../../components/ui/Field';
import Modal from '../../../components/ui/Modal';
import PasswordStrength from '../../../components/ui/PasswordStrength';
import Select from '../../../components/ui/Select';
import Toggle from '../../../components/ui/Toggle';
import { ROLE_LABELS } from '../../../config/roles';
import { useApp } from '../../../context/AppContext';
import { DEFAULT_CLIENT_PERMISSIONS } from '../../../data/clients';
import { formatDate, initials, isEmail } from '../../../lib/format';
import { authMessage } from '../../../lib/auth';
import { adminCreateUser, adminDeleteUser, adminSendPasswordReset, adminUpdateUser } from '../../../lib/users';
import { MIN_STRENGTH, passwordStrength } from '../../../lib/password';
import { ui } from '../../../styles/ui';
import { CLIENT_PERMISSIONS } from '../../clients/ClientModal';
import StorePicker from '../../clients/StorePicker';

const ROLE_HINTS = {
  admin: 'Every store, every setting, and can switch to any dashboard.',
  manager: 'Only the stores in one store group.',
  client: 'Only the stores of one client account, with its permissions.',
};

const NEW = '__new';

// Starting values for the access fields: the login's current group/client, or a new one.
function initialAccess({ role = 'client', group_id, client_id, full_name, email }, { groups, clients, stores }) {
  const groupId = group_id || groups[0]?.id || NEW;
  const client = clients.find((c) => c.id === client_id) || (client_id ? null : clients[0]) || null;
  return {
    role,
    group_id: groupId,
    group_name: '',
    group_stores: stores.filter((s) => s.groupId === groupId).map((s) => s.id),
    client_id: client ? client.id : NEW,
    client_company: client ? '' : full_name || (email ? email.split('@')[1] || '' : ''),
    client_stores: client ? client.storeIds || [] : [],
    client_permissions: { ...DEFAULT_CLIENT_PERMISSIONS, ...(client?.permissions || {}) },
  };
}

// Role, plus the stores (and for clients, the permissions) that role can see. Shared by the add and edit forms.
function AccessFields({ form, setForm }) {
  const { groups, clients, stores } = useApp();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const groupName = (id) => groups.find((g) => g.id === id)?.name;
  const pickGroup = (id) => set({ group_id: id, group_stores: stores.filter((s) => s.groupId === id).map((s) => s.id) });
  const pickClient = (id) => {
    const c = clients.find((x) => x.id === id);
    set({
      client_id: id,
      client_stores: c ? c.storeIds || [] : [],
      client_permissions: { ...DEFAULT_CLIENT_PERMISSIONS, ...(c?.permissions || {}) },
    });
  };
  const otherGroups = groups.filter((g) => g.id !== form.group_id);

  return (
    <>
      <Field label="Role" hint={ROLE_HINTS[form.role]}>
        <Select
          value={form.role}
          onChange={(v) => set({ role: v })}
          options={['admin', 'manager', 'client'].map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
        />
      </Field>

      {form.role === 'manager' && (
        <>
          <Field label="Store group" hint="A manager sees every store in their group. Several managers can share a group.">
            <Select
              value={form.group_id}
              onChange={pickGroup}
              options={[...groups.map((g) => ({ value: g.id, label: g.name })), { value: NEW, label: '+ New store group…' }]}
            />
          </Field>
          {form.group_id === NEW && (
            <Field label="New group name">
              <input className={ui.input} value={form.group_name} placeholder="e.g. East coast stores" onChange={(e) => set({ group_name: e.target.value })} />
            </Field>
          )}
          <Field
            label="Stores in this group"
            hint={
              otherGroups.length
                ? 'A store is in one group at a time: ticking it moves it here, unticking moves it back to another group.'
                : 'A store is in one group at a time. Add another group under Store groups to take stores out of this one.'
            }
          >
            {stores.length ? (
              <StorePicker
                stores={stores}
                picked={form.group_stores}
                onChange={(ids) => set({ group_stores: ids })}
                othersOf={(storeId) => {
                  const s = stores.find((x) => x.id === storeId);
                  return s && s.groupId && s.groupId !== form.group_id ? [{ company: `group ${groupName(s.groupId)}` }] : [];
                }}
              />
            ) : (
              <Callout>No stores yet. Connect one under Integrations first.</Callout>
            )}
          </Field>
        </>
      )}

      {form.role === 'client' && (
        <>
          <Field label="Client account" hint="Several logins can share one client account.">
            <Select
              value={form.client_id}
              onChange={pickClient}
              options={[...clients.map((c) => ({ value: c.id, label: c.company })), { value: NEW, label: '+ New client account…' }]}
            />
          </Field>
          {form.client_id === NEW && (
            <Field label="Company name">
              <input className={ui.input} value={form.client_company} placeholder="e.g. Blue Tag Peptides" onChange={(e) => set({ client_company: e.target.value })} />
            </Field>
          )}
          <Field label="Stores they can see">
            {stores.length ? (
              <StorePicker stores={stores} picked={form.client_stores} onChange={(ids) => set({ client_stores: ids })} />
            ) : (
              <Callout>No stores yet. Connect one under Integrations first.</Callout>
            )}
          </Field>
          <Field label="Permissions">
            <div className={ui.divide}>
              {Object.entries(CLIENT_PERMISSIONS).map(([key, [label, hint]]) => (
                <Toggle
                  key={key}
                  label={label}
                  hint={hint}
                  checked={!!form.client_permissions[key]}
                  onChange={(on) => set({ client_permissions: { ...form.client_permissions, [key]: on } })}
                />
              ))}
            </div>
          </Field>
        </>
      )}
    </>
  );
}

const accessError = (form) => {
  if (form.role === 'manager' && form.group_id === NEW && !form.group_name.trim()) return 'Name the new store group.';
  if (form.role === 'client' && form.client_id === NEW && !form.client_company.trim()) return 'Enter the client’s company name.';
  if (form.role === 'client' && !form.client_stores.length) return 'Pick at least one store the client can see.';
  return '';
};

/** Saves the group / client account the form describes and returns the profile fields. */
function useResolveAccess() {
  const { saveClientAccess, saveManagerGroup } = useApp();
  return async (form, person) => {
    if (form.role === 'manager') {
      const groupId = await saveManagerGroup({ id: form.group_id === NEW ? '' : form.group_id, name: form.group_name, storeIds: form.group_stores });
      return { role: 'manager', group_id: groupId, client_id: null };
    }
    if (form.role === 'client') {
      const client = await saveClientAccess({
        id: form.client_id === NEW ? '' : form.client_id,
        company: form.client_company,
        storeIds: form.client_stores,
        permissions: form.client_permissions,
        contact: person.full_name || '',
        email: person.email || '',
      });
      return { role: 'client', group_id: null, client_id: client.id };
    }
    return { role: 'admin', group_id: null, client_id: null };
  };
}

function EditUserModal({ account, onClose, onSaved }) {
  const app = useApp();
  const { users, profile: me } = app;
  const resolveAccess = useResolveAccess();
  const [form, setForm] = useState(() => ({ ...initialAccess(account, app), status: account.status }));
  const [error, setError] = useState('');

  const [busy, setBusy] = useState(false);
  const save = async () => {
    const problem = accessError(form);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const patch = await resolveAccess(form, account);
      const updated = await adminUpdateUser(account, { role: patch.role, groupId: patch.group_id, clientId: patch.client_id, status: form.status }, users);
      onSaved(updated);
      return onClose();
    } catch (err) {
      setBusy(false);
      return setError(authMessage(err));
    }
  };

  return (
    <Modal
      title={`Edit ${account.full_name || account.email}`}
      subtitle={<p className={`text-sm ${ui.muted}`}>{account.email}</p>}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <AccessFields form={form} setForm={setForm} />
        <Field label="Status">
          <Select
            value={form.status}
            onChange={(v) => setForm((f) => ({ ...f, status: v }))}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended (can’t open any dashboard)' },
            ]}
          />
        </Field>
        {account.id === me.id && form.role !== 'admin' && (
          <Callout tone="warning">You’re removing your own admin access. Another admin will have to give it back.</Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  );
}

function AddUserModal({ onClose, onSaved }) {
  const app = useApp();
  const resolveAccess = useResolveAccess();
  const [form, setForm] = useState(() => ({ name: '', email: '', password: '', ...initialAccess({ role: 'client' }, app) }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bind = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('Enter a name.');
    if (!isEmail(form.email)) return setError('Enter a valid email.');
    if (passwordStrength(form.password) < MIN_STRENGTH) return setError('Pick a stronger password.');
    // A new client account is named after the person unless a company name was typed.
    const filled = { ...form, client_company: form.client_company || form.name };
    const problem = accessError(filled);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const patch = await resolveAccess(filled, { full_name: form.name.trim(), email: form.email.trim() });
      const result = await adminCreateUser({
        email: form.email.trim(),
        password: form.password,
        fullName: form.name.trim(),
        role: patch.role,
        groupId: patch.group_id,
        clientId: patch.client_id,
      });
      onSaved(result.profile, true);
    } catch (err) {
      setBusy(false);
      return setError(authMessage(err));
    }
    return onClose();
  };

  return (
    <Modal
      title="Add user"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-user-form" variant="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </Button>
        </>
      }
    >
      <form id="add-user-form" onSubmit={save} className="space-y-4">
        <Field label="Full name">
          <input className={ui.input} value={form.name} onChange={bind('name')} />
        </Field>
        <Field label="Email (used to sign in)">
          <input type="email" className={ui.input} value={form.email} onChange={bind('email')} />
        </Field>
        <Field label="Temporary password" hint="Share it with them; they can change it from their account menu.">
          <input type="text" autoComplete="off" className={`${ui.input} font-mono`} value={form.password} onChange={bind('password')} />
        </Field>
        {form.password && <PasswordStrength value={form.password} />}
        <AccessFields form={form} setForm={setForm} />
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Modal>
  );
}

// Supabase sign-in accounts (profiles table). Admin-only tab; Row Level Security allows these changes only for admins.
export default function UsersTab() {
  const { groups, clients, users: accounts, profile: me, log, showToast, askConfirm } = useApp();
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const linkLabel = (a) => {
    if (a.role === 'admin') return 'All stores';
    if (a.role === 'manager') return groups.find((g) => g.id === a.group_id)?.name || <span className="text-amber-700 dark:text-amber-400">No group yet</span>;
    return clients.find((c) => c.id === a.client_id)?.company || <span className="text-amber-700 dark:text-amber-400">Not linked yet</span>;
  };

  const onSaved = (user, created) => {
    const label = ROLE_LABELS[user.role].toLowerCase();
    log(`${created ? 'Added' : 'Updated'} ${user.email} as ${label}${user.status === 'suspended' ? ' (suspended)' : ''}`, 'team');
    showToast({ title: created ? 'User added' : 'Access updated', body: `${user.email} is ${label}.` });
  };

  const remove = (a) =>
    askConfirm({
      title: `Delete ${a.full_name || a.email}?`,
      body: 'Their sign-in account is deleted and they lose access to every dashboard. Store data isn’t affected.',
      onConfirm: async () => {
        try {
          await adminDeleteUser(a.id);
        } catch (err) {
          return showToast({ tone: 'danger', title: 'Couldn’t delete', body: authMessage(err) });
        }
        log(`Deleted user ${a.email}`, 'team');
        return showToast({ title: 'User deleted', body: a.email });
      },
    });

  return (
    <Card
      title={`Users & roles (${accounts.length})`}
      action={
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          <UserPlus size={13} /> Add user
        </Button>
      }
    >
      <p className={`px-4 pt-4 text-sm sm:px-5 ${ui.muted}`}>
        People who sign up themselves start as clients with no stores. Give managers a store group and clients a client account so they can see their
        dashboard. Sign-in is handled by Supabase; suspended accounts can’t open any dashboard.
      </p>
      <DataTable
        rows={accounts}
        empty="No users yet."
        columns={[
          {
            key: 'name',
            label: 'User',
            primary: true,
            render: (a) => (
              <div className="flex min-w-0 items-center gap-3">
                <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200 sm:flex">
                  {initials(a.full_name || a.email)}
                </span>
                <div className="min-w-0">
                  <p className={`truncate font-medium ${ui.h}`}>
                    {a.full_name || '—'}
                    {a.id === me.id && <span className={`ml-1 text-xs font-normal ${ui.muted}`}>(you)</span>}
                  </p>
                  <p className={`truncate text-xs font-normal ${ui.muted}`}>{a.email}</p>
                </div>
              </div>
            ),
          },
          { key: 'role', label: 'Role', render: (a) => ROLE_LABELS[a.role] },
          { key: 'link', label: 'Sees', render: linkLabel },
          { key: 'joined', label: 'Joined', render: (a) => formatDate(new Date(a.created_at).getTime()) },
          { key: 'status', label: 'Status', aside: true, render: (a) => <Badge status={a.status === 'suspended' ? 'suspended' : 'active'} /> },
          {
            key: 'actions',
            label: '',
            align: 'right',
            actions: true,
            render: (a) => (
              <div className="flex items-center justify-end gap-1">
                <Button size="sm" onClick={() => setEditing(a)}>
                  <Pencil size={12} /> Edit access
                </Button>
                <ActionMenu
                  items={[
                    {
                      label: 'Send password reset email',
                      icon: KeyRound,
                      onClick: () =>
                        adminSendPasswordReset(a.email).then(
                          () => {
                            log(`Sent a password reset email to ${a.email}`, 'team');
                            showToast({ title: 'Reset email sent', body: a.email });
                          },
                          (err) => showToast({ tone: 'danger', title: 'Couldn’t send', body: authMessage(err) }),
                        ),
                    },
                    { label: 'Delete user', icon: Trash2, danger: true, hidden: a.id === me.id, onClick: () => remove(a) },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />
      {adding && <AddUserModal onClose={() => setAdding(false)} onSaved={onSaved} />}
      {editing && <EditUserModal account={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </Card>
  );
}
