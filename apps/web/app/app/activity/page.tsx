import { ActivityView } from '@/components/orders/activity-view';

export default function ActivityPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-muted">
          MilvanceCore contract events on Stellar Testnet, newest first, as indexed from the chain.
        </p>
      </div>
      <ActivityView />
    </div>
  );
}
