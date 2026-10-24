import { Building2, DollarSign, FileDown, Radio, Receipt, TriangleAlert } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Card, StatCard } from '../../components/ui/Card';
import DataTable from '../../components/ui/DataTable';
import LinkButton from '../../components/ui/LinkButton';
import PeriodSelect from '../../components/ui/PeriodSelect';
import { useApp } from '../../context/AppContext';
import { formatDate } from '../../lib/format';
import { downloadPdf } from '../../lib/pdf';
import { STATUS, ui } from '../../styles/ui';
import { orderColumns } from '../orders/orderColumns';
import SalesChart from './SalesChart';

// Pieces every dashboard uses.

/** Orders, sales, refunds and shipping per platform for the chosen period (all stores in one place). */
export function ChannelsCard({ data }) {
  const { storeOf, money } = useApp();
  const rows = new Map();
  data.inPeriod.forEach((o) => {
    const platform = storeOf(o.storeId)?.platform || 'Other';
    const row = rows.get(platform) || { platform, orders: 0, sales: 0, refunds: 0, toShip: 0 };
    const counted = o.status !== 'refunded' && o.status !== 'cancelled';
    if (counted) {
      row.orders += 1;
      row.sales += Number(o.total) || 0;
    }
    row.refunds += Number(o.refunded) || 0;
    if (counted && o.status === 'unfulfilled') row.toShip += 1;
    rows.set(platform, row);
  });
  const list = [...rows.values()].sort((a, b) => b.sales - a.sales);
  const live = data.visibleStores.filter((s) => s.webhooks === 'active' && s.status === 'active').length;

  return (
    <Card
      title="Sales by channel"
      className="xl:col-span-2"
      action={
        <span className={`flex items-center gap-1 text-xs ${ui.muted}`}>
          <Radio size={12} /> {live} of {data.visibleStores.length} stores live · {data.periodName}
        </span>
      }
    >
      <DataTable
        rows={list.map((r) => ({ ...r, id: r.platform }))}
        empty={`No orders ${data.period === 'all' ? 'yet' : data.periodName.toLowerCase()}.`}
        columns={[
          { key: 'platform', label: 'Channel', primary: true, render: (r) => <span className={`font-medium ${ui.h}`}>{r.platform}</span> },
          { key: 'orders', label: 'Orders', align: 'right', render: (r) => <span className="tabular-nums">{r.orders}</span> },
          { key: 'sales', label: 'Sales', align: 'right', render: (r) => <span className="tabular-nums">{money(r.sales)}</span> },
          { key: 'refunds', label: 'Refunds', align: 'right', render: (r) => <span className="tabular-nums">{r.refunds ? `−${money(r.refunds)}` : '—'}</span> },
          { key: 'toShip', label: 'To ship', align: 'right', render: (r) => <span className="tabular-nums">{r.toShip}</span> },
        ]}
      />
    </Card>
  );
}

const changeHint = (data) =>
  data.change == null ? (data.range.compareLabel ? `Nothing to compare with ${data.range.compareLabel}` : 'Every order so far') : `${data.change >= 0 ? '+' : ''}${data.change}% vs ${data.range.compareLabel}`;

export function SalesStat({ data }) {
  const { money } = useApp();
  return <StatCard label={`Sales, ${data.periodName.toLowerCase()}`} value={money(data.sales)} hint={changeHint(data)} icon={DollarSign} />;
}

export function OrdersStat({ data }) {
  return <StatCard label="Orders" value={data.counted.length} hint={`${data.waitingToShip} waiting to ship`} icon={Receipt} />;
}

export function ClientsStat({ data }) {
  const active = data.clients.filter((c) => c.status === 'active').length;
  return <StatCard label="Total clients" value={data.clients.length} hint={`${active} active`} icon={Building2} />;
}

export function LowStockStat({ data }) {
  const { settings } = useApp();
  return (
    <StatCard
      label="Low stock"
      value={data.lowStock.length}
      hint={`Under ${settings.lowStockThreshold} units`}
      icon={TriangleAlert}
      tone={data.lowStock.length ? 'warning' : undefined}
    />
  );
}

export function SalesChartCard({ data }) {
  return (
    <Card title="Sales" className="xl:col-span-2" action={<span className={`text-xs ${ui.muted}`}>{data.periodName}</span>}>
      <SalesChart orders={data.counted} period={data.period} firstOrderAt={data.firstOrderAt} />
    </Card>
  );
}

export function RecentOrdersCard({ data }) {
  const { storeOf, customerOf, money, go, openDrawer } = useApp();
  return (
    <Card title="Recent orders" className="xl:col-span-2" action={<LinkButton onClick={() => go('orders')}>All orders</LinkButton>}>
      <DataTable
        columns={orderColumns(storeOf, customerOf, money)}
        rows={data.inPeriod.slice(0, 6)}
        empty={`No orders ${data.period === 'all' ? 'yet' : data.periodName.toLowerCase()}.`}
        onRowClick={(o) => openDrawer('order', o.id)}
      />
    </Card>
  );
}

/**
 * Date range picker and PDF download for the top of a dashboard.
 * `stats` are the four cards as [label, value] pairs.
 */
export function DashboardActions({ data, title, stats }) {
  const { access, settings, storeOf, customerOf, money } = useApp();

  const download = () =>
    downloadPdf({
      title,
      subtitle: `${data.periodName} · ${data.visibleStores.length} store${data.visibleStores.length === 1 ? '' : 's'}`,
      workspace: settings.workspaceName,
      filename: 'dashboard',
      stats,
      sections: [
        {
          heading: 'Sales by channel',
          columns: ['Channel', 'Orders', 'Sales', 'Refunds'],
          rows: [...new Set(data.inPeriod.map((o) => storeOf(o.storeId)?.platform || 'Other'))].map((p) => {
            const list = data.inPeriod.filter((o) => (storeOf(o.storeId)?.platform || 'Other') === p);
            const counted = list.filter((o) => o.status !== 'refunded' && o.status !== 'cancelled');
            return [p, String(counted.length), money(counted.reduce((s, o) => s + (Number(o.total) || 0), 0)), money(list.reduce((s, o) => s + (Number(o.refunded) || 0), 0))];
          }),
        },
        {
          heading: `Orders (${data.inPeriod.length})`,
          columns: ['Order', 'Date', 'Customer', 'Store', 'Status', 'Total'],
          rows: data.inPeriod.map((o) => [
            o.number,
            formatDate(o.placedAt),
            customerOf(o.customerId)?.name || '',
            storeOf(o.storeId)?.name || '',
            STATUS[o.status]?.[0] || o.status,
            money(o.total),
          ]),
        },
        {
          heading: `Low stock (${data.lowStock.length})`,
          columns: ['Product', 'SKU', 'Store', 'Stock'],
          rows: data.lowStock.map((p) => [p.title, p.sku || '', storeOf(p.storeId)?.name || '', String(p.stock)]),
        },
      ],
    });

  return (
    <>
      <PeriodSelect className="w-40" />
      {access.exportData && (
        <Button onClick={download}>
          <FileDown size={15} /> PDF
        </Button>
      )}
    </>
  );
}
