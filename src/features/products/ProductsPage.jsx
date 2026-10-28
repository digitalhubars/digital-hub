import { useState } from 'react';
import { Download, FileDown, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, StoreBadge } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Callout from '../../components/ui/Callout';
import { Card } from '../../components/ui/Card';
import DataTable, { BulkBar, useSelection } from '../../components/ui/DataTable';
import PageHeader from '../../components/ui/PageHeader';
import Select from '../../components/ui/Select';
import { useApp } from '../../context/AppContext';
import { PLATFORM_NAMES } from '../../data/platforms';
import { downloadCsv, shortTitle } from '../../lib/format';
import { downloadPdf } from '../../lib/pdf';
import { ui } from '../../styles/ui';
import ProductModal from './ProductModal';

export default function ProductsPage() {
  const { role, access, scopedStores, storeIds, storeOf, products, money, settings, q, syncing, deleteProduct, deleteProducts, askConfirm } = useApp();
  const [storeFilter, setStoreFilter] = useState('all');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState(null);

  const rows = products.filter(
    (p) =>
      storeIds.includes(p.storeId) &&
      (storeFilter === 'all' || p.storeId === storeFilter) &&
      (platformFilter === 'all' || storeOf(p.storeId)?.platform === platformFilter) &&
      (statusFilter === 'all' || p.status === statusFilter) &&
      (!lowOnly || (p.stock != null && p.stock < settings.lowStockThreshold)) &&
      (!q || [p.title, p.sku, p.category, storeOf(p.storeId)?.name].some((v) => String(v).toLowerCase().includes(q))),
  );
  const platforms = PLATFORM_NAMES.filter((name) => scopedStores.some((s) => s.platform === name && storeIds.includes(s.id)));
  const selection = useSelection(rows);
  const selectable = access.deleteProducts || access.exportData;

  const columns = [
    {
      key: 'title',
      label: 'Product',
      primary: true,
      render: (p) => (
        <div className="min-w-0">
          <p className={`truncate font-medium ${ui.h}`} title={p.title}>
            {shortTitle(p.title)}
          </p>
          <p className={`text-xs font-normal ${ui.muted}`}>
            {p.sku}
            {p.category ? ` · ${p.category}` : ''}
          </p>
        </div>
      ),
    },
    { key: 'source', label: 'Source', render: (p) => <StoreBadge store={storeOf(p.storeId)} /> },
    {
      key: 'status',
      label: 'Status',
      render: (p) =>
        p.syncState === 'error' ? (
          <span title={p.syncError} className="inline-flex flex-col gap-0.5">
            <Badge tone="danger">Sync failed</Badge>
            <span className="max-w-[14rem] truncate text-xs text-red-700 dark:text-red-400">{p.syncError}</span>
          </span>
        ) : (
          <Badge status={p.status} />
        ),
    },
    {
      key: 'stock',
      label: 'Stock',
      align: 'right',
      render: (p) =>
        p.stock == null ? (
          <span className={ui.muted}>{p.stockStatus === 'outofstock' ? 'Out' : 'In stock'}</span>
        ) : (
          <span className={p.stock < settings.lowStockThreshold ? 'font-medium text-amber-700 dark:text-amber-400' : ''}>{p.stock}</span>
        ),
    },
    { key: 'price', label: 'Price', align: 'right', aside: true, render: (p) => money(p.price) },
  ];

  if (access.editProducts || access.deleteProducts) {
    columns.push({
      key: 'actions',
      label: '',
      align: 'right',
      actions: true,
      render: (p) =>
        syncing[p.id] ? (
          <span className={`inline-flex items-center gap-1.5 text-xs ${ui.muted}`}>
            <RefreshCw size={13} className="animate-spin" /> Syncing
          </span>
        ) : (
          <div className="flex items-center justify-end gap-1">
            {access.editProducts && (
              <Button size="sm" onClick={() => setEditing(p)}>
                <Pencil size={12} /> Edit
              </Button>
            )}
            {access.deleteProducts && (
              <button
                type="button"
                onClick={() =>
                  askConfirm({
                    title: 'Delete product?',
                    body: `“${shortTitle(p.title, 8)}” will be removed from Digital Hub and deleted in ${storeOf(p.storeId)?.name}.`,
                    onConfirm: () => deleteProduct(p),
                  })
                }
                className={`${ui.icon} hover:text-red-700 dark:hover:text-red-400`}
                aria-label="Delete"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ),
    });
  }

  const exportCsv = (list = rows) =>
    downloadCsv(
      'products.csv',
      list.map((p) => ({
        title: p.title,
        sku: p.sku,
        external_id: p.externalId,
        category: p.category,
        store: storeOf(p.storeId)?.name,
        platform: storeOf(p.storeId)?.platform,
        status: p.status,
        stock: p.stock,
        price: p.price,
      })),
    );

  const exportPdf = () => {
    const low = rows.filter((p) => p.stock != null && p.stock < settings.lowStockThreshold).length;
    return downloadPdf({
      title: 'Products',
      subtitle: `${rows.length} product${rows.length === 1 ? '' : 's'}`,
      workspace: settings.workspaceName,
      filename: 'products',
      stats: [
        ['Products', rows.length],
        ['Active', rows.filter((p) => p.status === 'active').length],
        ['Stock value', money(rows.reduce((sum, p) => sum + (Number(p.price) || 0) * (Number(p.stock) || 0), 0))],
        ['Low stock', low],
      ],
      sections: [
        {
          columns: ['Product', 'SKU', 'Category', 'Store', 'Status', 'Stock', 'Price'],
          rows: rows.map((p) => [
            p.title,
            p.sku || '',
            p.category || '',
            storeOf(p.storeId)?.name || '',
            p.status === 'out_of_stock' ? 'Out of stock' : p.status === 'draft' ? 'Draft' : 'Active',
            p.stock == null ? 'Not tracked' : String(p.stock),
            money(p.price),
          ]),
        },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Products"
        description={
          role === 'admin' ? 'Products from every connected store.' : role === 'manager' ? 'Products in your store group.' : 'Products in your stores.'
        }
        actions={
          <>
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
            {access.addProducts && scopedStores.length > 0 && (
              <Button variant="primary" onClick={() => setEditing({})}>
                <Plus size={15} /> Add product
              </Button>
            )}
          </>
        }
      />

      {!access.editProducts && <Callout>You can view products but not change them. Ask your account manager for edit access.</Callout>}

      <Card
        title={`${rows.length} product${rows.length === 1 ? '' : 's'}`}
        action={
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
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
              className="sm:w-36"
              options={[
                { value: 'all', label: 'Any status' },
                { value: 'active', label: 'Active' },
                { value: 'draft', label: 'Draft' },
                { value: 'out_of_stock', label: 'Out of stock' },
              ]}
            />
            <label className={`col-span-2 inline-flex items-center gap-2 whitespace-nowrap text-sm ${ui.body}`}>
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 rounded border-gray-300 accent-teal-700" />
              Low stock only
            </label>
          </div>
        }
      >
        {selectable && (
          <BulkBar selection={selection}>
            {access.exportData && (
              <Button size="sm" onClick={() => exportCsv(selection.selected)}>
                <Download size={13} /> Export CSV
              </Button>
            )}
            {access.deleteProducts && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  const list = selection.selected;
                  askConfirm({
                    title: `Delete ${list.length} product${list.length === 1 ? '' : 's'}?`,
                    body: 'They will be removed from Digital Hub and deleted in their stores (where the platform allows it).',
                    confirmLabel: 'Delete',
                    onConfirm: () => {
                      deleteProducts(list);
                      selection.clear();
                    },
                  });
                }}
              >
                <Trash2 size={13} /> Delete
              </Button>
            )}
          </BulkBar>
        )}
        <DataTable columns={columns} rows={rows} pageSize={10} selection={selectable ? selection : undefined} empty="No products match these filters." />
      </Card>

      {editing && <ProductModal product={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
