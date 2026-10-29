/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mobile app talks to the same backend (port 8000) as the website + may
  // load images directly from there. We disable the optimizer so any
  // localhost/relative URL works without configuring remotePatterns for
  // every dev backend.
  images: { unoptimized: true },
};

module.exports = nextConfig;
