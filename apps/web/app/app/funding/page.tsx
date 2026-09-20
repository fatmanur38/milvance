'use client';

import { FundingView } from '@/components/funding/funding-view';
import { useWallet } from '@/lib/wallet/provider';

export default function FundingPage() {
  const { state } = useWallet();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Funding</h1>
        <p className="text-sm text-muted">
          Advance working capital to suppliers against milestones buyers have already protected.
        </p>
      </div>
      <FundingView wallet={state.address} />
    </div>
  );
}
