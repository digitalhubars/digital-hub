import { Card } from '../../../components/ui/Card';
import Callout from '../../../components/ui/Callout';
import Field from '../../../components/ui/Field';
import { useApp } from '../../../context/AppContext';
import { ui } from '../../../styles/ui';
import CopyField from '../CopyField';

// The app's own API routes (src/app/api/woo/webhook, src/app/api/webhooks/*).
const origin = () => (typeof window === 'undefined' ? '' : window.location.origin);
const wooUrl = (storeId) => `${origin()}/api/woo/webhook?store=${encodeURIComponent(storeId)}`;

const liveHint = (s) =>
  s.webhooks === 'active'
    ? 'Live: changes arrive as they happen.'
    : s.webhooks === 'local'
      ? 'Running locally: live updates are switched on after deploying.'
      : s.webhooks === 'polling'
        ? 'Synced on a schedule (see the store’s last error for why live updates are off).'
        : 'Not set up yet. Sync the store once.';

// Real-time updates per platform. WooCommerce and Shopify are set up automatically on the
// first sync; TikTok Shop's address is entered once in Partner Center; eBay, Etsy, Walmart
// and Amazon are synced in the background every 15 minutes.
export default function ApiTab() {
  const { stores } = useApp();
  const real = stores.filter((s) => !s.sample);
  const woo = real.filter((s) => s.platform === 'WooCommerce');
  const shopify = real.filter((s) => s.platform === 'Shopify');
  const tiktok = real.filter((s) => s.platform === 'TikTok Shop');

  return (
    <div className="space-y-4">
      <Card title="Live updates (webhooks)">
        <div className="space-y-4 p-4 sm:p-5">
          <p className={`text-sm ${ui.muted}`}>
            WooCommerce and Shopify stores get their webhooks automatically on the first sync. Each delivery is signed and checked. eBay, Etsy, Walmart and
            Amazon don’t offer usable webhooks, so Digital Hub syncs them in the background every 15 minutes.
          </p>
          {!woo.length && !shopify.length && !tiktok.length && <Callout tone="info">No stores with live updates yet.</Callout>}
          {woo.map((s) => (
            <Field key={s.id} label={`${s.name} · WooCommerce`} hint={liveHint(s)}>
              <CopyField value={wooUrl(s.id)} />
            </Field>
          ))}
          {shopify.map((s) => (
            <Field key={s.id} label={`${s.name} · Shopify`} hint={liveHint(s)}>
              <CopyField value={`${origin()}/api/webhooks/shopify?store=${encodeURIComponent(s.id)}`} />
            </Field>
          ))}
        </div>
      </Card>

      {tiktok.length > 0 && (
        <Card title="TikTok Shop">
          <div className="space-y-3 p-4 sm:p-5">
            <p className={`text-sm ${ui.muted}`}>
              In TikTok Shop Partner Center → App &amp; Service → your app → Webhooks, set this address once and subscribe to order and product events.
              Deliveries are checked with the app’s secret.
            </p>
            <CopyField value={`${origin()}/api/webhooks/tiktok`} />
          </div>
        </Card>
      )}
    </div>
  );
}
