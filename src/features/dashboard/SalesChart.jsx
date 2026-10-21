import { useApp } from '../../context/AppContext';
import { chartBuckets } from '../../lib/period';
import { ui } from '../../styles/ui';

// Sales per hour (today), day (this week / month) or month (this year / all time).
// The current bucket is solid; hover shows the total.
export default function SalesChart({ orders, period, firstOrderAt }) {
  const { money } = useApp();
  const now = Date.now();

  const buckets = chartBuckets(period, firstOrderAt, now).map((b) => ({
    ...b,
    total: orders.filter((o) => o.placedAt >= b.start && o.placedAt < b.end).reduce((sum, o) => sum + (Number(o.total) || 0), 0),
    current: now >= b.start && now < b.end,
    future: b.start > now,
  }));
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const tight = buckets.length > 16;

  return (
    <div className="px-4 pb-4 pt-5 sm:px-5">
      <div className={`flex h-44 items-end sm:h-60 xl:h-72 ${tight ? 'gap-0.5 sm:gap-1' : 'gap-1 sm:gap-2'}`}>
        {buckets.map((b) => (
          <div key={b.start} className="group relative flex h-full flex-1 flex-col justify-end">
            <div
              className={`w-full rounded-t ${
                b.current
                  ? 'bg-teal-700 dark:bg-teal-400'
                  : b.future
                    ? 'bg-gray-100 dark:bg-gray-800'
                    : 'bg-teal-600/70 group-hover:bg-teal-700 dark:bg-teal-500/50 dark:group-hover:bg-teal-400'
              }`}
              style={{ height: `${Math.max(2, (b.total / max) * 100)}%` }}
            />
            <div className="pointer-events-none absolute -top-8 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] text-white group-hover:block dark:bg-gray-100 dark:text-gray-900">
              {b.label}: {money(b.total)}
            </div>
          </div>
        ))}
      </div>
      <div className={`mt-2 flex text-[10px] sm:text-[11px] ${tight ? 'gap-0.5 sm:gap-1' : 'gap-1 sm:gap-2'} ${ui.muted}`}>
        {buckets.map((b) => (
          <span key={b.start} className="flex-1 text-center">
            {b.tick}
          </span>
        ))}
      </div>
    </div>
  );
}
