// Pieces of interface shared by several pages.
import { BASE, esc, money, photoUrl, sortSizes, waNumber } from './api';
import { t } from '../i18n';

export const CATEGORIES = ['dress', 'outerwear', 'top', 'bottom', 'shoes', 'kids', 'national', 'accessory', 'other'];
export const KINDS = ['shop', 'stall', 'sewing'];
// Assumption to check with sellers: do shoppers think in markets or in city districts?
export const DISTRICTS = ['Центр', 'Дордой', 'Ош базары', 'Аламедин', 'Мадина', 'Орто-Сай', 'Джал', 'Асанбай', 'Восток-5', 'Другое'];

export type Shop = {
  id: string; slug: string; name: string; kind: string; description: string | null;
  city: string; district: string | null; address: string | null; phone: string | null;
  whatsapp: string | null; instagram: string | null; working_hours: string | null;
  hold_hours: number; is_demo: boolean;
};
export type Variant = { id: string; size: string; color: string; qty: number; confirmed_at: string };
export type Reservation = {
  token: string; code: string; status: string; title: string; size: string; color: string;
  price: number; expires_at: string; created_at: string; product_id: string | null;
  photo?: string | null; shop: Shop;
};

export const shopUrl = (slug: string) => `${BASE}shop/?s=${encodeURIComponent(slug)}`;
export const itemUrl = (id: string) => `${BASE}item/?id=${encodeURIComponent(id)}`;

/** One product tile. Fixed 3:4 box so the page does not jump while photos load. */
export function card(p: { id: string; title: string; price: number; old_price?: number | null; photo?: string | null; sizes: string[]; sub?: string }): string {
  const sizes = sortSizes(p.sizes);
  const shown = sizes.slice(0, 5).map((s) => `<span class="tag mini">${esc(s)}</span>`).join('');
  const more = sizes.length > 5 ? `<span class="tag mini">+${sizes.length - 5}</span>` : '';
  return `<a class="card" href="${itemUrl(p.id)}">
    <div class="ph"><img src="${esc(photoUrl(p.photo, 's'))}" alt="" width="300" height="400" loading="lazy" decoding="async"></div>
    <div class="t">${esc(p.title)}</div>
    <div class="p">${money(p.price)}${p.old_price ? `<s>${money(p.old_price)}</s>` : ''}</div>
    ${p.sub ? `<div class="s">${esc(p.sub)}</div>` : ''}
    <div class="tags">${shown}${more}</div>
  </a>`;
}

export function skeleton(n = 6): string {
  return Array.from({ length: n }, () => '<div class="card skeleton"><div class="ph"></div></div>').join('');
}

export function emptyBox(title: string, text: string, action = ''): string {
  return `<div class="empty"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`;
}

/** Turn an error code from the database into a sentence the person can act on. */
export function errText(e: unknown): string {
  const code = (e as { code?: string; message?: string })?.code || (e as Error)?.message || 'server';
  const key = `err.${code}`;
  const text = t(key);
  return text === key ? t('err.server') : text;
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** "Stock confirmed today / N days ago". Older than a week is shown as a warning. */
export function freshness(iso: string | undefined): { text: string; cls: string } {
  if (!iso) return { text: '', cls: '' };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return { text: t('fresh.today'), cls: 'ok' };
  if (days === 1) return { text: t('fresh.yesterday'), cls: 'ok' };
  if (days <= 7) return { text: t('fresh.days', { n: days }), cls: '' };
  return { text: t('fresh.old'), cls: 'warn' };
}

const STATUS_CLS: Record<string, string> = { pending: 'warn', confirmed: 'ok', picked_up: '', cancelled: 'bad', expired: 'bad' };
export function statusBadge(status: string, prefix: 'st' | 'rs' = 'st'): string {
  return `<span class="badge ${STATUS_CLS[status] || ''}">${esc(t(`${prefix}.${status}`))}</span>`;
}

/** The reservation slip a shopper shows in the shop. */
export function slip(r: Reservation, opts: { heading?: boolean } = {}): string {
  const s = r.shop;
  const active = r.status === 'pending' || r.status === 'confirmed';
  const wa = waNumber(s.whatsapp || s.phone);
  const msg = encodeURIComponent(`Здравствуйте! Бронь ${r.code} на TAILA: ${r.title}, размер ${r.size}.`);
  const where = [s.district, s.address].filter(Boolean).join(', ');
  return `<div class="slip" data-token="${esc(r.token)}">
    ${opts.heading ? `<h2>${esc(t('slip.title'))}</h2><p class="muted small" style="margin-top:4px">${esc(t('slip.say'))}</p>` : ''}
    <div class="code">${esc(r.code)}</div>
    <div>${statusBadge(r.status)}</div>
    <dl>
      <dt>${esc(t('slip.item'))}</dt><dd>${esc(r.title)}, ${esc(r.size)}${r.color ? `, ${esc(r.color)}` : ''}</dd>
      <dt>${esc(t('slip.price'))}</dt><dd>${money(r.price)}</dd>
      ${active ? `<dt>${esc(t('slip.until'))}</dt><dd>${esc(when(r.expires_at))}</dd>` : ''}
      <dt>${esc(t('slip.shop'))}</dt><dd><a href="${shopUrl(s.slug)}">${esc(s.name)}</a></dd>
      ${where ? `<dt>${esc(t('slip.where'))}</dt><dd>${esc(where)}</dd>` : ''}
      ${s.working_hours ? `<dt>${esc(t('slip.hours'))}</dt><dd>${esc(s.working_hours)}</dd>` : ''}
    </dl>
    ${active ? `<div class="actions">
      ${wa ? `<a class="btn small" href="https://wa.me/${wa}?text=${msg}" target="_blank" rel="noopener">${esc(t('slip.wa'))}</a>` : ''}
      ${s.address ? `<a class="btn small ghost" href="https://2gis.kg/bishkek/search/${encodeURIComponent(s.address)}" target="_blank" rel="noopener">${esc(t('slip.map'))}</a>` : ''}
      <button class="btn small danger" data-cancel="${esc(r.token)}">${esc(t('slip.cancel'))}</button>
    </div>` : ''}
  </div>`;
}
