import { useApp } from '../../context/AppContext';
import { inRange, periodLabel, periodRange } from '../../lib/period';

const sumTotals = (list) => list.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
const isCounted = (o) => o.status !== 'refunded' && o.status !== 'cancelled';

/**
 * Order numbers for the chosen period (see lib/period.js) and the stores the current role
 * can see (`storeIds` is already scoped). Used by every dashboard and the Orders page.
 */
export function orderSummary(orders, period, now = Date.now()) {
  const range = periodRange(period, now);
  const inPeriod = orders.filter((o) => inRange(o.placedAt, range.start, range.end));
  const counted = inPeriod.filter(isCounted);
  const sales = sumTotals(counted);
  const previous = range.prevStart == null ? null : sumTotals(orders.filter((o) => isCounted(o) && inRange(o.placedAt, range.prevStart, range.prevEnd)));
  return {
    range,
    periodName: periodLabel(period),
    inPeriod,
    counted,
    sales,
    averageOrder: counted.length ? sales / counted.length : 0,
    // null when there's nothing to compare with (all time, or no sales last period)
    change: previous ? Math.round(((sales - previous) / previous) * 100) : null,
    waitingToShip: inPeriod.filter((o) => o.status === 'unfulfilled').length,
    refunds: inPeriod.reduce((sum, o) => sum + (Number(o.refunded) || 0), 0),
  };
}

export default function useDashboardData() {
  const { storeIds, stores, orders, products, clients, settings, period } = useApp();

  const visibleOrders = orders.filter((o) => storeIds.includes(o.storeId));
  const visibleProducts = products.filter((p) => storeIds.includes(p.storeId));
  const summary = orderSummary(visibleOrders, period);

  return {
    ...summary,
    period,
    visibleOrders,
    firstOrderAt: visibleOrders.length ? Math.min(...visibleOrders.map((o) => o.placedAt)) : null,
    visibleProducts,
    lowStock: visibleProducts.filter((p) => p.stock != null && p.stock < settings.lowStockThreshold).sort((a, b) => a.stock - b.stock),
    visibleStores: stores.filter((s) => storeIds.includes(s.id)),
    clients,
  };
}
