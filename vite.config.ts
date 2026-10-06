import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages cannot send response headers, so the production build carries
// its policy in a meta tag. Dev keeps Vite's inline bootstrap and is not covered.
function contentSecurityPolicy(supabaseUrl: string): Plugin {
  return {
    name: "pit-csp",
    apply: "build",
    transformIndexHtml(html) {
      const api = new URL(supabaseUrl);
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        `connect-src ${api.origin} wss://${api.host}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ");
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    // Project sites are served under /<repo>/; the deploy workflow sets BASE_PATH.
    base: process.env.BASE_PATH || "/",
    plugins: [
      react(),
      ...(env.VITE_SUPABASE_URL
        ? [contentSecurityPolicy(env.VITE_SUPABASE_URL)]
        : []),
    ],
    server: {
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/.data/**",
          "**/*.sqlite*",
        ],
      },
    },
    build: { sourcemap: false },
  };
});
