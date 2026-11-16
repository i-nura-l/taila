import { defineConfig } from 'astro/config';

// SITE_BASE is only set for the GitHub Pages test build (/taila/).
// On Cloudflare Pages with taila.page the site lives at "/".
export default defineConfig({
  site: process.env.SITE_URL || 'https://taila.page',
  base: process.env.SITE_BASE || '/',
  output: 'static',
  build: { inlineStylesheets: 'always' },
});
