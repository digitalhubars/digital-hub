import { Download, FileDown } from 'lucide-react';
import { StoreBadge } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import DataTable from '../../components/ui/DataTable';
import PageHeader from '../../components/ui/PageHeader';
import { useApp } from '../../context/AppContext';
import { downloadCsv, formatDate } from '../../lib/format';
import { downloadPdf } from '../../lib/pdf';
import { ui } from '../../styles/ui';

export default function CustomersPage() {
  const { access, storeIds, storeOf, customers, money, q, openDrawer, settings } = useApp();

  const rows = customers
    .filter(
      (c) =>
        storeIds.includes(c.storeId) &&
        (!q || [c.name, c.email, storeOf(c.storeId)?.name].some((v) => String(v).toLowerCase().includes(q))),
    )
    .sort((a, b) => b.spent - a.spent);

  const exportCsv = () =>
    downloadCsv(
      'customers.csv',
      rows.map((c) => ({ name: c.name, email: c.email, store: storeOf(c.storeId)?.name, orders: c.orderCount, spent: c.spent.toFixed(2) })),
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
              <Button onClick={exportCsv}>
                <Download size={15} /> CSV
              </Button>
            </>
          )
        }
      />
      <Card title={`${rows.length} customer${rows.length === 1 ? '' : 's'}`}>
        <DataTable
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
