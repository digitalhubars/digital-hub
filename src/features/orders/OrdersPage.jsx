import { useState } from 'react';
import { CircleCheck, CircleX, DollarSign, Download, Eye, FileDown, Loader, Receipt, ShoppingCart, Trash2, TriangleAlert } from 'lucide-react';
import ActionMenu from '../../components/ui/ActionMenu';
import Button from '../../components/ui/Button';
import { Card, StatCard } from '../../components/ui/Card';
import DataTable, { BulkBar, useSelection } from '../../components/ui/DataTable';
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
  const { role, isAdmin, access, scopedStores, storeIds, storeOf, customerOf, orders, products, settings, money, q, openDrawer, period, askConfirm, updateOrdersStatus, deleteOrders } =
    useApp();
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

  const selection = useSelection(rows);
  const canEdit = access.editOrders && role !== 'client';
  const canDelete = isAdmin && role === 'admin';

  const setStatus = (list, status) => {
    const label = STATUS[status][0].toLowerCase();
    const send = () => {
      updateOrdersStatus(list, status);
      selection.clear();
    };
    if (list.length === 1) return send();
    return askConfirm({
      title: `Mark ${list.length} orders as ${label}?`,
      body: 'Each order is updated in Digital Hub and sent to its store (WooCommerce, Shopify, eBay).',
      confirmLabel: `Mark ${label}`,
      onConfirm: send,
    });
  };

  const confirmDelete = (list) => {
    const platforms = [...new Set(list.map((o) => storeOf(o.storeId)?.platform).filter(Boolean))];
    const sentTo = platforms.filter((p) => ['WooCommerce', 'Shopify'].includes(p));
    askConfirm({
      title: list.length === 1 ? `Delete order ${list[0].number}?` : `Delete ${list.length} orders?`,
      body: [
        sentTo.length ? `The order${list.length === 1 ? ' is' : 's are'} also deleted on ${sentTo.join(' and ')} (WooCommerce moves orders to the trash).` : null,
        platforms.some((p) => !sentTo.includes(p)) ? 'Other platforms don’t allow deleting orders, so those are removed from Digital Hub only.' : null,
        'This can’t be undone here.',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Delete',
      onConfirm: () => {
        deleteOrders(list);
        selection.clear();
      },
    });
  };

  const statusItems = (list) =>
    [
      ['processing', Loader],
      ['fulfilled', CircleCheck],
      ['cancelled', CircleX],
    ].map(([status, icon]) => ({
      label: `Mark ${STATUS[status][0].toLowerCase()}`,
      icon,
      onClick: () => setStatus(list, status),
      hidden: !canEdit || list.every((o) => o.status === status),
    }));

  const columns = [
    ...orderColumns(storeOf, customerOf, money, true),
    {
      key: 'actions',
      label: '',
      align: 'right',
      actions: true,
      render: (o) => (
        <ActionMenu
          items={[
            { label: 'View details', icon: Eye, onClick: () => openDrawer('order', o.id) },
            ...statusItems([o]),
            { label: 'Delete', icon: Trash2, danger: true, onClick: () => confirmDelete([o]), hidden: !canDelete },
          ]}
        />
      ),
    },
  ];

  const exportCsv = (list = rows) =>
    downloadCsv(
      'orders.csv',
      list.map((o) => ({
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
                <Button onClick={() => exportCsv()}>
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
        {(canEdit || canDelete) && (
          <BulkBar selection={selection}>
            {canEdit && (
              <Select
                value=""
                onChange={(status) => status && setStatus(selection.selected, status)}
                className="w-auto py-1.5"
                options={[{ value: '', label: 'Change status…' }, ...ORDER_STATUSES.map((st) => ({ value: st, label: STATUS[st][0] }))]}
              />
            )}
            {access.exportData && (
              <Button size="sm" onClick={() => exportCsv(selection.selected)}>
                <Download size={13} /> Export CSV
              </Button>
            )}
            {canDelete && (
              <Button size="sm" variant="danger" onClick={() => confirmDelete(selection.selected)}>
                <Trash2 size={13} /> Delete
              </Button>
            )}
          </BulkBar>
        )}
        <DataTable
          columns={columns}
          rows={rows}
          pageSize={10}
          selection={canEdit || canDelete ? selection : undefined}
          onRowClick={(o) => openDrawer('order', o.id)}
          empty={period === 'all' ? 'No orders match these filters.' : `No orders ${summary.periodName.toLowerCase()} match these filters.`}
        />
      </Card>
    </div>
  );
}
