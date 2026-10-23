import { useEffect, useRef, useState } from 'react';
import { Building2, CircleCheck, FileUp, Pause, Pencil, Play, Plug, Plus, RefreshCw, Shield, Trash2, TriangleAlert } from 'lucide-react';
import ActionMenu from '../../components/ui/ActionMenu';
import { Badge, StoreBadge } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import { Card, StatCard } from '../../components/ui/Card';
import DataTable from '../../components/ui/DataTable';
import PageHeader from '../../components/ui/PageHeader';
import Select from '../../components/ui/Select';
import { useApp } from '../../context/AppContext';
import { isCsvPlatform, isOAuthPlatform, PLATFORM_NAMES } from '../../data/platforms';
import { timeAgo } from '../../lib/format';
import { ui } from '../../styles/ui';
import { storeAddress } from '../clients/StorePicker';
import Modal from '../../components/ui/Modal';
import CsvImport from './CsvImport';
import IntegrationModal from './IntegrationModal';
import StoreClientsModal from './StoreClientsModal';

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
                <span title={s.lastError || (s.authExpiresAt ? `Authorization valid until ${new Date(s.authExpiresAt).toLocaleDateString()}` : '')}>
                  <Badge status={s.status === 'paused' ? 'paused' : syncingStores[s.id] ? 'checking' : s.health} />
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
