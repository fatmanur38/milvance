'use client';

import { OrderList } from '@/components/orders/order-list';
import { CreateOrderForm } from '@/components/orders/order-forms';
import { WalletNotice } from '@/components/wallet/wallet-chip';
import { canSign } from '@/lib/wallet/controller';
import { useWallet } from '@/lib/wallet/provider';

export default function OrdersPage() {
  const { state } = useWallet();
  const wallet = state.address;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Orders</h1>
        <p className="text-sm text-muted">Every order this wallet is part of, in any role.</p>
      </div>
      <WalletNotice />
      {wallet && <OrderList wallet={wallet} />}
      {wallet && canSign(state) && <CreateOrderForm />}
    </div>
  );
}
