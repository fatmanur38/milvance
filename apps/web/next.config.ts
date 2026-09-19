import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source during development.
  transpilePackages: ['@milvance/shared', '@milvance/stellar'],
};

export default nextConfig;
