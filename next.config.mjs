/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Runs on Vercel as a full Next.js app: pages plus the API routes in src/app/api
  // (WooCommerce sync, webhooks, admin user management).
  images: { unoptimized: true },
};

export default nextConfig;
