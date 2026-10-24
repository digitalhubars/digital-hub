import { useEffect, useRef, useState } from 'react';
import { Building2, CircleCheck, FileUp, Lock, Pause, Pencil, Play, Plug, Plus, Radio, RefreshCw, Shield, Trash2, TriangleAlert } from 'lucide-react';
import ActionMenu from '../../components/ui/ActionMenu';
import { Badge, StoreBadge } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import { Card, StatCard } from '../../components/ui/Card';
import DataTable from '../../components/ui/DataTable';
import PageHeader from '../../components/ui/PageHeader';
import Select from '../../components/ui/Select';
import { useApp } from '../../context/AppContext';
import { isCsvPlatform, isOAuthPlatform, PLATFORM_NAMES, PLATFORMS } from '../../data/platforms';
import { timeAgo } from '../../lib/format';
import { ui } from '../../styles/ui';
import { storeAddress } from '../clients/StorePicker';
import Modal from '../../components/ui/Modal';
import CsvImport from './CsvImport';
import IntegrationModal from './IntegrationModal';
import StoreClientsModal from './StoreClientsModal';

// The big "Connect a store" buttons. Each opens the Add integration window for that platform.
const FEATURED = ['TikTok Shop', 'Shopify', 'Etsy', 'eBay'];

const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * "Connect a store": each button opens the platform's official sign-in in a pop-up (no keys
 * to paste; the app's keys are on the server). Shopify first asks which store to connect.
 */
function ConnectPanel({ stores, onMore }) {
  const { connectStore } = useApp();
  const [shopifyOpen, setShopifyOpen] = useState(false);
  const [shop, setShop] = useState('');
  const [shopError, setShopError] = useState('');
  const [busy, setBusy] = useState('');

  const start = (platform, extra = {}) => {
    setBusy(platform);
    connectStore({ platform, ...extra }).then((result) => {
      setBusy('');
      if (result.status === 'connected' && platform === 'Shopify') {
        setShopifyOpen(false);
        setShop('');
      }
    });
  };

  const continueShopify = (e) => {
    e.preventDefault();
    const domain = shop.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const full = domain.includes('.') ? domain : `${domain}.myshopify.com`;
    if (!SHOPIFY_DOMAIN.test(full)) return setShopError('Enter the store’s myshopify.com address, e.g. your-store.myshopify.com.');
    setShopError('');
    return start('Shopify', { shop: full });
  };

  return (
    <Card
      title="Connect a store"
      action={
        <span className={`flex items-center gap-1 text-xs ${ui.muted}`}>
          <Lock size={12} /> Official sign-in · nothing to paste · tokens stored encrypted
        </span>
      }
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
        {FEATURED.map((name) => {
          const p = PLATFORMS[name];
          const count = stores.filter((s) => s.platform === name && !s.sample).length;
          const isShopify = name === 'Shopify';
          return (
            <div key={name} className="flex flex-col rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="flex items-center justify-between gap-2">
                <StoreBadge store={{ platform: name, name: '' }} showStore={false} />
                {count > 0 && <span className={`text-xs ${ui.muted}`}>{count} connected</span>}
              </div>
              <p className={`mt-3 flex-1 text-xs ${ui.muted}`}>
                {p.scopes?.join(' · ')}. {p.live === 'webhooks' ? 'Live updates as they happen.' : 'Synced automatically every 15 minutes.'}
              </p>
              {isShopify && shopifyOpen ? (
                <form onSubmit={continueShopify} className="mt-3 space-y-2">
                  <input
                    autoFocus
                    className={ui.input}
                    value={shop}
                    onChange={(e) => setShop(e.target.value)}
                    placeholder="your-store.myshopify.com"
                    aria-label="Shopify store address"
                  />
                  {shopError && <p className="text-xs text-red-700 dark:text-red-400">{shopError}</p>}
                  <div className="flex gap-2">
                    <Button type="button" className="flex-1 justify-center" onClick={() => setShopifyOpen(false)}>
                      Cancel
                    </Button>
                    <button type="submit" disabled={busy === name} className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${p.button}`}>
                      Continue
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  disabled={busy === name}
                  onClick={() => (isShopify ? setShopifyOpen(true) : start(name))}
                  className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60 ${p.button}`}
                >
                  <Shield size={14} /> {busy === name ? 'Waiting for sign-in…' : p.connectLabel}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className={`flex flex-wrap items-center gap-2 border-t px-4 py-3 text-xs sm:px-5 ${ui.line} ${ui.muted}`}>
        Also:{' '}
        {PLATFORM_NAMES.filter((n) => !FEATURED.includes(n)).map((n, i, list) => (
          <button key={n} type="button" onClick={() => onMore(n)} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
            {n}
            {i < list.length - 1 ? ',' : ''}
          </button>
        ))}
      </div>
    </Card>
  );
}

export default function IntegrationsPage() {
  const { stores, groups, clients, resyncStore, syncingStores, toggleStorePause, deleteStore, reauthorizeStore, askConfirm, settings, q, showToast } = useApp();
  const [editing, setEditing] = useState(null);
  const [importFor, setImportFor] = useState(null);

  // Back from a marketplace sign-in: /admin/integrations?connected=<store> or ?authError=…
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const authError = params.get('authError');
    if (!connected && !authError) {
      handledReturn.current = true;
      return;
    }
    const store = stores.find((s) => s.id === (connected || params.get('store')));
    if (connected && !store) return; // wait for the stores to load
    handledReturn.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (authError) showToast({ tone: 'danger', title: 'Authorization didn’t finish', body: authError });
    else {
      showToast({ title: `${store.name} is authorized`, body: 'Importing products and orders now.' });
      resyncStore({ ...store, health: 'connected' });
    }
  }, [stores, showToast, resyncStore]);
  const [clientsFor, setClientsFor] = useState(null);
  const [platformFilter, setPlatformFilter] = useState('all');

  const rows = stores.filter(
    (s) => (platformFilter === 'all' || s.platform === platformFilter) && (!q || [s.name, s.url, s.accountId || ''].some((v) => v.toLowerCase().includes(q))),
  );
  const groupName = (id) => groups.find((g) => g.id === id)?.name || '—';
  const clientsOf = (storeId) => clients.filter((c) => c.storeIds.includes(storeId));
  const active = stores.filter((s) => s.status === 'active');
  const platformsInUse = PLATFORM_NAMES.filter((p) => stores.some((s) => s.platform === p));

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Integrations"
        description={`Store and marketplace connections. Default sync: every ${settings.syncFrequency === 'manual' ? 'manual' : `${settings.syncFrequency} minutes`}.`}
        actions={
          <Button variant="primary" onClick={() => setEditing({})}>
            <Plus size={15} /> Add integration
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Connected" value={active.filter((s) => s.health === 'connected').length} icon={CircleCheck} />
        <StatCard
          label="Needs attention"
          value={active.filter((s) => s.health !== 'connected').length}
          hint="Errors, expired or missing authorization"
          icon={TriangleAlert}
          tone={active.some((s) => s.health !== 'connected') ? 'warning' : undefined}
        />
        <StatCard label="Paused" value={stores.filter((s) => s.status === 'paused').length} icon={Pause} />
        <StatCard label="Platforms" value={platformsInUse.length} hint={platformsInUse.join(', ')} icon={Plug} />
      </div>

      <ConnectPanel stores={stores} onMore={(platform) => setEditing({ platform })} />

      <Card
        title={`${rows.length} store${rows.length === 1 ? '' : 's'}`}
        action={
          <Select
            value={platformFilter}
            onChange={setPlatformFilter}
            className="w-full sm:w-44"
            options={[{ value: 'all', label: 'All platforms' }, ...PLATFORM_NAMES.map((p) => ({ value: p, label: p }))]}
          />
        }
      >
        <DataTable
          rows={rows}
          empty="No integrations for this platform yet."
          columns={[
            {
              key: 'name',
              label: 'Store',
              primary: true,
              render: (s) => (
                <div className="min-w-0">
                  <p className={`truncate font-medium ${ui.h}`}>{s.name}</p>
                  <p className={`truncate text-xs font-normal ${ui.muted}`}>{storeAddress(s)}</p>
                </div>
              ),
            },
            { key: 'platform', label: 'Platform', render: (s) => <StoreBadge store={s} showStore={false} /> },
            { key: 'group', label: 'Group', render: (s) => groupName(s.groupId) },
            {
              key: 'clients',
              label: 'Client access',
              render: (s) => {
                const list = clientsOf(s.id);
                const open = (e) => {
                  e.stopPropagation();
                  setClientsFor(s);
                };
                if (!list.length) {
                  return (
                    <button type="button" onClick={open} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                      + Assign client
                    </button>
                  );
                }
                return (
                  <button type="button" onClick={open} className="flex max-w-[14rem] flex-wrap gap-1 text-left" title="Change client access">
                    {list.slice(0, 2).map((c) => (
                      <span
                        key={c.id}
                        className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                      >
                        <Building2 size={11} className="shrink-0" /> <span className="truncate">{c.company}</span>
                      </span>
                    ))}
                    {list.length > 2 && <span className={`text-xs ${ui.muted}`}>+{list.length - 2}</span>}
                  </button>
                );
              },
            },
            { key: 'sync', label: 'Last sync', render: (s) => <span className="whitespace-nowrap">{timeAgo(s.lastSync)}</span> },
            {
              key: 'status',
              label: 'Status',
              aside: true,
              render: (s) => (
                <span className="inline-flex items-center gap-2" title={s.lastError || (s.authExpiresAt ? `Authorization valid until ${new Date(s.authExpiresAt).toLocaleDateString()}` : '')}>
                  <Badge status={s.status === 'paused' ? 'paused' : syncingStores[s.id] ? 'checking' : s.health} />
                  {s.webhooks === 'active' && s.status === 'active' && (
                    <span className="inline-flex items-center gap-1 text-xs text-teal-700 dark:text-teal-300" title="Changes arrive in real time (webhooks)">
                      <Radio size={12} /> Live
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              actions: true,
              render: (s) => (
                <div className="flex items-center justify-end gap-1">
                  {s.status === 'active' && isOAuthPlatform(s.platform) && ['needs_auth', 'expired', 'expiring'].includes(s.health) ? (
                    <Button size="sm" className="whitespace-nowrap" onClick={() => reauthorizeStore(s)}>
                      <Shield size={12} /> {s.health === 'needs_auth' ? 'Authorize' : 'Re-authorize'}
                    </Button>
                  ) : s.status === 'active' && s.health === 'needs_auth' && !s.sample ? (
                    <Button size="sm" className="whitespace-nowrap" onClick={() => setEditing(s)}>
                      <Pencil size={12} /> Add keys
                    </Button>
                  ) : isCsvPlatform(s.platform) ? (
                    <Button size="sm" className="whitespace-nowrap" onClick={() => setImportFor(s)}>
                      <FileUp size={12} /> Import CSV
                    </Button>
                  ) : (
                    s.status === 'active' && (
                      <Button size="sm" onClick={() => resyncStore(s)} disabled={syncingStores[s.id]}>
                        <RefreshCw size={12} className={syncingStores[s.id] ? 'animate-spin' : ''} /> Sync
                      </Button>
                    )
                  )}
                  <ActionMenu
                    items={[
                      { label: 'Edit', icon: Pencil, onClick: () => setEditing(s) },
                      { label: 'Client access', icon: Building2, onClick: () => setClientsFor(s) },
                      { label: 'Re-authorize', icon: Shield, onClick: () => reauthorizeStore(s), hidden: !isOAuthPlatform(s.platform) || s.sample },
                      { label: 'Import CSV', icon: FileUp, onClick: () => setImportFor(s), hidden: !isCsvPlatform(s.platform) },
                      { label: 'Pause syncing', icon: Pause, onClick: () => toggleStorePause(s), hidden: s.status === 'paused' },
                      { label: 'Resume syncing', icon: Play, onClick: () => toggleStorePause(s), hidden: s.status !== 'paused' },
                      {
                        label: 'Disconnect',
                        icon: Trash2,
                        danger: true,
                        onClick: () =>
                          askConfirm({
                            title: `Disconnect ${s.name}?`,
                            body: `This deletes the saved ${isOAuthPlatform(s.platform) ? 'authorization' : 'keys'} and removes the store's synced products, orders and customers from Digital Hub. Nothing is deleted on ${s.platform} itself.`,
                            confirmLabel: 'Disconnect',
                            onConfirm: () => deleteStore(s),
                          }),
                      },
                    ]}
                  />
                </div>
              ),
            },
          ]}
        />
      </Card>

      {editing && <IntegrationModal store={editing} onClose={() => setEditing(null)} />}
      {clientsFor && <StoreClientsModal store={clientsFor} onClose={() => setClientsFor(null)} />}
      {importFor && (
        <Modal title={`Import into ${importFor.name}`} subtitle={<StoreBadge store={importFor} api showStore={false} />} size="lg" onClose={() => setImportFor(null)}>
          <CsvImport store={importFor} />
        </Modal>
      )}
    </div>
  );
}
