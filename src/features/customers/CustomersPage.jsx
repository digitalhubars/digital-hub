import { Copy, Download, FileDown, Mail } from 'lucide-react';
import { StoreBadge } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import DataTable, { BulkBar, useSelection } from '../../components/ui/DataTable';
import PageHeader from '../../components/ui/PageHeader';
import { useApp } from '../../context/AppContext';
import { downloadCsv, formatDate } from '../../lib/format';
import { downloadPdf } from '../../lib/pdf';
import { ui } from '../../styles/ui';

export default function CustomersPage() {
  const { access, storeIds, storeOf, customers, money, q, openDrawer, settings, showToast } = useApp();

  const rows = customers
    .filter(
      (c) =>
        storeIds.includes(c.storeId) &&
        (!q || [c.name, c.email, storeOf(c.storeId)?.name].some((v) => String(v).toLowerCase().includes(q))),
    )
    .sort((a, b) => b.spent - a.spent);

  const selection = useSelection(rows);
  const emails = () => [...new Set(selection.selected.map((c) => c.email).filter(Boolean))];
  const copyEmails = async () => {
    const list = emails();
    try {
      await navigator.clipboard.writeText(list.join(', '));
      showToast({ title: `${list.length} email address${list.length === 1 ? '' : 'es'} copied` });
    } catch {
      showToast({ tone: 'danger', title: 'Couldn’t copy', body: 'Your browser blocked the clipboard.' });
    }
  };

  const exportCsv = (list = rows) =>
    downloadCsv(
      'customers.csv',
      list.map((c) => ({ name: c.name, email: c.email, store: storeOf(c.storeId)?.name, orders: c.orderCount, spent: c.spent.toFixed(2) })),
    );

  const exportPdf = () =>
    downloadPdf({
      title: 'Customers',
      subtitle: `${rows.length} customer${rows.length === 1 ? '' : 's'}`,
      workspace: settings.workspaceName,
      filename: 'customers',
      stats: [
        ['Customers', rows.length],
        ['With orders', rows.filter((c) => c.orderCount > 0).length],
        ['Total spent', money(rows.reduce((sum, c) => sum + c.spent, 0))],
      ],
      sections: [
        {
          columns: ['Name', 'Email', 'Store', 'Orders', 'Spent', 'Last order'],
          rows: rows.map((c) => [
            c.name,
            c.email || '',
            storeOf(c.storeId)?.name || '',
            String(c.orderCount),
            money(c.spent),
            c.lastOrder ? formatDate(c.lastOrder) : '',
          ]),
        },
      ],
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customers"
        description="Customer totals are calculated from synced orders."
        actions={
          access.exportData && (
            <>
              <Button onClick={exportPdf}>
                <FileDown size={15} /> PDF
              </Button>
              <Button onClick={() => exportCsv()}>
                <Download size={15} /> CSV
              </Button>
            </>
          )
        }
      />
      <Card title={`${rows.length} customer${rows.length === 1 ? '' : 's'}`}>
        <BulkBar selection={selection}>
          {access.exportData && (
            <Button size="sm" onClick={() => exportCsv(selection.selected)}>
              <Download size={13} /> Export CSV
            </Button>
          )}
          <Button size="sm" onClick={copyEmails} disabled={!emails().length}>
            <Copy size={13} /> Copy emails
          </Button>
          <a href={`mailto:?bcc=${encodeURIComponent(emails().join(','))}`} className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 ${emails().length ? '' : 'pointer-events-none opacity-50'}`}>
            <Mail size={13} /> Email
          </a>
        </BulkBar>
        <DataTable
          selection={selection}
          columns={[
            { key: 'name', label: 'Name', primary: true, render: (c) => <span className={`font-medium ${ui.h}`}>{c.name}</span> },
            { key: 'email', label: 'Email' },
            { key: 'store', label: 'Store', render: (c) => <StoreBadge store={storeOf(c.storeId)} /> },
            { key: 'orders', label: 'Orders', align: 'right', render: (c) => c.orderCount },
            { key: 'last', label: 'Last order', render: (c) => (c.lastOrder ? formatDate(c.lastOrder) : '—') },
            { key: 'spent', label: 'Total spent', align: 'right', aside: true, render: (c) => money(c.spent) },
          ]}
          rows={rows}
          pageSize={10}
          onRowClick={(c) => openDrawer('customer', c.id)}
          empty="No customers match your search."
        />
      </Card>
    </div>
  );
}
