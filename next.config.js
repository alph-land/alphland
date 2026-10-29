/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Remove hardcoded API URL - use proxy instead
  // env: {
  //   NEXT_PUBLIC_API_URL: "https://api.alph.land",
  // },
  swcMinify: true,
  compiler: {
    styledComponents: true,
  },
  webpack(config) {
    const fileLoaderRule = config.module.rules.find(
      (rule) => rule.test && rule.test.test(".svg"),
    );
    fileLoaderRule.exclude = /\.icon\.svg$/;
    config.module.rules.push({
      test: /\.icon\.svg$/,
      loader: require.resolve("@svgr/webpack"),
    });
    config.resolve.fallback = {
      // if you miss it, all the other options in fallback, specified
      // by next.js will be dropped.
      ...config.resolve.fallback,

      fs: false, // the solution
    };
    return config;
  },
  images: {
    domains: [
      "pbs.twimg.com",
      "mintsquare.sfo3.cdn.digitaloceanspaces.com",
      "lh3.googleusercontent.com", // Google profile pictures
    ],
  },
  experimental: {
    scrollRestoration: true,
  },
  async rewrites() {
    // Worker URL for API proxy (development: localhost:8787, production: same domain)
    const workerUrl =
      process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:8787";

    return [
      // Proxy all /api/* requests to Cloudflare Worker
      // This ensures cookies are set on the same domain as the frontend
      {
        source: "/api/:path*",
        destination: `${workerUrl}/api/:path*`,
      },
      {
        source: "/admin",
        destination: "/admin/index.html",
      },
      {
        source: "/submit",
        destination: "/submit/index.html",
      },
      {
        source: "/report",
        destination: "/report/index.html",
      },
      {
        source: "/config.yml",
        destination: "/admin/config.yml",
      },
      {
        source: "/x/js/script.js",
        destination: "https://plausible.io/js/script.js",
      },
      {
        source: "/x/api/event",
        destination: "https://plausible.io/api/event",
      },
    ];
  },
};

module.exports = nextConfig;
