// Web app manifest, generated so that paths follow the site base.
export function GET() {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return new Response(JSON.stringify({
    name: 'TAILA', short_name: 'TAILA', lang: 'ru', start_url: base, scope: base,
    display: 'standalone', background_color: '#FBFAFD', theme_color: '#644C7D',
    icons: [
      { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
    ],
  }), { headers: { 'Content-Type': 'application/manifest+json' } });
}
