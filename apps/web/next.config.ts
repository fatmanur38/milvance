import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source during development.
  transpilePackages: [
    '@milvance/anchor',
    '@milvance/shared',
    '@milvance/stellar',
    '@milvance/contract-bindings',
  ],
};

export default nextConfig;
