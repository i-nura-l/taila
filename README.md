# TAILA

Free, phone-first shop pages for Bishkek clothing sellers: real sizes in stock, the date
stock was last confirmed, and a reserve button.

## What is here

| Path | What it is |
| --- | --- |
| `src/pages/index.astro` | Home: choose a size, search across shops |
| `src/pages/shop.astro` | Public shop page, `/shop/?s=<address>` |
| `src/pages/item.astro` | Product page with the reserve form, `/item/?id=<id>` |
| `src/pages/my.astro` | A shopper's reservations (kept in their phone, no account) |
| `src/pages/seller.astro` | Seller cabinet: sign in, products, stock, reservations |
| `src/scripts/` | The code behind each page |
| `src/lib/api.ts`, `src/lib/ui.ts` | Shared helpers (database calls, product card, reservation slip) |
| `src/i18n.ts` | All interface text, Russian and Kyrgyz |
| `supabase/migrations/` | The database: tables, row-level security, functions |
| `supabase/functions/telegram-webhook/` | Telegram bot webhook (not deployed yet) |

## Run it on your computer

```bash
npm install        # also creates package-lock.json: commit that file
npm run dev        # http://localhost:4321
```

## How it fits together

- No server of our own. Pages are plain HTML from a CDN; the browser calls database
  functions in Supabase. Public pages make one call per screen and load no libraries.
- Shoppers never read tables. Only functions such as `search_items`, `get_shop_page`
  and `reserve_item` are open to them.
- `reserve_item` takes a piece out of stock and writes the reservation in one atomic
  step, so two people cannot reserve the last piece.
- Sellers read and change only their own shop (row-level security on every table).
- Shoppers see "in stock / last one", not exact counts.

## Deploy

- Test build: every push to `main` is built by GitHub Actions and published to the
  `gh-pages` branch.
- Production: Cloudflare Pages, build command `npm run build`, output folder `dist`,
  no environment variables needed. Then attach `taila.page`.

## Known temporary choices

- Photos are in Supabase Storage for now; move to Cloudflare R2 before real traffic
  (`photoUrl` in `src/lib/api.ts` and `addPhotos` in `src/scripts/seller.ts` are the only places to change).
- Shop links use `?s=`; pretty links (`taila.page/<shop>`) come with Cloudflare.
- Demo shops are marked `is_demo`. Remove them with `delete from shops where is_demo;`.
