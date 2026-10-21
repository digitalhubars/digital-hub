'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { parseRoute } from '../../config/navigation';
import { AppProvider } from '../../context/AppContext';
import { authMessage, ensureProfile, watchAuth } from '../../lib/auth';
import { supabase, supabaseConfigured } from '../../lib/supabase/client';
import AccountBlocked from '../auth/AccountBlocked';
import AuthShell from '../auth/AuthShell';
import SetupNotice from '../auth/SetupNotice';
import AppShell from './AppShell';
import { Loading } from './ClientApp';

// Signed-in area: waits for Supabase Auth and the user's profile, then draws the app.
export default function AppRoot() {
  const pathname = usePathname();
  const router = useRouter();
  const [authUser, setAuthUser] = useState(undefined); // undefined = still checking
  const [profile, setProfile] = useState(undefined);
  const [error, setError] = useState('');

  useEffect(() => (supabaseConfigured ? watchAuth((u) => setAuthUser(u)) : undefined), []);

  // Live profile: role changes made by an admin apply right away.
  const uid = authUser?.uid;
  useEffect(() => {
    if (!uid) {
      setProfile(authUser === null ? null : undefined);
      return undefined;
    }
    let active = true;
    ensureProfile().then(
      (p) => active && setProfile(p),
      (err) => active && setError(authMessage(err)),
    );
    const channel = supabase()
      .channel(`profile:${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` }, (payload) => {
        if (payload.eventType === 'DELETE') setError('Your account was removed. Ask your admin.');
        else setProfile(payload.new);
      })
      .subscribe();
    return () => {
      active = false;
      supabase().removeChannel(channel);
    };
    // Only re-run when a different person signs in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, authUser === null]);

  // Access gate: signed-out → sign-in page; managers and clients → their own dashboard only.
  const env = pathname.split('/').filter(Boolean)[0];
  const wrongDashboard = profile && profile.role !== 'admin' && env !== profile.role;
  useEffect(() => {
    if (authUser === null) router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
    else if (wrongDashboard) router.replace(`/${profile.role}`);
  }, [authUser, wrongDashboard, profile, pathname, router]);

  const route = useMemo(() => parseRoute(pathname, profile?.role || 'client'), [pathname, profile?.role]);
  const navigate = useCallback((path, { replace = false } = {}) => (replace ? router.replace(path) : router.push(path)), [router]);

  if (!supabaseConfigured) {
    return (
      <AuthShell title="Supabase isn’t connected yet">
        <SetupNotice />
      </AuthShell>
    );
  }
  if (error) {
    return (
      <AuthShell title="Couldn’t load your account">
        <AccountBlocked title="Something went wrong" body={error} />
      </AuthShell>
    );
  }
  if (!profile || wrongDashboard) return <Loading />;

  return (
    <AppProvider profile={profile} route={route} navigate={navigate}>
      <AppShell />
    </AppProvider>
  );
}
