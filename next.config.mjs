/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Runs on Vercel as a full Next.js app: pages plus the API routes in src/app/api
  // (WooCommerce sync, webhooks, admin user management).
  images: { unoptimized: true },
  // The browser needs the project URL and publishable key. Accept either naming
  // (NEXT_PUBLIC_SUPABASE_* or SUPABASE_*). Never add the secret key here.
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '',
  },
};

export default nextConfig;
