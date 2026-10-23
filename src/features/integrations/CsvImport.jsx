import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import Button from '../../components/ui/Button';
import { useApp } from '../../context/AppContext';
import { ui } from '../../styles/ui';

const KINDS = [
  ['orders', 'Import orders CSV', 'Order ID, Sold date, Item title, Sale price, Shipping, Buyer, Status'],
  ['listings', 'Import listings CSV', 'Item ID, Title, Price, Quantity, Status, SKU'],
];

// Upload buttons for stores without an API (Mercari). Columns are matched by name, loosely.
export default function CsvImport({ store }) {
  const { importStoreCsv } = useApp();
  const inputs = useRef({});
  const [last, setLast] = useState('');

  const pick = (kind) => async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const result = await importStoreCsv(store, kind, file);
    if (result) setLast(result.message);
  };

  return (
    <div className="space-y-3">
      <p className={`text-sm ${ui.body}`}>
        {store.platform} has no public seller API. Import CSV files; importing the same file again updates rows instead of adding duplicates.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {KINDS.map(([kind, label, columns]) => (
          <div key={kind} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
            <input ref={(el) => (inputs.current[kind] = el)} type="file" accept=".csv,text/csv" className="hidden" onChange={pick(kind)} />
            <Button className="w-full justify-center" onClick={() => inputs.current[kind]?.click()}>
              <FileUp size={15} /> {label}
            </Button>
            <p className={`mt-2 text-xs ${ui.muted}`}>Columns we read: {columns}.</p>
          </div>
        ))}
      </div>
      {last && <p className={`text-xs ${ui.muted}`}>Last import: {last}</p>}
    </div>
  );
}
