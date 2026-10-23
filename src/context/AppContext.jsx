import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { defaultSettings, isOAuthPlatform, PLATFORMS, sessions as initialSessions } from '../data';
import { isCsvPlatform } from '../data/platforms';
import { canVisitPage, routePath, settingsTabsFor } from '../config/navigation';
import { getAccess } from '../config/roles';
import { signOut as authSignOut, updateOwnProfile, authMessage } from '../lib/auth';
import { toRow } from '../lib/db/schema';
import { callApi, supabase } from '../lib/supabase/client';
import { useLiveList, useWorkspaceSettings } from '../lib/supabase/live';
import { diffFields, formatMoney, uid } from '../lib/format';
import { DEFAULT_PERIOD, PERIODS } from '../lib/period';
import { loadSampleData as seedSampleData, removeSampleData as clearSampleData } from '../lib/sampleData';
import { restoreBackup, workspaceToFile } from '../lib/storage';
import { STATUS } from '../styles/ui';

const AppContext = createContext(null);

export const useApp = () => useContext(AppContext);

const withoutKey = (obj, key) => {
  const { [key]: _removed, ...rest } = obj;
  return rest;
};

const byNewest = (field) => (a, b) => (b[field] || 0) - (a[field] || 0);

const callError = (err) => err?.message || 'Something went wrong.';

/**
 * profile:  the signed-in user's row in public.profiles (role, group_id, client_id…)
 * route:    { env, page, tab } parsed from the URL; `env` is the dashboard being viewed
 * navigate: (path, { replace }) => void
 */
export function AppProvider({ children, profile: initialProfile, route, navigate }) {
  // ---- Session -------------------------------------------------------------
  // `realRole` comes from the profile (only admins can change it).
  // `role` is the dashboard on screen: always realRole, except admins can open any.
  const [profile, setProfile] = useState(initialProfile);
  useEffect(() => setProfile(initialProfile), [initialProfile]);
  const realRole = profile.role;
  const isAdmin = realRole === 'admin';
  const role = isAdmin ? route.env : realRole;
  const page = route.page;
  const settingsTab = route.tab;
  // Admin-only: which manager / client to preview.
  const [viewAs, setViewAs] = useState({ manager: '', client: '' });
  const isPreview = isAdmin && role !== 'admin';

  const setRole = (next) => {
    if (isAdmin) navigate(routePath(next));
  };

  // ---- Feedback (declared early: data hooks report write errors here) -------
  const [toast, setToast] = useState(null);
  const showToast = useCallback((t) => setToast(t), []);
  const dismissToast = () => setToast(null);
  const reportWriteError = useCallback(
    (err, name) => showToast({ tone: 'danger', title: 'Couldn’t save', body: `${name}: ${err.code === '42501' ? 'you don’t have access to change this.' : err.message}` }),
    [showToast],
  );

  useEffect(() => {
    if (!toast || toast.pending) return undefined;
    const timer = setTimeout(() => setToast(null), toast.payload ? 7000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  // ---- Live data from Supabase ------------------------------------------------
  // Everyone loads "everything"; Row Level Security returns only what each person may
  // see (admins: all; managers: their group's stores; clients: their client's stores).
  const live = { onError: reportWriteError };

  const [groupRows, setGroups, groupsLoading] = useLiveList('groups', live);
  const [clients, setClients] = useLiveList('clients', { ...live, enabled: isAdmin || (realRole === 'client' && !!profile.client_id) });
  const [stores, setStores] = useLiveList('stores', live);
  const [products, setProducts] = useLiveList('products', {
    ...live,
    sort: (a, b) => (a.title || '').localeCompare(b.title || ''),
    // Deleting a product asks the server to delete it in the store first.
    softDelete: () => ({ pendingDelete: true, syncState: 'pending', updatedBy: profile.id, editedAt: Date.now() }),
  });
  const [orders, setOrders] = useLiveList('orders', { ...live, sort: byNewest('placedAt') });
  const [customerRecords] = useLiveList('customers', live);
  const [users] = useLiveList('profiles', { ...live, enabled: isAdmin });
  const [activity, setActivity] = useLiveList('activity', {
    ...live,
    enabled: isAdmin,
    order: { column: 'at', ascending: false },
    limit: 300,
    sort: byNewest('at'),
  });
  const [notifications, setNotifications] = useLiveList('notifications', {
    ...live,
    enabled: isAdmin,
    order: { column: 'at', ascending: false },
    limit: 50,
    sort: byNewest('at'),
  });
  const [settingsDoc, updateSettingsDoc] = useWorkspaceSettings(live);
  const settings = useMemo(() => ({ ...defaultSettings, ...(settingsDoc || {}) }), [settingsDoc]);
  const [sessions, setSessions] = useState(initialSessions);

  // Each group's stores, worked out from the stores' groupId.
  const groups = useMemo(
    () => groupRows.map((g) => ({ ...g, storeIds: stores.filter((s) => s.groupId === g.id).map((s) => s.id) })),
    [groupRows, stores],
  );

  // A workspace always has at least one group, and every store belongs to one.
  useEffect(() => {
    if (!isAdmin || groupsLoading) return;
    if (!groupRows.length) {
      setGroups([{ id: 'g_main', name: 'Main' }]).catch(() => {});
      return;
    }
    if (stores.some((s) => !s.groupId || !groupRows.some((g) => g.id === s.groupId))) {
      const fallback = groupRows[0].id;
      setStores((list) => list.map((s) => (!s.groupId || !groupRows.some((g) => g.id === s.groupId) ? { ...s, groupId: fallback } : s))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, groupsLoading, groupRows, stores]);

  // People, shaped like the old team list (used for previews and pickers).
  const team = useMemo(
    () => users.map((u) => ({ id: u.id, name: u.full_name || u.email, email: u.email, role: u.role, groupId: u.group_id, status: u.status })),
    [users],
  );

  // ---- UI state ------------------------------------------------------------
  const [search, setSearch] = useState('');

  // Date period for the Dashboard and Orders page (remembered in this browser).
  const [period, setPeriodState] = useState(() => {
    try {
      const saved = localStorage.getItem('digital-hub:period');
      return PERIODS.some((p) => p.value === saved) ? saved : DEFAULT_PERIOD;
    } catch {
      return DEFAULT_PERIOD;
    }
  });
  const setPeriod = (value) => {
    setPeriodState(value);
    try {
      localStorage.setItem('digital-hub:period', value);
    } catch {
      // ignore
    }
  };
  const [syncingStores, setSyncingStores] = useState({}); // storeId -> true while syncing
  const [drawer, setDrawer] = useState(null); // { type: 'order' | 'customer', id }
  const [confirmDialog, setConfirmDialog] = useState(null);
  const mainRef = useRef(null);

  // Products waiting for the store to confirm an edit.
  const syncing = useMemo(() => Object.fromEntries(products.filter((p) => p.syncState === 'pending').map((p) => [p.id, true])), [products]);

  // ---- Theme (per browser) ---------------------------------------------------
  const [themePref, setThemePrefState] = useState(() => {
    try {
      return localStorage.getItem('digital-hub:theme') || 'system';
    } catch {
      return 'system';
    }
  });
  const setThemePref = (value) => {
    setThemePrefState(value);
    try {
      localStorage.setItem('digital-hub:theme', value);
    } catch {
      // ignore
    }
  };
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    setSystemDark(mq.matches);
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const dark = themePref === 'dark' || (themePref === 'system' && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);

  const toggleTheme = () => setThemePref(dark ? 'light' : 'dark');

  // ---- Who is signed in and what they can see -----------------------------
  const previewClientId = viewAs.client || clients[0]?.id;
  const previewManagerId = viewAs.manager || team.find((m) => m.role === 'manager')?.id;

  const client =
    role !== 'client'
      ? null
      : isPreview
        ? clients.find((c) => c.id === previewClientId) || null
        : clients.find((c) => c.id === profile.client_id) || null;

  const currentUser = useMemo(() => {
    const me = {
      id: profile.id,
      name: profile.full_name || profile.email,
      email: profile.email,
      phone: profile.phone || '',
      title: profile.title || '',
      groupId: profile.group_id,
    };
    if (!isPreview) return me;
    if (role === 'manager') return team.find((m) => m.id === previewManagerId) || { id: 'none', name: 'No manager yet', email: '', groupId: null };
    return client ? { id: client.id, name: client.contact, email: client.email, phone: client.phone } : { id: 'none', name: 'No client', email: '' };
  }, [profile, isPreview, role, team, previewManagerId, client]);

  const user = { ...currentUser, role };
  const access = getAccess(role, client);

  const scopedStores = useMemo(() => {
    if (role === 'admin') return stores;
    if (role === 'manager') return stores.filter((s) => s.groupId === currentUser?.groupId);
    return stores.filter((s) => client?.storeIds?.includes(s.id));
  }, [role, stores, currentUser, client]);

  // Managers can narrow their view with the store filter bar.
  const [selectedStores, setSelectedStores] = useState([]);
  const scopedKey = scopedStores.map((s) => s.id).join(',');
  useEffect(() => {
    setSelectedStores(scopedStores.map((s) => s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, previewManagerId, scopedKey]);

  const storeIds =
    role === 'manager' ? selectedStores.filter((id) => scopedStores.some((s) => s.id === id)) : scopedStores.map((s) => s.id);

  // Customer totals are derived from synced orders.
  const customers = useMemo(
    () =>
      customerRecords.map((c) => {
        const theirs = orders.filter((o) => o.customerId === c.id);
        const counted = theirs.filter((o) => o.status !== 'refunded' && o.status !== 'cancelled');
        return {
          ...c,
          orderCount: theirs.length,
          spent: counted.reduce((sum, o) => sum + (o.total || 0), 0),
          lastOrder: theirs[0]?.placedAt,
        };
      }),
    [customerRecords, orders],
  );

  const storeMap = useMemo(() => Object.fromEntries(stores.map((s) => [s.id, s])), [stores]);
  const customerMap = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers]);
  const storeOf = (id) => storeMap[id];
  const customerOf = (id) => customerMap[id];
  const money = (value) => formatMoney(Number(value) || 0, settings.currency);

  // ---- Navigation ----------------------------------------------------------
  const go = (target, tab) => {
    const next = canVisitPage(target, access) ? target : 'dashboard';
    navigate(routePath(role, next, next === 'settings' ? tab : null));
    setDrawer(null);
    mainRef.current?.scrollTo?.({ top: 0 });
  };

  // Keep the URL valid for whoever is looking.
  useEffect(() => {
    if (!isAdmin && route.env !== realRole) {
      navigate(routePath(realRole), { replace: true });
    } else if (!canVisitPage(page, access)) {
      navigate(routePath(role), { replace: true });
    } else if (page === 'settings' && settingsTab && !settingsTabsFor(role).some((t) => t.key === settingsTab)) {
      navigate(routePath(role, 'settings'), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.env, page, settingsTab, role, access.manageSystem, access.viewCustomers]);

  useEffect(() => setDrawer(null), [role, viewAs.client]);

  // ---- Activity & notifications ------------------------------------------------
  const log = (text, type) =>
    setActivity((list) => [{ id: uid('a'), at: Date.now(), actor: currentUser.name, actorId: profile.id, type, text }, ...list]).catch(() => {});

  const notify = (text, tone = 'success') =>
    supabase()
      .from('notifications')
      .insert(toRow('notifications', { id: uid('n'), at: Date.now(), text, tone, read: false }))
      .then(() => {}, () => {});

  const markAllRead = () => setNotifications((list) => list.map((n) => ({ ...n, read: true }))).catch(() => {});

  const askConfirm = (options) => setConfirmDialog(options);
  const closeConfirm = () => setConfirmDialog(null);
  const openDrawer = (type, id) => setDrawer({ type, id });
  const closeDrawer = () => setDrawer(null);

  const stamp = () => ({ syncState: 'pending', syncError: null, updatedBy: profile.id, editedAt: Date.now() });

  // Tells the user how the store answered.
  // Sends a pending product/order to its store (server route) and returns { state, error }.
  // `before` holds the fields the store update needs to compare against.
  const pushToStore = (table, id, before) =>
    callApi('sync/push', { table, id, before }).catch((err) => ({ state: 'error', error: callError(err) }));

  const reportSync = async (collectionName, id, { title, success, store, before }) => {
    // Sample, paused and import-only stores answer at once: the server marks the row synced
    // (samples), leaves it pending (paused) or records that the platform doesn't take edits.
    if (store?.sample || store?.status === 'paused' || (store && !PLATFORMS[store.platform]?.twoWay)) {
      pushToStore(collectionName, id, before);
      if (store.sample) return showToast({ title: success, body: `${store.name} is a sample store, so nothing was sent.` });
      if (store.status === 'paused') return showToast({ title: 'Saved. Waiting to sync', body: `${store.name} is paused. The change goes out when it resumes.` });
      return showToast({
        title: 'Saved in Digital Hub',
        body: `${store.platform} data syncs into Digital Hub, but edits aren’t sent to ${store.platform} yet, so ${store.name} wasn’t changed.`,
      });
    }
    showToast({ pending: true, title, body: store?.name });
    const result = await pushToStore(collectionName, id, before);
    if (result.state === 'synced' || result.state === 'gone') return showToast({ title: success, body: store?.name });
    if (result.state === 'pending') return showToast({ title: 'Saved. Waiting to sync', body: result.error || 'The change goes out on the next sync.' });
    return showToast({ tone: 'danger', title: 'The store didn’t accept the change', body: result.error });
  };

  // ---- Products & orders ---------------------------------------------------
  const saveProduct = async (product, previous) => {
    const store = storeOf(product.storeId);
    const isNew = !previous;
    const record = isNew ? { ...product, id: uid('p'), externalId: 'pending', ...stamp() } : { ...product, ...stamp() };
    const changes = diffFields(previous, record, ['title', 'sku', 'category', 'price', 'stock', 'status']);
    if (!isNew && !Object.keys(changes).length) return showToast({ title: 'No changes to save' });

    try {
      await setProducts((list) => (isNew ? [record, ...list] : list.map((p) => (p.id === record.id ? record : p))));
    } catch {
      return undefined; // reportWriteError already showed why
    }
    log(`${isNew ? 'Added' : 'Updated'} ${record.title} in ${store.name}`, 'product');
    if (role === 'client' && settings.notify.clientActivity) notify(`${client?.company} ${isNew ? 'added' : 'updated'} ${record.title}`, 'success');
    if (record.stock != null && record.stock < settings.lowStockThreshold && (isNew || previous.stock == null || previous.stock >= settings.lowStockThreshold) && settings.notify.lowStock) {
      notify(`${record.title} is low on stock (${record.stock} left).`, 'warning');
    }
    return reportSync('products', record.id, {
      title: `Sending to ${store.platform}…`,
      success: `${record.title} ${isNew ? 'created' : 'updated'} in ${store.platform}`,
      store,
      before: previous ? { stock: previous.stock, category: previous.category, title: previous.title, price: previous.price, status: previous.status, sku: previous.sku } : null,
    });
  };

  const deleteProduct = async (product) => {
    const store = storeOf(product.storeId);
    try {
      await setProducts((list) => list.filter((p) => p.id !== product.id));
    } catch {
      return undefined;
    }
    log(`Deleted ${product.title} from ${store.name}`, 'product');
    return reportSync('products', product.id, { title: `Deleting in ${store.platform}…`, success: `${product.title} deleted`, store });
  };

  const updateOrderStatus = async (order, status) => {
    const store = storeOf(order.storeId);
    const label = STATUS[status][0].toLowerCase();
    try {
      await setOrders((list) => list.map((o) => (o.id === order.id ? { ...o, status, ...stamp() } : o)));
    } catch {
      return undefined;
    }
    log(`Marked order ${order.number} as ${label}`, 'order');
    return reportSync('orders', order.id, { title: `Updating order in ${store.platform}…`, success: `Order ${order.number} is now ${label}`, store });
  };

  // ---- Integrations --------------------------------------------------------
  // The server does the work for every platform (src/server/platforms); these call it.

  const resyncStore = async (store, { quiet } = {}) => {
    if (store.status === 'paused') return;
    if (store.sample || isCsvPlatform(store.platform)) {
      if (!quiet) {
        showToast({
          title: store.sample ? `${store.name} is a sample store` : `${store.platform} has no API`,
          body: store.sample ? undefined : 'Import its orders and listings as CSV files from the store’s menu.',
        });
      }
      return;
    }
    setSyncingStores((s) => ({ ...s, [store.id]: true }));
    if (!quiet) showToast({ pending: true, title: `Syncing ${store.name}…`, body: 'Importing products, orders and customers.' });
    try {
      const result = await callApi('stores/sync', { storeId: store.id });
      if (result.ok) {
        const c = result.counts;
        showToast({
          title: `${store.name} is up to date`,
          body: [c && `${c.products} products, ${c.orders} orders, ${c.customers} customers.`, result.message].filter(Boolean).join(' '),
        });
      } else {
        showToast({ tone: 'danger', title: `${store.name} didn’t sync`, body: result.message });
        if (settings.notify.syncFailed) notify(`Sync failed for ${store.name}: ${result.message}`, 'danger');
      }
    } catch (err) {
      showToast({ tone: 'danger', title: `${store.name} didn’t sync`, body: callError(err) });
    } finally {
      setSyncingStores((s) => withoutKey(s, store.id));
    }
  };

  /** form: { platform, storeId?, input? } — `input` = the typed keys (tested without saving). */
  const testConnection = async ({ platform, storeId, input }) => {
    try {
      return await callApi('stores/test', { platform, storeId, input });
    } catch (err) {
      return { ok: false, message: callError(err) };
    }
  };

  /** Authorize / Re-authorize: sends the admin to the marketplace's sign-in, which redirects back. */
  const authorizeStore = async (store) => {
    showToast({ pending: true, title: `Opening ${store.platform}…`, body: 'Sign in and approve access, then you’ll come back here.' });
    try {
      const { url } = await callApi('integrations/authorize', { storeId: store.id });
      window.location.assign(url);
    } catch (err) {
      showToast({ tone: 'danger', title: `Couldn’t start ${store.platform} authorization`, body: callError(err) });
    }
  };

  /** CSV import for stores without an API (Mercari). kind: 'orders' | 'listings'. */
  const importStoreCsv = async (store, kind, file) => {
    showToast({ pending: true, title: `Importing ${kind}…`, body: file.name });
    try {
      const result = await callApi('integrations/import', { storeId: store.id, kind, csv: await file.text() });
      log(`Imported ${kind} into ${store.name} from ${file.name}`, 'integration');
      showToast({ title: `${store.name} updated`, body: result.message });
      return result;
    } catch (err) {
      showToast({ tone: 'danger', title: 'Couldn’t import the file', body: callError(err) });
      return null;
    }
  };

  const setStoreClients = (store, clientIds) => {
    setClients((list) =>
      list.map((c) => {
        const had = (c.storeIds || []).includes(store.id);
        const has = clientIds.includes(c.id);
        if (had === has) return c;
        return { ...c, storeIds: has ? [...(c.storeIds || []), store.id] : c.storeIds.filter((id) => id !== store.id) };
      }),
    ).catch(() => {});
    log(`Updated client access for ${store.name}`, 'client');
    showToast({ title: 'Client access saved', body: `${clientIds.length} client${clientIds.length === 1 ? '' : 's'} can see ${store.name}.` });
  };

  /**
   * store: the store fields. credentials: the typed keys when they changed —
   * WooCommerce { consumerKey, consumerSecret }; other platforms their `fields` (Shopify { domain, token },
   * eBay's own app { clientId, clientSecret, ruName }, …).
   * Keys go to the server, which checks them and saves them encrypted; no browser can read them back.
   * options.authorize: for OAuth platforms, go straight to the marketplace's sign-in after saving.
   */
  const saveStore = async (store, isNew, clientId, credentials, { authorize = false } = {}) => {
    const { credentialsChanged: _c, ...data } = store;
    const id = isNew ? uid('st') : data.id;
    const previous = storeOf(id);
    const auth = PLATFORMS[data.platform]?.auth;
    const isWoo = data.platform === 'WooCommerce';
    const samePlatform = previous?.platform === data.platform;
    const urlChanged = !isNew && previous?.url !== data.url;
    const health =
      auth === 'oauth'
        ? samePlatform && previous?.health && previous.health !== 'manual' ? previous.health : 'needs_auth'
        : auth === 'csv'
          ? (samePlatform && previous?.health) || 'manual'
          : isNew || credentials || urlChanged || !samePlatform
            ? 'checking'
            : previous?.health || 'checking';
    const record = { ...previous, ...data, id, health, lastSync: previous?.lastSync || null, createdAt: previous?.createdAt || Date.now() };

    try {
      await setStores((list) => (isNew ? [...list, record] : list.map((s) => (s.id === id ? record : s))));
      if (isWoo && (credentials || urlChanged || isNew)) {
        await callApi('stores/secrets', { storeId: id, url: record.url, ...(credentials || {}) }).catch((err) => {
          showToast({ tone: 'danger', title: 'Couldn’t save the API keys', body: callError(err) });
          throw err;
        });
      }
      if (clientId) await setClients((list) => list.map((c) => (c.id === clientId ? { ...c, storeIds: [...(c.storeIds || []), id] } : c)));
    } catch {
      return null;
    }

    // Typed keys (Shopify, Walmart, or an eBay store's own app keys) are checked and saved by the server.
    let mustAuthorize = authorize;
    if (!isWoo && credentials) {
      const result = await callApi('integrations/credentials', { storeId: id, input: credentials }).catch((err) => ({ ok: false, message: callError(err) }));
      if (!result.ok) {
        log(`Saved ${record.platform} store ${record.name} (keys rejected)`, 'integration');
        showToast({ tone: 'danger', title: `${record.platform} didn’t accept the keys`, body: `${result.message} The store is saved; edit it to try again.` });
        return id;
      }
      // New app keys need the seller to approve access again.
      if (auth === 'oauth' && !result.authorized) mustAuthorize = true;
    }

    log(`${isNew ? 'Connected' : 'Updated'} ${record.platform} store ${record.name}`, 'integration');
    if (auth === 'oauth' && mustAuthorize) {
      authorizeStore(record);
    } else if (auth === 'key' && (isNew || credentials || urlChanged || !samePlatform) && record.status === 'active') {
      resyncStore(record);
    } else {
      showToast({
        title: `${record.name} saved`,
        body:
          auth === 'oauth' && record.health !== 'connected'
            ? `Next: click Authorize to connect it to ${record.platform}.`
            : auth === 'csv'
              ? 'Next: import its orders and listings (CSV) from the store’s menu.'
              : undefined,
      });
    }
    return id;
  };

  const toggleStorePause = (store) => {
    const status = store.status === 'paused' ? 'active' : 'paused';
    setStores((list) => list.map((s) => (s.id === store.id ? { ...s, status } : s))).catch(() => {});
    log(`${status === 'paused' ? 'Paused' : 'Resumed'} syncing for ${store.name}`, 'integration');
    if (status === 'active') resyncStore({ ...store, status });
    else showToast({ title: `${store.name} paused`, body: 'Edits are saved and sent when you resume.' });
  };

  // Removes the webhooks and Digital Hub's copy of the data. Nothing is deleted in the store.
  const deleteStore = async (store) => {
    showToast({ pending: true, title: `Disconnecting ${store.name}…` });
    try {
      await callApi('stores/disconnect', { storeId: store.id });
      log(`Deleted integration ${store.name}`, 'integration');
      showToast({ title: `${store.name} disconnected` });
    } catch (err) {
      showToast({ tone: 'danger', title: 'Couldn’t disconnect', body: callError(err) });
    }
  };

  // ---- Clients -------------------------------------------------------------
  const saveClient = (input, isNew, accessDiff) => {
    const { sendInvite, ...data } = input;
    if (isNew) {
      const record = { ...data, id: uid('cl'), status: 'invited', createdAt: Date.now() };
      setClients((list) => [record, ...list]).catch(() => {});
      log(`Created client ${record.company} with access to ${record.storeIds.length} store(s)`, 'client');
      showToast({
        title: `${record.company} created`,
        body: 'Next: in Settings → Users & roles, add a user for them and link it to this client.',
      });
      return;
    }
    setClients((list) => list.map((c) => (c.id === data.id ? { ...c, ...data } : c))).catch(() => {});
    if (accessDiff) {
      log(`Changed store access for ${data.company} (+${accessDiff.added} / −${accessDiff.removed})`, 'client');
      showToast({
        title: 'Store access updated',
        body: `${data.company}: ${accessDiff.added} granted, ${accessDiff.removed} revoked. ${data.storeIds.length} store${data.storeIds.length === 1 ? '' : 's'} total.`,
      });
    } else {
      log(`Updated details for ${data.company}`, 'client');
      showToast({ title: 'Client saved', body: data.company });
    }
  };

  const deleteClient = (target) => {
    setClients((list) => list.filter((c) => c.id !== target.id)).catch(() => {});
    if (viewAs.client === target.id) setViewAs((v) => ({ ...v, client: '' }));
    log(`Deleted client ${target.company}`, 'client');
    showToast({ title: `${target.company} deleted` });
  };

  const setClientStatus = (target, status) => {
    setClients((list) => list.map((c) => (c.id === target.id ? { ...c, status } : c))).catch(() => {});
    log(`${status === 'suspended' ? 'Suspended' : 'Reactivated'} ${target.company}`, 'client');
    showToast({ title: status === 'suspended' ? `${target.company} suspended` : `${target.company} reactivated` });
  };

  const resendInvite = (target) =>
    showToast({ title: 'Share the sign-in details', body: `Give ${target.email} the temporary password you set in Settings → Users & roles.` });

  const viewAsClient = (clientId) => {
    setViewAs((v) => ({ ...v, client: clientId }));
    setRole('client');
  };

  // ---- Groups, settings, profile ---------------------------------------------
  // ---- Users & roles: what a client or manager login can see ------------------------

  /**
   * The client account a client login belongs to: its stores and permissions.
   * `id` empty → a new client account (contact details taken from the login).
   */
  const saveClientAccess = async ({ id, company, storeIds, permissions, contact = '', email = '' }) => {
    const existing = clients.find((c) => c.id === id);
    const record = existing
      ? { ...existing, storeIds, permissions }
      : { id: uid('cl'), company: company.trim(), contact, email, phone: '', status: 'active', storeIds, permissions, createdAt: Date.now() };
    await setClients((list) => (existing ? list.map((c) => (c.id === record.id ? record : c)) : [record, ...list]));
    log(`${existing ? 'Updated' : 'Created'} client ${record.company} with access to ${storeIds.length} store(s)`, 'client');
    return record;
  };

  /**
   * The store group a manager looks after and the stores in it. A store belongs to one
   * group, so ticking a store moves it here; unticking moves it back to another group.
   * `id` empty → a new group called `name`. Returns the group id.
   */
  const saveManagerGroup = async ({ id, name, storeIds }) => {
    const existing = groupRows.find((g) => g.id === id);
    const groupId = existing ? existing.id : uid('g');
    if (!existing) await setGroups((list) => [...list, { id: groupId, name: name.trim() }]);
    const fallback = (groupRows.find((g) => g.id === 'g_main' && g.id !== groupId) || groupRows.find((g) => g.id !== groupId))?.id;
    await setStores((list) =>
      list.map((s) => {
        if (storeIds.includes(s.id)) return s.groupId === groupId ? s : { ...s, groupId };
        if (s.groupId === groupId && fallback) return { ...s, groupId: fallback };
        return s;
      }),
    );
    log(`${existing ? 'Updated' : 'Created'} store group ${existing?.name || name.trim()} (${storeIds.length} store(s))`, 'settings');
    return groupId;
  };

  const saveGroup = (group, storeIdsInGroup, isNew) => {
    const id = isNew ? uid('g') : group.id;
    setGroups((list) => (isNew ? [...list, { ...group, id }] : list.map((g) => (g.id === id ? { ...g, ...group } : g)))).catch(() => {});
    // A group's stores are the stores whose groupId points at it.
    setStores((list) => list.map((s) => (storeIdsInGroup.includes(s.id) ? { ...s, groupId: id } : s))).catch(() => {});
    log(`${isNew ? 'Created' : 'Updated'} store group ${group.name}`, 'settings');
    showToast({ title: `Group “${group.name}” saved` });
  };

  const deleteGroup = (group) => {
    setGroups((list) => list.filter((g) => g.id !== group.id)).catch(() => {});
    log(`Deleted store group ${group.name}`, 'settings');
    showToast({ title: `Group “${group.name}” deleted` });
  };

  const updateSettings = (patch, message) => {
    updateSettingsDoc(patch).catch(() => {});
    if (message) {
      showToast({ title: message });
      log(message, 'settings');
    }
  };

  const updateProfile = async (next) => {
    if (isPreview && role === 'client' && client) {
      setClients((list) => list.map((c) => (c.id === client.id ? { ...c, contact: next.name, email: next.email, phone: next.phone } : c))).catch(() => {});
      return showToast({ title: 'Client contact saved', body: client.company });
    }
    if (isPreview) return showToast({ title: 'Switch back to the admin dashboard to edit your own profile' });
    try {
      const result = await updateOwnProfile(profile.id, { full_name: next.name, phone: next.phone, email: next.email });
      setProfile((p) => ({ ...p, full_name: next.name, phone: next.phone }));
      return showToast({
        title: 'Profile saved',
        body: result.emailPending ? `We sent a link to ${next.email}. Your sign-in email changes after you open it.` : undefined,
      });
    } catch (err) {
      return showToast({ tone: 'danger', title: 'Couldn’t save profile', body: authMessage(err) });
    }
  };

  // ---- Workspace data ----------------------------------------------------------
  const exportBackup = () => {
    const blob = workspaceToFile({ stores, groups, products, orders, customers: customerRecords, clients, settings, activity, notifications });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `digital-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast({ title: 'Backup downloaded' });
  };

  // `data` comes from readBackupFile.
  const importBackup = async (data) => {
    showToast({ pending: true, title: 'Restoring backup…' });
    try {
      const count = await restoreBackup(data);
      log(`Restored a backup (${count} records)`, 'settings');
      showToast({ title: 'Backup restored', body: `${count} records written.` });
    } catch (err) {
      showToast({ tone: 'danger', title: 'Couldn’t restore backup', body: err.message });
    }
  };

  const hasSampleData = stores.some((s) => s.sample);

  const loadSampleData = async () => {
    showToast({ pending: true, title: 'Adding sample stores…' });
    try {
      await seedSampleData();
      log('Added the sample stores', 'settings');
      showToast({ title: 'Sample stores added', body: 'They’re marked as samples and never contact a real store.' });
    } catch (err) {
      showToast({ tone: 'danger', title: 'Couldn’t add sample data', body: err.message });
    }
  };

  const removeSampleData = async () => {
    showToast({ pending: true, title: 'Removing sample stores…' });
    try {
      await clearSampleData();
      log('Removed the sample stores', 'settings');
      showToast({ title: 'Sample stores removed' });
    } catch (err) {
      showToast({ tone: 'danger', title: 'Couldn’t remove sample data', body: err.message });
    }
  };

  const signOut = async () => {
    await authSignOut();
    window.location.assign('/signin?message=signed-out');
  };

  const value = {
    // identity
    profile, realRole, isAdmin, isPreview,
    role, setRole, viewAs, setViewAs, user, client, access, signOut,
    // records
    stores, groups, scopedStores, storeIds, selectedStores, setSelectedStores, storeOf, customerOf,
    products, orders, customers, clients, team, users, settings, activity, notifications, sessions, setSessions,
    // navigation & ui
    page, settingsTab, go, mainRef, search, setSearch, q: search.trim().toLowerCase(), period, setPeriod,
    dark, themePref, setThemePref, toggleTheme, money,
    syncing, syncingStores, toast, showToast, dismissToast, log, markAllRead,
    confirmDialog, askConfirm, closeConfirm, drawer, openDrawer, closeDrawer,
    // actions
    saveProduct, deleteProduct, updateOrderStatus,
    resyncStore, testConnection, saveStore, authorizeStore, reauthorizeStore: authorizeStore, importStoreCsv, setStoreClients, toggleStorePause, deleteStore,
    saveClient, deleteClient, setClientStatus, resendInvite, viewAsClient,
    saveGroup, deleteGroup, updateSettings, updateProfile, saveClientAccess, saveManagerGroup,
    exportBackup, importBackup, hasSampleData, loadSampleData, removeSampleData,
    isOAuthPlatform, PLATFORMS,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
