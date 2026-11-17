// Seller cabinet: sign in, open a shop, manage products, stock and reservations.
// This is the only page that loads the Supabase library (sign-in and photo upload).
// Every read and write below is limited to the seller's own shop by row-level security.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET, GOOGLE_SIGN_IN } from '../config';
import { BASE, esc, money, photoUrl, toast, sortSizes, waNumber, $ } from '../lib/api';
import { t } from '../i18n';
import { CATEGORIES, DISTRICTS, KINDS, statusBadge, when, errText, emptyBox, shopUrl } from '../lib/ui';

type ShopRow = { id: string; slug: string; name: string; kind: string; description: string | null; district: string | null; address: string | null; phone: string | null; whatsapp: string | null; instagram: string | null; working_hours: string | null; hold_hours: number; is_published: boolean; is_demo: boolean };
type VariantRow = { id: string; size: string; color: string; sort: number; quantity: number };
type ProductRow = { id: string; title: string; description: string | null; category: string; price: number; old_price: number | null; photos: string[]; is_active: boolean; variants: VariantRow[] };
type ResRow = { id: string; code: string; status: string; product_title: string; size: string; color: string; price: number; customer_name: string; customer_phone: string; note: string | null; expires_at: string; created_at: string };
type Draft = { id: string | null; title: string; description: string; category: string; price: string; old_price: string; photos: string[]; is_active: boolean; variants: { size: string; color: string; quantity: number }[] };

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = $('#app');
const here = `${location.origin}${BASE}seller/`;

let shops: ShopRow[] = [];
let shop: ShopRow | null = null;
let tab: 'res' | 'prod' | 'shop' = 'res';
let products: ProductRow[] = [];
let reservations: ResRow[] = [];
let draft: Draft | null = null;
let authMode: 'in' | 'up' = 'in';
let telegramOn = false;
let members = 0;
let inviteLink = '';
let timer = 0;

// Invite links (?invite=CODE) hand a shop to its real owner. The code waits in this
// phone until the person has signed in, then it is accepted once.
const INVITE_KEY = 'taila_invite';
(() => {
  const code = new URLSearchParams(location.search).get('invite');
  if (!code) return;
  try { localStorage.setItem(INVITE_KEY, code); } catch { /* private mode */ }
  history.replaceState(null, '', location.pathname);
})();
function pendingInvite(): string {
  try { return localStorage.getItem(INVITE_KEY) || ''; } catch { return ''; }
}

const field = (label: string, inner: string, hint = '') =>
  `<label class="field"><span>${esc(label)}</span>${inner}${hint ? `<span class="hint" style="font-weight:400">${hint}</span>` : ''}</label>`;
const options = (list: string[], current: string | null, label: (v: string) => string) =>
  list.map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label(v))}</option>`).join('');
const val = (sel: string) => (($(sel) as HTMLInputElement | null)?.value ?? '').trim();

function fail(e: unknown): void { toast(errText(e)); }

/** Supabase returns { message } on errors; our database functions put a short code there. */
function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.message });
  return res.data;
}

// ---------------- sign in ----------------
function authError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login')) return t('s.err.bad');
  if (m.includes('not confirmed')) return t('s.err.unconfirmed');
  if (m.includes('already registered')) return t('s.err.exists');
  if (m.includes('password')) return t('s.err.weak');
  if (m.includes('rate limit') || m.includes('security purposes')) return t('s.err.rate');
  if (m.includes('not authorized') || m.includes('sending')) return t('s.err.mail');
  return message;
}

function drawAuth(note = ''): void {
  app.innerHTML = `<div class="narrow">
    <h1 style="font-size:1.8rem">${esc(t('s.title'))}</h1>
    <p class="muted" style="margin-top:6px">${esc(t('s.sub'))}</p>
    <div class="panel">
      ${note ? `<p class="notice">${esc(note)}</p>` : ''}
      <form id="auth" novalidate>
        ${field(t('s.email'), '<input class="input" name="email" type="email" autocomplete="email" required>')}
        ${field(t('s.pass'), `<input class="input" name="password" type="password" minlength="8" autocomplete="${authMode === 'in' ? 'current-password' : 'new-password'}" required>`)}
        <p class="error" id="err" hidden></p>
        <button class="btn block" style="margin-top:16px" type="submit">${esc(t(authMode === 'in' ? 's.signin' : 's.signup'))}</button>
      </form>
      ${GOOGLE_SIGN_IN ? `<button class="btn ghost block" style="margin-top:10px" id="google" type="button">${esc(t('s.google'))}</button>` : ''}
      <button class="btn ghost block" style="margin-top:10px" id="mode" type="button">${esc(t(authMode === 'in' ? 's.to_up' : 's.to_in'))}</button>
    </div>
  </div>`;
}

async function submitAuth(form: HTMLFormElement): Promise<void> {
  const fd = new FormData(form);
  const email = String(fd.get('email') || '').trim();
  const password = String(fd.get('password') || '');
  const err = $('#err');
  const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
  err.hidden = true;
  if (!email || password.length < 8) { err.textContent = t(password.length < 8 ? 's.err.weak' : 's.err.bad'); err.hidden = false; return; }
  btn.disabled = true;
  const res = authMode === 'in'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password, options: { emailRedirectTo: here } });
  btn.disabled = false;
  if (res.error) { err.textContent = authError(res.error.message); err.hidden = false; return; }
  if (!res.data.session) { authMode = 'in'; drawAuth(t('s.sent', { e: email })); return; }
  // With a session, onAuthStateChange below takes over.
}

// ---------------- first shop ----------------
const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', ң: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ъ: '', ь: '' };
function slugify(name: string): string {
  return name.toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function drawOnboard(): void {
  app.innerHTML = `<div class="narrow">
    <h1 style="font-size:1.8rem">${esc(t('o.h'))}</h1>
    <form id="onboard" class="panel" novalidate>
      ${field(t('o.name'), '<input class="input" id="o-name" maxlength="60" required>')}
      ${field(t('o.slug'), '<input class="input" id="o-slug" maxlength="40" autocapitalize="none" spellcheck="false" required>', `taila.page/shop/?s=<b id="o-prev"></b>`)}
      ${field(t('o.kind'), `<select class="input" id="o-kind">${options(KINDS, 'shop', (k) => t(`kind.${k}`))}</select>`)}
      ${field(t('o.district'), `<select class="input" id="o-district">${options(DISTRICTS, 'Центр', (d) => d)}</select>`)}
      ${field(t('o.address'), '<input class="input" id="o-address" maxlength="160">')}
      ${field(t('o.phone'), '<input class="input" id="o-phone" type="tel" inputmode="tel" placeholder="0555 123 456" maxlength="20">')}
      ${field(t('o.ig'), '<input class="input" id="o-ig" maxlength="40" autocapitalize="none">')}
      <p class="error" id="err" hidden></p>
      <button class="btn block" style="margin-top:16px" type="submit">${esc(t('o.create'))}</button>
    </form>
    <button class="btn ghost block" style="margin-top:12px" id="signout" type="button">${esc(t('sh.out'))}</button>
  </div>`;
}

// ---------------- data ----------------
async function loadShops(): Promise<void> {
  const rows = check(await sb.from('shop_members').select('shops(*)')) as unknown as { shops: ShopRow | ShopRow[] | null }[];
  shops = rows.flatMap((r) => (Array.isArray(r.shops) ? r.shops : r.shops ? [r.shops] : []));
  let saved = '';
  try { saved = localStorage.getItem('taila_shop') || ''; } catch { /* ignore */ }
  shop = shops.find((s) => s.id === saved) || shops[0] || null;
}

async function loadReservations(): Promise<void> {
  if (!shop) return;
  reservations = check(await sb.from('reservations')
    .select('id,code,status,product_title,size,color,price,customer_name,customer_phone,note,expires_at,created_at')
    .eq('shop_id', shop.id).order('created_at', { ascending: false }).limit(100)) as ResRow[];
}

async function loadProducts(): Promise<void> {
  if (!shop) return;
  const rows = check(await sb.from('products')
    .select('id,title,description,category,price,old_price,photos,is_active,product_variants(id,size,color,sort,stock(quantity))')
    .eq('shop_id', shop.id).order('created_at', { ascending: false })) as any[];
  products = rows.map((p) => ({
    ...p,
    variants: (p.product_variants || []).map((v: any) => {
      const st = Array.isArray(v.stock) ? v.stock[0] : v.stock; // one-to-one, shape depends on the API
      return { id: v.id, size: v.size, color: v.color, sort: v.sort, quantity: st?.quantity ?? 0 };
    }).sort((a: VariantRow, b: VariantRow) => a.sort - b.sort),
  }));
}

// ---------------- dashboard ----------------
function drawDash(): void {
  if (!shop) return;
  const link = `${location.origin}${shopUrl(shop.slug)}`;
  const news = reservations.filter((r) => r.status === 'pending').length;
  app.innerHTML = `<div class="wrap" style="padding-top:18px;padding-bottom:70px">
    <div class="toolbar" style="margin-top:0">
      <h1 style="font-size:1.5rem;margin-right:auto">${esc(shop.name)} ${shop.is_demo ? `<span class="badge">${esc(t('demo'))}</span>` : ''}</h1>
      ${shops.length > 1 ? `<select class="input" id="switch" style="width:auto;min-height:40px">${shops.map((s) => `<option value="${esc(s.id)}"${s.id === shop!.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="linkbox"><code>${esc(link.replace(/^https?:\/\//, ''))}</code>
      <button class="btn small" id="copy" type="button" data-link="${esc(link)}">${esc(t('d.link.copy'))}</button>
      <a class="btn small ghost" href="${esc(link)}" target="_blank" rel="noopener">${esc(t('d.link.open'))}</a></div>
    <p class="hint">${esc(t('d.link.hint'))}</p>
    <div class="tabs" role="tablist">
      ${(['res', 'prod', 'shop'] as const).map((k) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${tab === k}">${esc(t(`tab.${k}`))}${k === 'res' && news ? ` <span class="badge warn">${news}</span>` : ''}</button>`).join('')}
    </div>
    <div id="body">${tab === 'res' ? resHtml() : tab === 'prod' ? prodHtml() : shopHtml()}</div>
  </div>`;
}

function resCard(r: ResRow): string {
  const wa = waNumber(r.customer_phone);
  const active = r.status === 'pending' || r.status === 'confirmed';
  return `<div class="row"><div class="grow">
    <div><b style="font-size:1.1rem">${esc(r.code)}</b> ${statusBadge(r.status, 'rs')}</div>
    <div style="margin-top:4px">${esc(r.product_title)}, <b>${esc(r.size)}</b>${r.color ? `, ${esc(r.color)}` : ''} — ${money(r.price)}</div>
    <div class="small" style="margin-top:4px">${esc(r.customer_name)},
      <a href="tel:${esc(r.customer_phone)}">${esc(r.customer_phone)}</a>${wa ? ` (<a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>)` : ''}</div>
    ${r.note ? `<div class="small muted">«${esc(r.note)}»</div>` : ''}
    <div class="small muted">${esc(active ? t('r.until', { d: when(r.expires_at) }) : when(r.created_at))}</div>
    ${active ? `<div class="stockline">
      ${r.status === 'pending' ? `<button class="btn small" data-res="${r.id}" data-to="confirmed">${esc(t('r.confirm'))}</button>` : ''}
      <button class="btn small ${r.status === 'pending' ? 'ghost' : ''}" data-res="${r.id}" data-to="picked_up">${esc(t('r.picked'))}</button>
      <button class="btn small danger" data-res="${r.id}" data-to="cancelled">${esc(t('r.cancel'))}</button>
    </div>` : ''}
  </div></div>`;
}

function resHtml(): string {
  if (reservations.length === 0) return emptyBox(t('r.empty.h'), t('r.empty.p'));
  const active = reservations.filter((r) => r.status === 'pending' || r.status === 'confirmed');
  const past = reservations.filter((r) => !active.includes(r)).slice(0, 30);
  return `${active.length ? `<div class="panel"><h3>${esc(t('r.new'))}</h3>${active.map(resCard).join('')}</div>` : ''}
    ${past.length ? `<div class="panel"><h3>${esc(t('r.history'))}</h3>${past.map(resCard).join('')}</div>` : ''}`;
}

function prodHtml(): string {
  const bar = `<div class="toolbar"><button class="btn" id="add" type="button">${esc(t('p.add'))}</button>
    ${products.length ? `<button class="btn ghost" id="confirm" type="button">${esc(t('p.confirm'))}</button>` : ''}</div>`;
  if (products.length === 0) return bar + emptyBox(t('p.empty.h'), t('p.empty.p'));
  return `${bar}<div class="panel">${products.map((p) => `<div class="row">
    <img class="thumb" src="${esc(photoUrl(p.photos[0], 's'))}" alt="" width="60" height="80" loading="lazy">
    <div class="grow">
      <div><b>${esc(p.title)}</b> ${p.is_active ? '' : `<span class="badge">${esc(t('p.hidden'))}</span>`}</div>
      <div class="small muted">${money(p.price)}</div>
      ${p.variants.map((v) => `<div class="stockline"><span class="tag mini">${esc(v.size)}</span>${v.color ? `<span class="small muted">${esc(v.color)}</span>` : ''}
        <span class="stepper"><button type="button" data-step="-1" data-variant="${v.id}" aria-label="−">−</button><output>${v.quantity}</output><button type="button" data-step="1" data-variant="${v.id}" aria-label="+">+</button></span></div>`).join('')}
      <button class="btn small ghost" style="margin-top:10px" data-edit="${p.id}" type="button">${esc(t('p.edit'))}</button>
    </div></div>`).join('')}</div>`;
}

function shopHtml(): string {
  const s = shop!;
  return `<form id="shopform" class="panel" novalidate>
    ${field(t('o.name'), `<input class="input" id="s-name" maxlength="60" value="${esc(s.name)}">`)}
    ${field(t('sh.desc'), `<textarea class="input" id="s-desc" maxlength="600">${esc(s.description || '')}</textarea>`)}
    ${field(t('o.kind'), `<select class="input" id="s-kind">${options(KINDS, s.kind, (k) => t(`kind.${k}`))}</select>`)}
    ${field(t('o.district'), `<select class="input" id="s-district">${options(DISTRICTS.includes(s.district || '') ? DISTRICTS : [s.district || '', ...DISTRICTS], s.district, (d) => d)}</select>`)}
    ${field(t('o.address'), `<input class="input" id="s-address" maxlength="160" value="${esc(s.address || '')}">`)}
    ${field(t('form.phone'), `<input class="input" id="s-phone" type="tel" maxlength="20" value="${esc(s.phone || '')}">`)}
    ${field('WhatsApp', `<input class="input" id="s-wa" type="tel" maxlength="20" value="${esc(s.whatsapp || '')}">`)}
    ${field(t('o.ig'), `<input class="input" id="s-ig" maxlength="40" autocapitalize="none" value="${esc(s.instagram || '')}">`)}
    ${field(t('sh.hours'), `<input class="input" id="s-hours" maxlength="80" value="${esc(s.working_hours || '')}">`)}
    ${field(t('sh.hold'), `<select class="input" id="s-hold">${options(['6', '12', '24', '48'].includes(String(s.hold_hours)) ? ['6', '12', '24', '48'] : [String(s.hold_hours), '6', '12', '24', '48'], String(s.hold_hours), (h) => h)}</select>`)}
    <label class="field" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="s-pub" ${s.is_published ? 'checked' : ''} style="width:22px;height:22px"><span style="margin:0">${esc(t('sh.pub'))}</span></label>
    <button class="btn block" style="margin-top:16px" type="submit">${esc(t('sh.save'))}</button>
  </form>
  <div class="panel"><h3>${esc(t('sh.tg.h'))}</h3>
    ${telegramOn ? `<p style="margin-top:8px"><span class="badge ok">${esc(t('sh.tg.on'))}</span></p>` : `<button class="btn ghost" style="margin-top:12px" id="tg" type="button">${esc(t('sh.tg.btn'))}</button><p class="hint" id="tg-note"></p>`}
  </div>
  <div class="panel"><h3>${esc(t('inv.h'))}</h3>
    <p class="small muted" style="margin-top:6px">${esc(t('inv.count', { n: members || 1 }))}</p>
    <p class="hint">${esc(t('inv.p'))}</p>
    ${inviteLink ? `<div class="linkbox"><code>${esc(inviteLink.replace(/^https?:\/\//, ''))}</code>
      <button class="btn small" id="inv-copy" type="button">${esc(t('d.link.copy'))}</button></div>
      <p class="hint">${esc(t('inv.once'))}</p>
      <a class="btn small ghost" style="margin-top:8px" href="https://wa.me/?text=${encodeURIComponent(t('inv.msg', { s: s.name, l: inviteLink }))}" target="_blank" rel="noopener">${esc(t('inv.wa'))}</a>`
    : `<button class="btn ghost" style="margin-top:12px" id="inv" type="button">${esc(t('inv.btn'))}</button>`}
    ${members > 1 ? `<button class="btn small danger" style="margin-top:12px;display:flex" id="leave" type="button">${esc(t('inv.leave'))}</button>` : ''}
  </div>
  <button class="btn ghost block" style="margin-top:14px" id="signout" type="button">${esc(t('sh.out'))}</button>`;
}

// ---------------- product editor ----------------
function drawEditor(): void {
  if (!draft) return;
  const d = draft;
  let sheet = $('#sheet');
  if (!sheet) { sheet = document.createElement('div'); sheet.id = 'sheet'; sheet.className = 'sheet'; document.body.appendChild(sheet); }
  const quick = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '42', '44', '46', '48', '50', '52', '36', '37', '38', '39', '40', t('e.one')];
  sheet.innerHTML = `<div class="sheet-head"><div class="wrap"><b>${esc(t(d.id ? 'e.edit' : 'e.new'))}</b>
      <button class="btn small ghost" id="e-close" type="button">${esc(t('e.close'))}</button></div></div>
    <form class="sheet-body" id="editor" novalidate>
      <div class="block-title">${esc(t('e.photos'))}</div>
      <div class="photos">
        ${d.photos.map((ph, i) => `<div class="slot"><img src="${esc(photoUrl(ph, 's'))}" alt=""><button type="button" data-rmphoto="${i}" aria-label="×">×</button></div>`).join('')}
        ${d.photos.length < 4 ? `<label class="add" aria-label="+">+<input type="file" id="e-file" accept="image/*" multiple hidden></label>` : ''}
      </div>
      ${field(t('e.title'), `<input class="input" id="e-title" maxlength="80" value="${esc(d.title)}">`)}
      ${field(t('e.cat'), `<select class="input" id="e-cat">${options(CATEGORIES, d.category, (c) => t(`cat.${c}`))}</select>`)}
      ${field(t('e.price'), `<input class="input" id="e-price" inputmode="numeric" maxlength="8" value="${esc(d.price)}">`)}
      ${field(t('e.old'), `<input class="input" id="e-old" inputmode="numeric" maxlength="8" value="${esc(d.old_price)}">`)}
      ${field(t('e.desc'), `<textarea class="input" id="e-desc" maxlength="1000">${esc(d.description)}</textarea>`)}
      <div class="block-title">${esc(t('e.sizes'))}</div>
      <p class="hint" style="margin:0 0 8px">${esc(t('e.quick'))}</p>
      <div class="tags">${quick.map((q) => `<button type="button" class="tag mini" style="min-height:34px;cursor:pointer" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div id="e-variants">${d.variants.map((v, i) => `<div class="vrow" data-i="${i}">
        <input class="input" data-f="size" maxlength="12" placeholder="${esc(t('e.size'))}" value="${esc(v.size)}">
        <input class="input" data-f="color" maxlength="30" placeholder="${esc(t('e.color'))}" value="${esc(v.color)}">
        <span class="stepper"><button type="button" data-vstep="-1">−</button><output>${v.quantity}</output><button type="button" data-vstep="1">+</button></span>
        <button type="button" class="iconbtn" data-rmvar="${i}" aria-label="×">×</button></div>`).join('')}</div>
      <button class="btn small ghost" style="margin-top:10px" id="e-addvar" type="button">${esc(t('e.addsize'))}</button>
      <label class="field" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="e-active" ${d.is_active ? 'checked' : ''} style="width:22px;height:22px"><span style="margin:0">${esc(t('e.active'))}</span></label>
      <p class="error" id="e-err" hidden></p>
      <button class="btn block" style="margin-top:16px" type="submit">${esc(t('e.save'))}</button>
      ${d.id ? `<button class="btn danger block" style="margin-top:10px" id="e-del" type="button">${esc(t('e.delete'))}</button>` : ''}
    </form>`;
}

/** Copy what is typed in the editor back into the draft before redrawing. */
function readEditor(): void {
  if (!draft || !$('#editor')) return;
  draft.title = val('#e-title'); draft.category = val('#e-cat'); draft.price = val('#e-price');
  draft.old_price = val('#e-old'); draft.description = val('#e-desc');
  draft.is_active = ($('#e-active') as HTMLInputElement).checked;
  document.querySelectorAll<HTMLElement>('#e-variants .vrow').forEach((row) => {
    const v = draft!.variants[Number(row.dataset.i)];
    if (!v) return;
    v.size = (row.querySelector('[data-f=size]') as HTMLInputElement).value.trim().toUpperCase();
    v.color = (row.querySelector('[data-f=color]') as HTMLInputElement).value.trim();
  });
}

function openEditor(p?: ProductRow): void {
  draft = p
    ? { id: p.id, title: p.title, description: p.description || '', category: p.category, price: String(p.price), old_price: p.old_price ? String(p.old_price) : '', photos: [...p.photos], is_active: p.is_active, variants: p.variants.map((v) => ({ size: v.size, color: v.color, quantity: v.quantity })) }
    : { id: null, title: '', description: '', category: 'dress', price: '', old_price: '', photos: [], is_active: true, variants: [] };
  drawEditor();
}
function closeEditor(): void { draft = null; $('#sheet')?.remove(); }

/** Shrink a photo in the phone before upload: WebP where the browser can, JPEG otherwise. */
async function shrink(file: File, max: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const toBlob = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  let blob = await toBlob('image/webp', 0.8);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.8);
  if (blob && blob.size > 550_000) blob = await toBlob(blob.type, 0.6);
  if (!blob) throw new Error('photo');
  return blob;
}

async function addPhotos(files: FileList): Promise<void> {
  if (!draft || !shop) return;
  readEditor();
  toast(t('e.uploading'));
  for (const file of Array.from(files).slice(0, 4 - draft.photos.length)) {
    try {
      const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      const large = await shrink(file, 1200);
      const small = await shrink(file, 400);
      const ext = large.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `${shop.id}/${key}_l.${ext}`;
      const store = sb.storage.from(PHOTO_BUCKET);
      const up1 = await store.upload(path, large, { contentType: large.type, cacheControl: '31536000' });
      const up2 = await store.upload(path.replace('_l.', '_s.'), small, { contentType: small.type, cacheControl: '31536000' });
      if (up1.error || up2.error) throw up1.error || up2.error;
      draft.photos.push(path);
    } catch { toast(t('e.err.photo')); }
  }
  drawEditor();
}

async function saveDraft(): Promise<void> {
  if (!draft || !shop) return;
  readEditor();
  const err = $('#e-err');
  const show = (m: string) => { err.textContent = m; err.hidden = false; };
  const price = Number(draft.price.replace(/\s/g, ''));
  const old = draft.old_price ? Number(draft.old_price.replace(/\s/g, '')) : null;
  const variants = draft.variants.filter((v) => v.size);
  if (draft.title.length < 2) return show(t('e.err.title'));
  if (!Number.isInteger(price) || price < 0 || (old !== null && !Number.isInteger(old))) return show(t('e.err.price'));
  if (variants.length === 0) return show(t('err.bad_variants'));
  const btn = $('#editor button[type=submit]') as HTMLButtonElement;
  btn.disabled = true;
  try {
    check(await sb.rpc('save_product', { p_shop_id: shop.id, p_product: { id: draft.id, title: draft.title, description: draft.description, category: draft.category, price, old_price: old, photos: draft.photos, is_active: draft.is_active, variants } }));
    closeEditor();
    toast(t('e.saved'));
    await loadProducts();
    drawDash();
  } catch (e) { show(errText(e)); btn.disabled = false; }
}

// ---------------- events ----------------
document.addEventListener('click', async (ev) => {
  const el = ev.target as HTMLElement;
  const hit = <T extends HTMLElement = HTMLElement>(sel: string) => el.closest<T>(sel);
  try {
    if (hit('#mode')) { authMode = authMode === 'in' ? 'up' : 'in'; drawAuth(); return; }
    if (hit('#google')) { await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here } }); return; }
    if (hit('#signout')) { await sb.auth.signOut(); return; }
    const tabBtn = hit('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab as typeof tab; drawDash(); void refresh(); return; }
    const copy = hit('#copy');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.link || ''); toast(t('d.link.copied')); return; }

    const res = hit('[data-res]');
    if (res) {
      (res as HTMLButtonElement).disabled = true;
      check(await sb.rpc('set_reservation_status', { p_id: res.dataset.res, p_status: res.dataset.to }));
      await loadReservations(); drawDash(); return;
    }
    const step = hit('[data-step]');
    if (step) {
      const v = products.flatMap((p) => p.variants).find((x) => x.id === step.dataset.variant);
      if (!v) return;
      const next = Math.max(0, Math.min(9999, v.quantity + Number(step.dataset.step)));
      if (next === v.quantity) return;
      v.quantity = next;
      (step.parentElement!.querySelector('output') as HTMLElement).textContent = String(next);
      check(await sb.from('stock').update({ quantity: next }).eq('variant_id', v.id));
      return;
    }
    if (hit('#confirm') && shop) { check(await sb.rpc('confirm_stock', { p_shop_id: shop.id })); toast(t('p.confirmed')); return; }
    if (hit('#add')) { openEditor(); return; }
    const edit = hit('[data-edit]');
    if (edit) { openEditor(products.find((p) => p.id === edit.dataset.edit)); return; }

    // inside the editor
    if (hit('#e-close')) { closeEditor(); return; }
    if (draft) {
      const quick = hit('[data-quick]');
      if (quick) { readEditor(); const s = quick.dataset.quick!; if (!draft.variants.some((v) => v.size === s && !v.color)) draft.variants.push({ size: s, color: '', quantity: 1 }); drawEditor(); return; }
      if (hit('#e-addvar')) { readEditor(); draft.variants.push({ size: '', color: '', quantity: 1 }); drawEditor(); return; }
      const rmv = hit('[data-rmvar]');
      if (rmv) { readEditor(); draft.variants.splice(Number(rmv.dataset.rmvar), 1); drawEditor(); return; }
      const rmp = hit('[data-rmphoto]');
      if (rmp) { readEditor(); draft.photos.splice(Number(rmp.dataset.rmphoto), 1); drawEditor(); return; }
      const vs = hit('[data-vstep]');
      if (vs) {
        const row = vs.closest<HTMLElement>('.vrow')!;
        const v = draft.variants[Number(row.dataset.i)];
        v.quantity = Math.max(0, Math.min(9999, v.quantity + Number(vs.dataset.vstep)));
        (row.querySelector('output') as HTMLElement).textContent = String(v.quantity);
        return;
      }
      const del = hit<HTMLButtonElement>('#e-del');
      if (del && draft.id) {
        if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = t('e.delete2'); return; }
        check(await sb.from('products').delete().eq('id', draft.id));
        closeEditor(); toast(t('e.deleted')); await loadProducts(); drawDash(); return;
      }
    }
    if (hit('#inv') && shop) {
      const code = check(await sb.rpc('create_shop_invite', { p_shop_id: shop.id })) as string;
      inviteLink = `${here}?invite=${code}`;
      drawDash(); return;
    }
    if (hit('#inv-copy')) { await navigator.clipboard.writeText(inviteLink); toast(t('d.link.copied')); return; }
    const leave = hit<HTMLButtonElement>('#leave');
    if (leave && shop) {
      if (!leave.dataset.sure) { leave.dataset.sure = '1'; leave.textContent = t('inv.leave2'); return; }
      check(await sb.rpc('leave_shop', { p_shop_id: shop.id }));
      try { localStorage.removeItem('taila_shop'); } catch { /* ignore */ }
      toast(t('inv.left')); await route(); return;
    }
    if (hit('#tg') && shop) {
      const url = check(await sb.rpc('telegram_connect_link', { p_shop_id: shop.id })) as string | null;
      if (url) window.open(url, '_blank', 'noopener'); else $('#tg-note').textContent = t('sh.tg.soon');
    }
  } catch (e) { fail(e); void refresh(); }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target as HTMLFormElement;
  ev.preventDefault();
  try {
    if (form.id === 'auth') { await submitAuth(form); return; }
    if (form.id === 'editor') { await saveDraft(); return; }
    if (form.id === 'onboard') {
      const err = $('#err');
      try {
        check(await sb.rpc('create_shop', { p_name: val('#o-name'), p_slug: val('#o-slug'), p_kind: val('#o-kind'), p_district: val('#o-district'), p_address: val('#o-address'), p_phone: val('#o-phone'), p_instagram: val('#o-ig') }));
        tab = 'prod';
        await route();
      } catch (e) { err.textContent = errText(e); err.hidden = false; }
      return;
    }
    if (form.id === 'shopform' && shop) {
      const patch = { name: val('#s-name'), description: val('#s-desc') || null, kind: val('#s-kind'), district: val('#s-district') || null, address: val('#s-address') || null, phone: val('#s-phone') || null, whatsapp: val('#s-wa') || null, instagram: val('#s-ig').replace(/^@/, '') || null, working_hours: val('#s-hours') || null, hold_hours: Number(val('#s-hold')), is_published: ($('#s-pub') as HTMLInputElement).checked };
      check(await sb.from('shops').update(patch).eq('id', shop.id));
      Object.assign(shop, patch);
      toast(t('sh.saved'));
      drawDash();
    }
  } catch (e) { fail(e); }
});

document.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.id === 'o-name') { const s = $('#o-slug') as HTMLInputElement; if (!s.dataset.touched) s.value = slugify(el.value); $('#o-prev').textContent = s.value; }
  if (el.id === 'o-slug') { el.dataset.touched = '1'; el.value = el.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); $('#o-prev').textContent = el.value; }
});
document.addEventListener('change', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.id === 'e-file' && el.files?.length) void addPhotos(el.files);
  if (el.id === 'switch') {
    shop = shops.find((s) => s.id === el.value) || shop;
    inviteLink = ''; members = 0;
    try { localStorage.setItem('taila_shop', shop!.id); } catch { /* ignore */ }
    void refresh(true);
  }
});

/** Reload what the open tab shows. New reservations are checked every 30 seconds. */
async function refresh(force = false): Promise<void> {
  if (!shop || draft) return;
  try {
    if (tab === 'res' || force) await loadReservations();
    if (tab === 'prod' || force) await loadProducts();
    if (tab === 'shop') {
      const row = check(await sb.from('shop_private').select('telegram_chat_id').eq('shop_id', shop.id).maybeSingle()) as { telegram_chat_id: number | null } | null;
      telegramOn = !!row?.telegram_chat_id;
      members = (check(await sb.rpc('shop_member_count', { p_shop_id: shop.id })) as number | null) || 1;
    }
    // Do not redraw while the seller is typing in the shop form.
    if (!(tab === 'shop' && document.activeElement && $('#shopform')?.contains(document.activeElement))) drawDash();
  } catch (e) { fail(e); }
}

async function acceptInvite(): Promise<void> {
  const code = pendingInvite();
  if (!code) return;
  try { localStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
  try {
    const got = check(await sb.rpc('accept_shop_invite', { p_code: code })) as { id: string; name: string };
    try { localStorage.setItem('taila_shop', got.id); } catch { /* ignore */ }
    toast(t('inv.joined', { s: got.name }));
  } catch (e) { toast(errText(e)); }
}

async function route(): Promise<void> {
  clearInterval(timer);
  const { data } = await sb.auth.getSession();
  if (!data.session) { shop = null; closeEditor(); drawAuth(pendingInvite() ? t('inv.signin') : ''); return; }
  try {
    await acceptInvite();
    await loadShops();
    if (!shop) { drawOnboard(); return; }
    await Promise.all([loadReservations(), loadProducts()]);
    drawDash();
    timer = window.setInterval(() => { if (tab === 'res' && !document.hidden) void refresh(); }, 30000);
  } catch (e) {
    app.innerHTML = emptyBox(errText(e), '', `<button class="btn small" type="button" onclick="location.reload()">${esc(t('retry'))}</button>`);
  }
}

let lastUser: string | null | undefined;
sb.auth.onAuthStateChange((_event, session) => {
  // Only react when the signed-in person changes (not on every token refresh).
  const user = session?.user.id ?? null;
  if (user === lastUser) return;
  lastUser = user;
  setTimeout(() => void route(), 0);
});
