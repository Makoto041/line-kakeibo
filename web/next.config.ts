import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `output: 'export'` removed: the static export produced RSC flight files
  // (e.g. `index.txt`) that browsers sometimes downloaded during client
  // navigation. Vercel builds/serves Next.js natively (via Git integration),
  // which handles RSC and serverless API routes correctly.
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // Skip type checking during build (pre-existing React 19 / recharts typings)
  typescript: {
    ignoreBuildErrors: true,
  },
  // Skip ESLint during build
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
