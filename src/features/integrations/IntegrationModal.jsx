import { useState } from 'react';
import { CircleCheck, FileUp, KeyRound, RefreshCw, Shield, TriangleAlert, Zap } from 'lucide-react';
import { Badge, StoreBadge } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Callout from '../../components/ui/Callout';
import Field from '../../components/ui/Field';
import Modal from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import { useApp } from '../../context/AppContext';
import { PLATFORM_NAMES, PLATFORMS } from '../../data/platforms';
import { ui } from '../../styles/ui';
import CsvImport from './CsvImport';

const MARKET_GROUP = 'g_market';
const emptyFields = (platform) =>
  Object.fromEntries([...(PLATFORMS[platform].fields || []), ...(PLATFORMS[platform].tokenFields || [])].map((f) => [f.key, '']));

export default function IntegrationModal({ store, onClose }) {
  const { groups, clients, saveStore, testConnection, authorizeStore, connectStore } = useApp();
  const isNew = !store.id;
  const [form, setForm] = useState({
    platform: store.platform || 'Shopify',
    name: store.name || '',
    url: store.url || '',
    consumerKey: '',
    consumerSecret: '',
    keys: emptyFields(store.platform || 'Shopify'),
    groupId: store.groupId || groups[0]?.id || '',
    syncFrequency: store.syncFrequency || 'default',
    status: store.status || 'active',
    region: store.region || '',
    clientId: '',
    // Shopify: 'signin' (OAuth with the store's app) or 'token' (Admin API access token)
    method: 'signin',
  });
  const [errors, setErrors] = useState({});
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);

  const platform = PLATFORMS[form.platform];
  const auth = platform.auth;
  const isWoo = form.platform === 'WooCommerce';
  const platformChanged = !isNew && form.platform !== store.platform;
  const authorized = !isNew && !platformChanged && ['connected', 'expiring', 'checking', 'error', 'slow'].includes(store.health);
  // Keys must be typed for a new store, a changed platform, or a key store whose keys were rejected.
  const needsCredentials = isNew || platformChanged || (auth === 'key' && store.health === 'needs_auth');
  const useToken = !!platform.tokenFields && form.method === 'token';
  const fields = useToken ? platform.tokenFields : platform.fields || [];
  const hasFields = !isWoo && fields.length > 0;
  const region = form.region || platform.regions?.[0] || '';
  const bind = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const bindKey = (key) => (e) => setForm((f) => ({ ...f, keys: { ...f.keys, [key]: e.target.value } }));
  const typedKeys = fields.some((f) => form.keys[f.key]?.trim());
  const typed = () => Object.fromEntries(fields.map((f) => [f.key, (form.keys[f.key] || '').trim()]));

  // New marketplace stores default to the Marketplaces group (if there is one).
  const changePlatform = (next) => {
    const market = groups.find((g) => g.id === MARKET_GROUP);
    setForm((f) => ({
      ...f,
      platform: next,
      region: PLATFORMS[next].regions?.[0] || '',
      keys: emptyFields(next),
      groupId: isNew && market ? (PLATFORMS[next].auth === 'oauth' ? market.id : f.groupId === market.id ? groups[0].id : f.groupId) : f.groupId,
    }));
    setTest(null);
    setErrors({});
  };

  const validate = () => {
    const next = {};
    if (!form.name.trim() && !(auth === 'oauth' && !useToken)) next.name = 'Store name is required.';
    if (isWoo) {
      if (!/^https:\/\/[^\s.]+\.[^\s]+$/i.test(form.url)) next.url = 'Use the full https:// address of the WordPress site.';
      if (needsCredentials && form.consumerKey.length < 8) next.consumerKey = 'Paste the consumer key.';
      if (needsCredentials && form.consumerSecret.length < 8) next.consumerSecret = 'Paste the consumer secret.';
    } else if (hasFields && (needsCredentials || typedKeys)) {
      fields.forEach((f) => {
        if (!f.optional && !form.keys[f.key]?.trim()) next[f.key] = `Enter the ${f.label.toLowerCase()}.`;
      });
    }
    setErrors(next);
    return !Object.keys(next).length;
  };

  const runTest = async () => {
    if (!validate()) return;
    setTest({ state: 'checking' });
    let input;
    if (isWoo && form.consumerKey) input = { url: form.url.trim().replace(/\/$/, ''), consumerKey: form.consumerKey.trim(), consumerSecret: form.consumerSecret.trim() };
    if (hasFields && typedKeys) input = typed();
    const result = await testConnection({ platform: form.platform, storeId: platformChanged ? undefined : store.id, input });
    setTest({ state: result.ok ? 'ok' : 'fail', message: result.message });
  };

  const submit = async (e, { authorize = false } = {}) => {
    e?.preventDefault();
    if (!validate()) return;
    setBusy(true);
    const base = { ...store, platform: form.platform, name: form.name.trim(), groupId: form.groupId, syncFrequency: form.syncFrequency, status: form.status };

    if (isWoo) {
      const credentials = form.consumerKey ? { consumerKey: form.consumerKey.trim(), consumerSecret: form.consumerSecret.trim() } : undefined;
      const { accountId: _a, region: _r, ...rest } = base;
      await saveStore(
        { ...rest, url: form.url.trim().replace(/\/$/, ''), keyHint: credentials ? `ck_••••${credentials.consumerKey.slice(-4)}` : store.keyHint },
        isNew,
        form.clientId,
        credentials,
      );
    } else if (auth === 'key') {
      const keys = typedKeys ? typed() : undefined;
      const secretField = fields.find((f) => f.secret);
      const domain = keys?.domain?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      // Etsy: "YourShop", "etsy.com/shop/YourShop" or "yourshop.etsy.com" → etsy.com/shop/YourShop
      const etsyShop = keys?.shop?.replace(/^.*\/shop\//, '').replace(/^(?:https?:\/\/)?([^./]+)\.etsy\.com.*$/, '$1').replace(/[/?#].*$/, '');
      await saveStore(
        {
          ...base,
          url:
            domain ||
            (etsyShop && !/^\d+$/.test(etsyShop) ? `etsy.com/shop/${etsyShop}` : '') ||
            (platformChanged ? '' : store.url) ||
            ({ Walmart: 'seller.walmart.com', Etsy: 'etsy.com' }[form.platform] || ''),
          keyHint: keys ? `••••${keys[secretField.key].slice(-4)}` : store.keyHint,
        },
        isNew,
        form.clientId,
        keys,
      );
    } else if (auth === 'oauth' && useToken) {
      // Shopify "Use an access token": checked and saved by the server, connects right away.
      const keys = typedKeys ? typed() : undefined;
      const domain = keys?.domain?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      await saveStore({ ...base, region, ...(domain ? { url: domain } : {}), keyHint: keys ? 'Admin API token' : store.keyHint }, isNew, form.clientId, keys);
    } else if (auth === 'oauth') {
      // "Sign in with …": the pop-up opens right here in the click (so it isn't blocked).
      const domain = typedKeys ? typed().domain?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : undefined;
      if (isNew && typedKeys) {
        // Save the store with its app keys (checked by the platform), then the seller approves once.
        connectStore({
          platform: form.platform,
          prepare: async () => {
            const saved = await saveStore(
              { ...base, region, keyHint: 'App keys saved · approval needed' },
              true,
              form.clientId,
              typed(),
              { approvalNext: true },
            );
            return saved ? { storeId: saved.id } : { done: { status: 'blocked' } };
          },
        });
      } else if (isNew) {
        // The store is created once the seller approves; closing the pop-up leaves nothing behind.
        connectStore({
          platform: form.platform,
          shop: domain,
          meta: { name: form.name.trim(), groupId: form.groupId, region, syncFrequency: form.syncFrequency, status: form.status, clientId: form.clientId },
        });
      } else if (typedKeys) {
        // New app keys: save the store and keys first (checked by the platform), then approve once.
        connectStore({
          platform: form.platform,
          storeId: store.id,
          prepare: async () => {
            const saved = await saveStore({ ...base, region }, false, '', typed(), { approvalNext: true });
            if (!saved) return { done: { status: 'blocked' } };
            return saved.authorized && !authorize ? { done: { status: 'connected', message: 'App keys updated.' } } : { storeId: store.id };
          },
        });
      } else if (authorize || !authorized || platformChanged || (domain && domain !== store.url)) {
        connectStore({
          platform: form.platform,
          storeId: store.id,
          shop: domain || store.url,
          prepare: () => saveStore({ ...base, region, ...(domain ? { url: domain } : {}) }, false, ''),
        });
      } else {
        await saveStore({ ...base, region }, false, '');
      }
    } else {
      await saveStore({ ...base, url: store.url || 'mercari.com', keyHint: 'CSV import' }, isNew, form.clientId);
    }
    setBusy(false);
    onClose();
  };

  const primaryLabel = auth === 'oauth' && !authorized && !useToken ? platform.connectLabel || 'Save & authorize' : isNew ? 'Connect store' : 'Save changes';

  return (
    <Modal
      title={isNew ? 'Add integration' : `Edit ${store.name}`}
      subtitle={!isNew && <StoreBadge store={{ ...store, platform: form.platform }} api showStore={false} />}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {auth !== 'csv' && (auth !== 'oauth' || authorized) && (
            <Button className="mr-auto" onClick={runTest}>
              <Zap size={15} /> Test connection
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="integration-form" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : primaryLabel}
          </Button>
        </>
      }
    >
      <form id="integration-form" onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Platform"
            hint={
              auth === 'oauth'
                ? 'Connects with the seller’s login (OAuth).'
                : auth === 'csv'
                  ? 'No public API: orders and listings come from CSV files.'
                  : 'Connects with API keys from the store admin.'
            }
          >
            <Select value={form.platform} onChange={changePlatform} options={PLATFORM_NAMES.map((p) => ({ value: p, label: p }))} />
          </Field>
          <Field label="Store name" error={errors.name}>
            <input className={ui.input} value={form.name} onChange={bind('name')} placeholder={auth === 'oauth' && !useToken ? 'Optional: the shop’s own name is used' : 'e.g. Harbor Coffee Co.'} />
          </Field>
        </div>

        <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <p className={`mb-3 flex items-center gap-2 text-sm font-medium ${ui.h}`}>
            {auth === 'oauth' ? <Shield size={15} /> : auth === 'csv' ? <FileUp size={15} /> : <KeyRound size={15} />}{' '}
            {auth === 'oauth' ? 'Seller authorization' : auth === 'csv' ? 'CSV import' : 'API credentials'}
          </p>

          {isWoo && (
            <div className="space-y-4">
              <Field label="Site URL" error={errors.url}>
                <input className={ui.input} value={form.url} onChange={bind('url')} placeholder="https://your-store.com" />
              </Field>
              {!needsCredentials && (
                <p className={`text-xs ${ui.muted}`}>
                  Current key: <span className="font-mono">{store.keyHint}</span>. Leave empty to keep it.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Consumer key" error={errors.consumerKey}>
                  <input type="password" autoComplete="off" className={`${ui.input} font-mono`} value={form.consumerKey} onChange={bind('consumerKey')} placeholder="ck_…" />
                </Field>
                <Field label="Consumer secret" error={errors.consumerSecret}>
                  <input type="password" autoComplete="off" className={`${ui.input} font-mono`} value={form.consumerSecret} onChange={bind('consumerSecret')} placeholder="cs_…" />
                </Field>
                <p className={`text-xs sm:col-span-2 ${ui.muted}`}>WooCommerce → Settings → Advanced → REST API. Choose Read/Write permission.</p>
              </div>
            </div>
          )}

          {platform.tokenFields && (
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 text-sm dark:bg-gray-800">
              {[
                ['signin', platform.keysLabel || 'App credentials'],
                ['token', 'Use an access token'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, method: value }))}
                  className={`rounded-md px-3 py-1.5 font-medium ${form.method === value ? `bg-white shadow-sm dark:bg-gray-900 ${ui.h}` : ui.muted}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {hasFields && (
            <div className={`space-y-4 ${auth === 'oauth' ? 'mb-4 border-b pb-4 dark:border-gray-800' : ''}`}>
              {!needsCredentials && (
                <p className={`text-xs ${ui.muted}`}>
                  {auth === 'oauth' ? 'App keys are saved.' : <>Current key: <span className="font-mono">{store.keyHint}</span>.</>} Leave the fields empty to keep them.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((f) => (
                  <Field key={f.key} label={f.label} error={errors[f.key]} hint={f.hint} className={f.hint ? 'sm:col-span-2' : ''}>
                    <input
                      type={f.secret ? 'password' : 'text'}
                      autoComplete="off"
                      className={`${ui.input} ${f.secret ? 'font-mono' : ''}`}
                      value={form.keys[f.key]}
                      onChange={bindKey(f.key)}
                      placeholder={f.placeholder}
                    />
                    {f.callback && (
                      <p className={`mt-1 break-all font-mono text-xs ${ui.h}`}>{`${typeof window === 'undefined' ? '' : window.location.origin}/api/integrations/callback/${f.callback}`}</p>
                    )}
                  </Field>
                ))}
              </div>
              <p className={`text-xs ${ui.muted}`}>
                The keys are checked with {form.platform} and saved encrypted on the server.
                {auth === 'key'
                  ? platform.twoWay === 'orders'
                    ? ' Products and orders sync in; order changes made here (fulfil, cancel, delete) are sent back.'
                    : ' Products and orders sync in; edits made here aren’t sent back yet.'
                  : ''}
              </p>
            </div>
          )}

          {auth === 'oauth' && !useToken && (
            <div className="space-y-4">
              {platform.regions && (
                <Field label="Region">
                  <Select value={region} onChange={(v) => setForm((f) => ({ ...f, region: v }))} options={platform.regions.map((r) => ({ value: r, label: r }))} />
                </Field>
              )}
              {!isNew && !platformChanged && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge status={store.health} />
                  <span className={`text-sm ${ui.muted}`}>{store.keyHint}</span>
                </div>
              )}
              <p className={`text-sm ${ui.body}`}>
                {authorized
                  ? `Already connected. Re-authorize if you changed accounts or ${form.platform} asks you to sign in again.`
                  : `A pop-up opens ${platform.portal}’s official sign-in. Sign in (or just approve, if you’re already signed in), and the first sync starts.`}
              </p>
              {platform.scopes && <p className={`text-xs ${ui.muted}`}>Access requested: {platform.scopes.join(' · ')}.</p>}
              {authorized && (
                <Button className={platform.button} onClick={() => authorizeStore(store)}>
                  <Shield size={15} /> Re-authorize
                </Button>
              )}
            </div>
          )}

          {auth === 'csv' &&
            (isNew || platformChanged ? (
              <Callout icon={FileUp} tone="info">
                {form.platform} has no public seller API. Save the store, then import your orders and listings as CSV files (from this window or the store’s menu).
                Importing the same file again updates rows instead of adding duplicates.
              </Callout>
            ) : (
              <CsvImport store={store} />
            ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Store group">
            <Select value={form.groupId} onChange={(v) => setForm((f) => ({ ...f, groupId: v }))} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
          </Field>
          <Field label="Sync every">
            <Select
              value={form.syncFrequency}
              onChange={(v) => setForm((f) => ({ ...f, syncFrequency: v }))}
              options={[
                { value: 'default', label: 'Workspace default' },
                { value: '5', label: '5 minutes' },
                { value: '15', label: '15 minutes' },
                { value: '60', label: 'Hour' },
                { value: 'manual', label: 'Manual only' },
              ]}
            />
          </Field>
          <Field label="Status">
            <Select
              value={form.status}
              onChange={(v) => setForm((f) => ({ ...f, status: v }))}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
              ]}
            />
          </Field>
        </div>

        {isNew && (
          <Field label="Give a client access (optional)" hint="You can change this any time on the Clients page.">
            <Select
              value={form.clientId}
              onChange={(v) => setForm((f) => ({ ...f, clientId: v }))}
              options={[{ value: '', label: 'No client yet' }, ...clients.map((c) => ({ value: c.id, label: c.company }))]}
            />
          </Field>
        )}

        {test?.state === 'checking' && (
          <Callout icon={RefreshCw} tone="info">
            Checking…
          </Callout>
        )}
        {test?.state === 'ok' && (
          <Callout icon={CircleCheck} tone="success">
            {test.message}
          </Callout>
        )}
        {test?.state === 'fail' && (
          <Callout icon={TriangleAlert} tone="danger">
            {test.message}
          </Callout>
        )}
      </form>
    </Modal>
  );
}
