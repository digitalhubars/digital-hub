import { useState } from 'react';
import { DollarSign, Download, FileDown, Receipt, ShoppingCart, TriangleAlert } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Card, StatCard } from '../../components/ui/Card';
import DataTable from '../../components/ui/DataTable';
import PageHeader from '../../components/ui/PageHeader';
import PeriodSelect from '../../components/ui/PeriodSelect';
import Select from '../../components/ui/Select';
import { useApp } from '../../context/AppContext';
import { PLATFORM_NAMES } from '../../data/platforms';
import { downloadCsv, formatDate } from '../../lib/format';
import { downloadPdf } from '../../lib/pdf';
import { ORDER_STATUSES, STATUS } from '../../styles/ui';
import { orderSummary } from '../dashboard/useDashboardData';
import { orderColumns } from './orderColumns';

export default function OrdersPage() {
  const { role, access, scopedStores, storeIds, storeOf, customerOf, orders, products, settings, money, q, openDrawer, period } = useApp();
  const [storeFilter, setStoreFilter] = useState('all');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const platforms = PLATFORM_NAMES.filter((name) => scopedStores.some((s) => s.platform === name && storeIds.includes(s.id)));
  const inStores = (storeId) =>
    storeIds.includes(storeId) && (storeFilter === 'all' || storeId === storeFilter) && (platformFilter === 'all' || storeOf(storeId)?.platform === platformFilter);

  // The cards follow the period, store and platform filters (not status or search).
  const summary = orderSummary(orders.filter((o) => inStores(o.storeId)), period);
  const lowStock = products.filter((p) => inStores(p.storeId) && p.stock != null && p.stock < settings.lowStockThreshold);

  const rows = summary.inPeriod.filter(
    (o) =>
      (statusFilter === 'all' || o.status === statusFilter) &&
      (!q || [o.number, customerOf(o.customerId)?.name, storeOf(o.storeId)?.name].some((v) => String(v).toLowerCase().includes(q))),
  );

  const exportCsv = () =>
    downloadCsv(
      'orders.csv',
      rows.map((o) => ({
        order: o.number,
        placed: new Date(o.placedAt).toISOString(),
        customer: customerOf(o.customerId)?.name,
        store: storeOf(o.storeId)?.name,
        platform: storeOf(o.storeId)?.platform,
        status: o.status,
        total: Number(o.total || 0).toFixed(2),
      })),
    );

  const stats = [
    ['Total orders', summary.counted.length],
    ['Total sales', money(summary.sales)],
    ['Average order', money(summary.averageOrder)],
    ['Low stock', lowStock.length],
  ];

  const exportPdf = () =>
    downloadPdf({
      title: 'Orders',
      subtitle: [
        summary.periodName,
        storeFilter === 'all' ? 'All stores' : storeOf(storeFilter)?.name,
        platformFilter === 'all' ? null : platformFilter,
        statusFilter === 'all' ? null : STATUS[statusFilter][0],
      ]
        .filter(Boolean)
        .join(' · '),
      workspace: settings.workspaceName,
      filename: 'orders',
      stats,
      sections: [
        {
          columns: ['Order', 'Date', 'Customer', 'Store', 'Platform', 'Status', 'Total'],
          rows: rows.map((o) => [
            o.number,
            formatDate(o.placedAt),
            customerOf(o.customerId)?.name || '',
            storeOf(o.storeId)?.name || '',
            storeOf(o.storeId)?.platform || '',
            STATUS[o.status]?.[0] || o.status,
            money(o.total),
          ]),
        },
      ],
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        description={role === 'client' ? 'Orders placed in your stores. Tap an order for details.' : 'Tap an order to see items and update its status.'}
        actions={
          <>
            <PeriodSelect className="w-40" />
            {access.exportData && (
              <>
                <Button onClick={exportPdf}>
                  <FileDown size={15} /> PDF
                </Button>
                <Button onClick={exportCsv}>
                  <Download size={15} /> CSV
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard label="Total orders" value={summary.counted.length} hint={`${summary.waitingToShip} waiting to ship`} icon={Receipt} />
        <StatCard label="Total sales" value={money(summary.sales)} hint={summary.periodName} icon={DollarSign} />
        <StatCard label="Average order" value={money(summary.averageOrder)} hint="Refunds and cancellations left out" icon={ShoppingCart} />
        <StatCard
          label="Low stock"
          value={lowStock.length}
          hint={`Under ${settings.lowStockThreshold} units`}
          icon={TriangleAlert}
          tone={lowStock.length ? 'warning' : undefined}
        />
      </div>

      <Card
        title={`${rows.length} order${rows.length === 1 ? '' : 's'}`}
        action={
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            {platforms.length > 1 && (
              <Select
                value={platformFilter}
                onChange={setPlatformFilter}
                className="sm:w-40"
                options={[{ value: 'all', label: 'All platforms' }, ...platforms.map((p) => ({ value: p, label: p }))]}
              />
            )}
            {storeIds.length > 1 && (
              <Select
                value={storeFilter}
                onChange={setStoreFilter}
                className="sm:w-44"
                options={[
                  { value: 'all', label: 'All stores' },
                  ...scopedStores.filter((s) => storeIds.includes(s.id)).map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            )}
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              className="sm:w-40"
              options={[{ value: 'all', label: 'Any status' }, ...ORDER_STATUSES.map((s) => ({ value: s, label: STATUS[s][0] }))]}
            />
          </div>
        }
      >
        <DataTable
          columns={orderColumns(storeOf, customerOf, money, true)}
          rows={rows}
          pageSize={10}
          onRowClick={(o) => openDrawer('order', o.id)}
          empty={period === 'all' ? 'No orders match these filters.' : `No orders ${summary.periodName.toLowerCase()} match these filters.`}
        />
      </Card>
    </div>
  );
}
