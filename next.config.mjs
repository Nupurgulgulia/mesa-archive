/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg and the PDF/OCR tooling are server-only Node packages
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  // Only this machine serves the app (see README): no image optimisation service needed
  images: { unoptimized: true },
};
export default nextConfig;
