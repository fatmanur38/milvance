import type { Metadata } from 'next';

import { AppShell } from '@/components/shell/app-shell';
import { QueryProvider } from '@/components/shell/providers';

export const metadata: Metadata = {
  title: 'Milvance workspace',
  description: 'Protected production milestones, working capital and local payments on Stellar.',
};

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <AppShell>{children}</AppShell>
    </QueryProvider>
  );
}
