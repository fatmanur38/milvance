import type { Metadata } from 'next';

import './globals.css';
import { WalletProvider } from '@/lib/wallet/provider';

export const metadata: Metadata = {
  title: 'Milvance',
  description:
    'Local-payment-powered production finance. The buyer funds the work, not the supplier.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en">
      <body className="antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
