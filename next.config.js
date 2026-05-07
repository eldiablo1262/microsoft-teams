/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    proxyTimeout: 7200000, // 2h proxy timeout for long API calls
  },
  httpAgentOptions: {
    keepAlive: true,
  },
  // Rewrite dynamic file paths to API route (Next.js production doesn't serve
  // files created after build in public/)
  async rewrites() {
    return [
      { source: '/videos-generated/:path*', destination: '/api/media/videos-generated/:path*' },
      { source: '/audio-generated/:path*', destination: '/api/media/audio-generated/:path*' },
      { source: '/audio-temp/:path*', destination: '/api/media/audio-temp/:path*' },
      { source: '/meetings/:path*', destination: '/api/media/meetings/:path*' },
      { source: '/photos-uploaded/:path*', destination: '/api/media/photos-uploaded/:path*' },
    ]
  },
}

module.exports = nextConfig
