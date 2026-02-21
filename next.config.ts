import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@upstash/redis', '@vercel/blob'],
};

export default nextConfig;
