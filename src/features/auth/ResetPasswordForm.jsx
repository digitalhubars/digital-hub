'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import Button from '../../components/ui/Button';
import Callout from '../../components/ui/Callout';
import Field from '../../components/ui/Field';
import PasswordStrength from '../../components/ui/PasswordStrength';
import { authMessage, setNewPassword, watchAuth } from '../../lib/auth';
import { MIN_STRENGTH, passwordStrength } from '../../lib/password';
import { ui } from '../../styles/ui';
import AuthShell from './AuthShell';

// Opened from the reset email: Supabase signs the person in from the link, then they pick a new password.
export default function ResetPasswordForm() {
  const router = useRouter();
  const [user, setUser] = useState(undefined); // undefined = still reading the link
  const [form, setForm] = useState({ next: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bind = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  useEffect(() => watchAuth((u) => setUser(u)), []);

  const submit = async (e) => {
    e.preventDefault();
    if (passwordStrength(form.next) < MIN_STRENGTH) return setError('Pick a stronger password.');
    if (form.next !== form.confirm) return setError('The passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      await setNewPassword(form.next);
    } catch (err) {
      setBusy(false);
      return setError(authMessage(err));
    }
    return router.replace('/dashboard');
  };

  const back = (
    <Link href="/signin" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
      Back to sign in
    </Link>
  );

  if (user === undefined) return <AuthShell title="Choose a new password">Checking your link…</AuthShell>;
  if (user === null) {
    return (
      <AuthShell title="This link has expired" footer={back}>
        <Callout icon={TriangleAlert} tone="warning">
          Reset links work once and expire after an hour.{' '}
          <Link href="/forgot-password" className="font-medium underline">
            Send a new link
          </Link>
          .
        </Callout>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" description={`For ${user.email}`} footer={back}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password">
          <input type="password" autoComplete="new-password" className={ui.input} value={form.next} onChange={bind('next')} />
        </Field>
        {form.next && <PasswordStrength value={form.next} />}
        <Field label="Confirm new password">
          <input type="password" autoComplete="new-password" className={ui.input} value={form.confirm} onChange={bind('confirm')} />
        </Field>
        {error && (
          <Callout icon={TriangleAlert} tone="danger">
            {error}
          </Callout>
        )}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
      </form>
    </AuthShell>
  );
}
