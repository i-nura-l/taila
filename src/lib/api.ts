// Small helpers shared by the public pages. No libraries: public pages stay tiny.
import { SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET } from '../config';

/** Site root, always ending with "/". "/" on taila.page, "/taila/" on the test build. */
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');

export class ApiError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Call one database function. Each screen makes exactly one of these to load. */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ApiError('network');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body && body.message) || 'server');
  return body as T;
}

/** Photo address. "s" is the 400 px version for grids, "l" the 1,200 px one. */
export function photoUrl(path: string | null | undefined, size: 's' | 'l' = 's'): string {
  if (!path) return `${BASE}demo/placeholder.svg`;
  if (path.startsWith('demo/')) return BASE + path;
  const p = size === 's' ? path.replace('_l.', '_s.') : path;
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${p}`;
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function money(n: number): string {
  return `${Number(n).toLocaleString('ru-RU')} сом`;
}

const LETTERS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];
/** Sort sizes the way a shopper expects: XS…XXL first, then numbers, then the rest. */
export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string): [number, number] => {
    const i = LETTERS.indexOf(s);
    if (i >= 0) return [0, i];
    const n = parseFloat(s);
    if (!Number.isNaN(n)) return [1, n];
    return [2, 0];
  };
  return [...new Set(sizes)].sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    return ga - gb || va - vb || a.localeCompare(b);
  });
}

export function qs(name: string): string {
  return new URLSearchParams(location.search).get(name) || '';
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  return root.querySelector(sel) as T;
}

let toastTimer = 0;
export function toast(text: string): void {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.hidden = true; }, 2600);
}

/** Phone number as digits for wa.me links: "0555 12 34 56" -> "996555123456". */
export function waNumber(phone: string | null | undefined): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '0') d = '996' + d.slice(1);
  if (d.length === 9) d = '996' + d;
  return d;
}

// Reservation tokens live only in this phone: shoppers have no account.
const RES_KEY = 'taila_res';
export function savedTokens(): string[] {
  try { return JSON.parse(localStorage.getItem(RES_KEY) || '[]'); } catch { return []; }
}
export function saveToken(token: string): void {
  try { localStorage.setItem(RES_KEY, JSON.stringify([token, ...savedTokens()].slice(0, 20))); } catch { /* private mode */ }
}
