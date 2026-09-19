'use client';

import { useState } from 'react';
import { useWallet } from '@/lib/wallet/provider';
import { explorerTransaction, testnetDeployment } from '@/lib/wallet/config';

export default function WalletPage(): React.ReactElement {
  const { controller, state } = useWallet();
  const [supplier, setSupplier] = useState('');
  const [attestor, setAttestor] = useState('');
  const [resolver, setResolver] = useState('');
  const connected = Boolean(state.address);
  const pending = [
    'connecting',
    'preparing-transaction',
    'awaiting-wallet-signature',
    'submitted',
    'confirming',
  ].includes(state.phase);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <a href="/" className="text-sm underline">
        ← Milvance
      </a>
      <h1 className="text-3xl font-semibold">Stellar wallet</h1>
      <p className="text-sm opacity-80">
        Connect Freighter on Stellar Testnet. Your wallet signs contract actions directly; Milvance
        does not receive your secret key.
      </p>

      <section className="rounded-lg border p-5" aria-label="Wallet connection">
        <h2 className="text-lg font-medium">Connection</h2>
        <p className="mt-2 text-sm" role="status">
          Status: {state.phase.replaceAll('-', ' ')}
        </p>
        {state.address && <p className="mt-2 break-all text-sm">Address: {state.address}</p>}
        <p className="mt-2 text-sm">Network: Stellar Testnet</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {connected ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => void controller.disconnect()}
                className="rounded bg-black px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-black"
              >
                Disconnect
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void controller.refresh()}
                className="rounded border px-4 py-2 disabled:opacity-40"
              >
                Refresh wallet status
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => void controller.connect()}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Connect Freighter
            </button>
          )}
        </div>
        {state.phase === 'wrong-network' && (
          <p className="mt-4 text-sm text-red-600">
            Select Testnet in Freighter, then refresh wallet status. Transactions are blocked until
            it matches.
          </p>
        )}
        {state.trustline === 'missing' && (
          <p className="mt-4 text-sm">
            USDC trustline required for future USDC transfers. Add a USDC trustline in your wallet
            using issuer <span className="break-all font-mono">{testnetDeployment.usdcIssuer}</span>
            , then refresh. Creating an order does not move USDC.
          </p>
        )}
        {state.trustline === 'unfunded' && (
          <p className="mt-4 text-sm">
            This Testnet account is not funded. Fund it with the Stellar Testnet Friendbot, then add
            the approved USDC trustline in Freighter and refresh.
          </p>
        )}
        {state.trustline === 'present' && (
          <p className="mt-4 text-sm">Approved Testnet USDC trustline found.</p>
        )}
        {state.message && (
          <p className="mt-4 text-sm text-red-600" role="alert">
            {state.message}
          </p>
        )}
        {state.detail && (
          <details className="mt-2 text-xs">
            <summary>Error details</summary>
            <p className="break-all">{state.detail}</p>
          </details>
        )}
      </section>

      <section className="rounded-lg border p-5" aria-label="Create test order">
        <h2 className="text-lg font-medium">Create a Testnet order</h2>
        <p className="mt-2 text-sm opacity-80">
          This creates an empty order under your buyer address. It does not lock funds, send an
          advance, or change Phase 1 economics. Provide three different classic Stellar addresses
          for the other roles.
        </p>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.createOrder({
              supplier: supplier.trim(),
              attestor: attestor.trim(),
              resolver: resolver.trim(),
            });
          }}
        >
          <label className="text-sm">
            Supplier public address
            <input
              required
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
              className="mt-1 w-full rounded border bg-transparent p-2 font-mono text-xs"
              placeholder="G..."
            />
          </label>
          <label className="text-sm">
            Attestor public address
            <input
              required
              value={attestor}
              onChange={(event) => setAttestor(event.target.value)}
              className="mt-1 w-full rounded border bg-transparent p-2 font-mono text-xs"
              placeholder="G..."
            />
          </label>
          <label className="text-sm">
            Resolver public address
            <input
              required
              value={resolver}
              onChange={(event) => setResolver(event.target.value)}
              className="mt-1 w-full rounded border bg-transparent p-2 font-mono text-xs"
              placeholder="G..."
            />
          </label>
          <button
            type="submit"
            disabled={
              !connected ||
              pending ||
              state.phase === 'wrong-network' ||
              state.trustline === 'unfunded'
            }
            className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            Simulate and sign order
          </button>
        </form>
        {state.transactionHash && (
          <p className="mt-4 break-all text-sm">
            Transaction:{' '}
            <a
              className="underline"
              href={explorerTransaction(state.transactionHash)}
              target="_blank"
              rel="noreferrer"
            >
              {state.transactionHash}
            </a>
          </p>
        )}
        {state.order && (
          <div className="mt-4 rounded border p-3 text-sm">
            <p>Confirmed from MilvanceCore: order #{state.order.id}</p>
            <p>
              Buyer: <span className="break-all font-mono">{state.order.buyer}</span>
            </p>
            <p>
              Supplier: <span className="break-all font-mono">{state.order.supplier}</span>
            </p>
            <p>State: {state.order.status}</p>
          </div>
        )}
      </section>
      <p className="break-all text-xs opacity-60">Contract: {testnetDeployment.contractId}</p>
      <details className="text-xs">
        <summary>Technical details</summary>
        <p>RPC: {testnetDeployment.rpcUrl}</p>
        <p>USDC SAC: {testnetDeployment.usdcAssetContractId}</p>
      </details>
    </main>
  );
}
