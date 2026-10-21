import { ShoppingCart } from 'lucide-react';
import { Card, StatCard } from '../../components/ui/Card';
import PageHeader from '../../components/ui/PageHeader';
import { useApp } from '../../context/AppContext';
import { DashboardActions, LowStockStat, OrdersStat, RecentOrdersCard, SalesChartCard, SalesStat } from './DashboardParts';
import LowStockCard from './LowStockCard';
import StoreHealthList from './StoreHealthList';
import useDashboardData from './useDashboardData';

// Only the stores in the manager's group (narrowed further by the filter bar above).
// Managers can't see client accounts, so the third card stays "Average order".
export default function ManagerDashboard() {
  const { money, groups, user } = useApp();
  const data = useDashboardData();
  const groupName = groups.find((g) => g.id === user.groupId)?.name || 'Your';
  const stats = [
    [`Sales, ${data.periodName.toLowerCase()}`, money(data.sales)],
    ['Orders', data.counted.length],
    ['Average order', money(data.averageOrder)],
    ['Low stock', data.lowStock.length],
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title={`${groupName} group`}
        description="Stores assigned to you. Use the filter to focus on a few."
        actions={<DashboardActions data={data} title={`${groupName} group`} stats={stats} />}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <SalesStat data={data} />
        <OrdersStat data={data} />
        <StatCard label="Average order" value={money(data.averageOrder)} hint={`${data.visibleStores.length} stores`} icon={ShoppingCart} />
        <LowStockStat data={data} />
      </div>

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <SalesChartCard data={data} />
        <Card title="Store connections">
          <StoreHealthList stores={data.visibleStores} />
        </Card>
      </div>

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <RecentOrdersCard data={data} />
        <LowStockCard products={data.lowStock} />
      </div>
    </div>
  );
}
