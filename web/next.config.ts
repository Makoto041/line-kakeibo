import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: `output: 'export'` was removed. On Vercel the static export produced
  // RSC flight files (e.g. `index.txt`) that browsers sometimes downloaded
  // during client navigation ("index.txt" download bug). Vercel runs Next.js
  // natively, so we let it handle RSC/routing and serverless API routes.
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
