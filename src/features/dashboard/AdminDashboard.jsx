import { Card } from '../../components/ui/Card';
import LinkButton from '../../components/ui/LinkButton';
import PageHeader from '../../components/ui/PageHeader';
import { useApp } from '../../context/AppContext';
import { ChannelsCard, ClientsStat, DashboardActions, LowStockStat, OrdersStat, RecentOrdersCard, SalesChartCard, SalesStat } from './DashboardParts';
import LowStockCard from './LowStockCard';
import RecentActivityCard from './RecentActivityCard';
import StoreHealthList from './StoreHealthList';
import useDashboardData from './useDashboardData';

// Every store, every platform, plus integration health and the activity log.
export default function AdminDashboard() {
  const { money, go } = useApp();
  const data = useDashboardData();
  const stats = [
    [`Sales, ${data.periodName.toLowerCase()}`, money(data.sales)],
    ['Orders', data.counted.length],
    ['Total clients', data.clients.length],
    ['Low stock', data.lowStock.length],
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="All stores"
        description="Every connected Shopify, WooCommerce, Amazon, eBay and TikTok Shop store."
        actions={<DashboardActions data={data} title="All stores" stats={stats} />}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <SalesStat data={data} />
        <OrdersStat data={data} />
        <ClientsStat data={data} />
        <LowStockStat data={data} />
      </div>

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <SalesChartCard data={data} />
        <Card title="Integrations" action={<LinkButton onClick={() => go('integrations')}>Manage</LinkButton>}>
          <StoreHealthList stores={data.visibleStores} />
        </Card>
      </div>

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <ChannelsCard data={data} />
        <LowStockCard products={data.lowStock} />
      </div>

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <RecentOrdersCard data={data} />
        <RecentActivityCard />
      </div>
    </div>
  );
}
