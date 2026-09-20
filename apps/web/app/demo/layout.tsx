import { QueryProvider } from '@/components/shell/providers';

/**
 * The tour lives outside the workspace shell on purpose — no navigation, no
 * wallet chip, nothing to connect — but it still reads the API, so it needs
 * the query client.
 */
export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
