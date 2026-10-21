import { useRef } from 'react';
import { Database, Download, FileSpreadsheet, Plus, Trash2, Upload } from 'lucide-react';
import Button from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { useApp } from '../../../context/AppContext';
import { downloadCsv } from '../../../lib/format';
import { readBackupFile } from '../../../lib/storage';
import { ui } from '../../../styles/ui';

function Row({ icon: Icon, title, body, children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-teal-50 p-2 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">
          <Icon size={16} />
        </span>
        <div>
          <p className={`text-sm font-medium ${ui.h}`}>{title}</p>
          <p className={`mt-0.5 text-sm ${ui.muted}`}>{body}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{children}</div>
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function DataTab() {
  const {
    stores, products, orders, customers, storeOf, customerOf,
    exportBackup, importBackup, hasSampleData, loadSampleData, removeSampleData, askConfirm, showToast,
  } = useApp();
  const fileRef = useRef(null);

  const chooseFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { data, counts, exportedAt } = await readBackupFile(file);
      const summary = [
        plural(counts.stores, 'store'),
        plural(counts.products, 'product'),
        plural(counts.orders, 'order'),
        plural(counts.customers, 'customer'),
        plural(counts.clients, 'client'),
      ].join(', ');
      askConfirm({
        title: 'Restore this backup?',
        body: `${exportedAt ? `Backup from ${new Date(exportedAt).toLocaleString()}. ` : ''}It contains ${summary}. Records with the same ID are replaced; nothing is sent to your stores.`,
        confirmLabel: 'Restore backup',
        onConfirm: () => importBackup(data),
      });
    } catch (err) {
      showToast({ tone: 'danger', title: 'Couldn’t read file', body: err.message });
    }
  };

  const csvExports = [
    ['Products', products.length, () =>
      downloadCsv('products.csv', products.map((p) => ({
        title: p.title, sku: p.sku, external_id: p.externalId, category: p.category,
        store: storeOf(p.storeId)?.name, platform: storeOf(p.storeId)?.platform, status: p.status, stock: p.stock, price: p.price,
      })))],
    ['Orders', orders.length, () =>
      downloadCsv('orders.csv', orders.map((o) => ({
        order: o.number, placed: new Date(o.placedAt).toISOString(), customer: customerOf(o.customerId)?.name,
        store: storeOf(o.storeId)?.name, platform: storeOf(o.storeId)?.platform, status: o.status, total: Number(o.total || 0).toFixed(2),
      })))],
    ['Customers', customers.length, () =>
      downloadCsv('customers.csv', customers.map((c) => ({
        name: c.name, email: c.email, store: storeOf(c.storeId)?.name, orders: c.orderCount, spent: Number(c.spent || 0).toFixed(2),
      })))],
  ];

  return (
    <div className="space-y-4">
      <Card title="Import and export" bodyClass={ui.divide}>
        <Row icon={Upload} title="Import backup" body="Restore a Digital Hub backup (.json) downloaded from this page.">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={chooseFile} />
          <Button onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> Choose file
          </Button>
        </Row>
        <Row icon={Download} title="Export backup" body={`Download everything in the workspace as one file (${plural(stores.length, 'store')}).`}>
          <Button onClick={exportBackup}>
            <Download size={15} /> Download backup
          </Button>
        </Row>
        <Row icon={FileSpreadsheet} title="Export CSV" body="Download products, orders or customers as a spreadsheet.">
          {csvExports.map(([label, count, run]) => (
            <Button key={label} onClick={run} disabled={!count}>
              {label}
            </Button>
          ))}
        </Row>
      </Card>

      <Card title="Sample data" bodyClass={ui.divide}>
        <Row
          icon={Database}
          title={hasSampleData ? 'Sample stores are loaded' : 'Add sample stores'}
          body={hasSampleData ? 'Demo stores with products, orders and customers. They never contact a real store.' : 'Fill the dashboards with demo stores to try things out.'}
        >
          {hasSampleData ? (
            <Button
              className="text-red-700 dark:text-red-400"
              onClick={() =>
                askConfirm({
                  title: 'Remove the sample stores?',
                  body: 'The demo stores and their products, orders, customers and clients are deleted. Your real stores aren’t touched.',
                  confirmLabel: 'Remove samples',
                  onConfirm: removeSampleData,
                })
              }
            >
              <Trash2 size={15} /> Clear sample data
            </Button>
          ) : (
            <Button onClick={loadSampleData}>
              <Plus size={15} /> Add sample stores
            </Button>
          )}
        </Row>
      </Card>
    </div>
  );
}
