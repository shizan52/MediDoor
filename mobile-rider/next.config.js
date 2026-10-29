/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mobile rider app talks to the same backend (port 8000) as the website
  // and the other mobile apps. Disable the optimizer so any localhost or
  // relative URL works without configuring remotePatterns for every dev
  // backend.
  images: { unoptimized: true },
};

module.exports = nextConfig;
