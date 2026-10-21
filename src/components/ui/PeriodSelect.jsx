import { CalendarDays } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { PERIODS } from '../../lib/period';
import { ui } from '../../styles/ui';

// All time / This year / This month / This week / Today. Shared by the Dashboard and Orders page.
export default function PeriodSelect({ className = '' }) {
  const { period, setPeriod } = useApp();
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">Date range</span>
      <CalendarDays size={15} className={`pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 ${ui.muted}`} />
      <select value={period} onChange={(e) => setPeriod(e.target.value)} className={`${ui.input} pl-8`}>
        {PERIODS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
