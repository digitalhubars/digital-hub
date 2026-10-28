// Calendar periods for the Dashboard and Orders page. "This month" starts on the 1st,
// so its totals start again from 0.00 when a new month begins (likewise for the
// year, the week (Monday to Sunday) and the day).

export const PERIODS = [
  { value: 'all', label: 'All time' },
  { value: 'year', label: 'This year' },
  { value: 'month', label: 'This month' },
  { value: 'week', label: 'This week' },
  { value: 'day', label: 'Today' },
];

export const DEFAULT_PERIOD = 'all';

const COMPARE_LABEL = { year: 'last year', month: 'last month', week: 'last week', day: 'yesterday' };

export const periodLabel = (period) => PERIODS.find((p) => p.value === period)?.label || 'All time';

function startOf(period, date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (period === 'year') d.setMonth(0, 1);
  if (period === 'month') d.setDate(1);
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return d;
}

function shift(period, date, by) {
  const d = new Date(date);
  if (period === 'year') d.setFullYear(d.getFullYear() + by);
  if (period === 'month') d.setMonth(d.getMonth() + by);
  if (period === 'week') d.setDate(d.getDate() + 7 * by);
  if (period === 'day') d.setDate(d.getDate() + by);
  return d;
}

/**
 * { start, end, prevStart, prevEnd, compareLabel } in ms. `start` is null for "All time".
 * The previous range covers the same stretch of the previous period (e.g. 1–22 Sep vs 1–22 Oct),
 * so a comparison early in the month is fair.
 */
export function periodRange(period, now = Date.now()) {
  if (period === 'all' || !COMPARE_LABEL[period]) return { start: null, end: now, prevStart: null, prevEnd: null, compareLabel: null };
  const start = startOf(period, now).getTime();
  const prevStart = shift(period, start, -1).getTime();
  return { start, end: now, prevStart, prevEnd: prevStart + (now - start), compareLabel: COMPARE_LABEL[period] };
}

export const inRange = (ts, start, end) => (start == null || ts >= start) && ts <= end;

const DAY = 864e5;

/**
 * Chart buckets for the period: hours for today, days for a week or month, months for a
 * year or all time. Each bucket is { start, end, label, tick }.
 */
export function chartBuckets(period, firstTs, now = Date.now()) {
  const buckets = [];
  if (period === 'day') {
    const day = startOf('day', now);
    for (let h = 0; h < 24; h++) {
      const start = day.getTime() + h * 36e5;
      buckets.push({ start, end: start + 36e5, label: `${String(h).padStart(2, '0')}:00`, tick: h % 3 === 0 ? String(h) : '' });
    }
    return buckets;
  }
  if (period === 'week' || period === 'month') {
    const first = startOf(period, now);
    const days = period === 'week' ? 7 : new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    for (let i = 0; i < days; i++) {
      const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      const start = d.getTime();
      buckets.push({
        start,
        end: start + DAY,
        label: d.toLocaleDateString('en-US', { weekday: period === 'week' ? 'short' : undefined, month: 'short', day: 'numeric' }),
        tick: period === 'week' ? d.toLocaleDateString('en-US', { weekday: 'short' }) : i % 3 === 0 || i === days - 1 ? String(d.getDate()) : '',
      });
    }
    return buckets;
  }
  // Months: this calendar year, or (all time) from the first order, at most 24 months.
  const end = new Date(now);
  let first = period === 'year' ? new Date(end.getFullYear(), 0, 1) : new Date(firstTs || now);
  first = new Date(first.getFullYear(), first.getMonth(), 1);
  const monthsBack = (end.getFullYear() - first.getFullYear()) * 12 + end.getMonth() - first.getMonth();
  if (monthsBack > 23) first = new Date(end.getFullYear(), end.getMonth() - 23, 1);
  const count = period === 'year' ? 12 : Math.min(24, monthsBack + 1);
  for (let i = 0; i < count; i++) {
    const d = new Date(first.getFullYear(), first.getMonth() + i, 1);
    const next = new Date(first.getFullYear(), first.getMonth() + i + 1, 1);
    buckets.push({
      start: d.getTime(),
      end: next.getTime(),
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      tick: count > 12 ? (i % 3 === 0 ? d.toLocaleDateString('en-US', { month: 'short' }) : '') : d.toLocaleDateString('en-US', { month: 'short' }),
    });
  }
  return buckets;
}
