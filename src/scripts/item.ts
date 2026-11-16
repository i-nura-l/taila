// Product page: choose a size, reserve it, get a slip with a code.
import { rpc, esc, money, photoUrl, qs, saveToken, sortSizes, toast, $, BASE } from '../lib/api';
import { t } from '../i18n';
import { slip, emptyBox, errText, freshness, shopUrl, type Shop, type Variant, type Reservation } from '../lib/ui';

type Product = { id: string; title: string; description: string | null; price: number; old_price: number | null; category: string; photos: string[]; variants: Variant[] };
type Data = { product: Product; shop: Shop } | null;

const app = $('#app');
const id = qs('id');
let data: Data = null;
let chosen: Variant | null = null;
let formOpen = false;
let done: Reservation | null = null;

function remembered(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function variantsSorted(p: Product): Variant[] {
  const order = sortSizes(p.variants.map((v) => v.size));
  return [...p.variants].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size));
}

function draw(): void {
  if (!data) return;
  const { product: p, shop: s } = data;
  const variants = variantsSorted(p);
  const anyStock = variants.some((v) => v.qty > 0);
  // Show how fresh the stock information is: for the chosen size, or the newest of all.
  const freshIso = chosen ? chosen.confirmed_at : variants.map((v) => v.confirmed_at).sort().pop();
  const fresh = freshness(freshIso);
  const photos = p.photos.length ? p.photos : [''];
  document.title = `${p.title} — ${s.name} — TAILA`;

  const sizeTags = variants.map((v) => {
    const label = esc(v.size) + (v.color ? ` <span class="small" style="font-weight:500">&nbsp;${esc(v.color)}</span>` : '');
    if (v.qty <= 0) return `<span class="tag off" aria-disabled="true">${label}</span>`;
    const last = v.qty === 1 ? ` <span class="small" style="font-weight:500">&nbsp;${esc(t('item.last'))}</span>` : '';
    return `<button type="button" class="tag" data-variant="${esc(v.id)}" aria-pressed="${chosen?.id === v.id}">${label}${last}</button>`;
  }).join('');

  const action = done ? '' : !anyStock
    ? `<button class="btn block" disabled>${esc(t('item.soldout'))}</button>`
    : formOpen && chosen
      ? `<form id="reserve" novalidate>
          <label class="field"><span>${esc(t('form.name'))}</span><input class="input" name="name" autocomplete="name" required value="${esc(remembered('taila_name'))}"></label>
          <label class="field"><span>${esc(t('form.phone'))}</span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0555 123 456" required value="${esc(remembered('taila_phone'))}"></label>
          <label class="field"><span>${esc(t('form.note'))}</span><input class="input" name="note" maxlength="200"></label>
          <p class="error" id="err" hidden></p>
          <button class="btn block" style="margin-top:16px" type="submit">${esc(t('form.send'))}</button>
          <p class="hint">${esc(t('item.hold', { h: s.hold_hours }))}</p>
        </form>`
      : `<button class="btn block" id="open" type="button">${esc(chosen ? t('item.reserve.size', { s: chosen.size }) : t('item.choose'))}</button>
         <p class="hint">${esc(t('item.hold', { h: s.hold_hours }))}</p>`;

  app.innerHTML = `<div class="item">
    <div class="gallery">${photos.map((ph, i) => `<img src="${esc(photoUrl(ph, 'l'))}" alt="${esc(p.title)}" width="600" height="800" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async">`).join('')}</div>
    <div>
      <a class="small" href="${shopUrl(s.slug)}">${esc(s.name)}${s.district ? `, ${esc(s.district)}` : ''}</a>
      <h1 style="font-size:1.6rem;margin-top:6px">${esc(p.title)}</h1>
      <div class="price">${money(p.price)}${p.old_price ? `<s>${money(p.old_price)}</s>` : ''}</div>
      ${s.is_demo ? `<p class="notice" style="margin-top:12px">${esc(t('demo.note'))}</p>` : ''}
      ${done ? slip(done, { heading: true }) + `<p style="margin-top:14px"><a href="${BASE}my/">${esc(t('slip.all'))}</a></p>` : `
        <div class="block-title">${esc(t('item.size'))}</div>
        <div class="tags">${sizeTags}</div>
        ${fresh.text ? `<p class="fresh"><span class="badge ${fresh.cls}">${esc(fresh.text)}</span></p>` : ''}`}
      ${p.description ? `<p style="margin-top:18px;max-width:60ch;white-space:pre-line">${esc(p.description)}</p>` : ''}
      ${action ? `<div class="reservebar"${formOpen ? ' style="position:static;border:0;padding:8px 0 0"' : ''}>${action}</div>` : ''}
    </div>
  </div>`;
}

app.addEventListener('click', async (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest('#retry')) { void load(); return; }
  const tag = target.closest<HTMLElement>('[data-variant]');
  if (tag && data) {
    chosen = data.product.variants.find((v) => v.id === tag.dataset.variant) || null;
    draw();
    return;
  }
  if (target.closest('#open')) {
    if (!chosen) { toast(t('item.choose')); return; }
    formOpen = true;
    draw();
    ($('#reserve input[name=name]') as HTMLInputElement | null)?.focus();
    return;
  }
  const cancel = target.closest<HTMLButtonElement>('[data-cancel]');
  if (cancel) {
    if (!cancel.dataset.sure) { cancel.dataset.sure = '1'; cancel.textContent = t('slip.cancel2'); return; }
    cancel.disabled = true;
    try {
      await rpc('cancel_reservation', { p_token: cancel.dataset.cancel });
      toast(t('slip.cancelled'));
      done = null; formOpen = false; chosen = null;
      void load();
    } catch (e) { toast(errText(e)); cancel.disabled = false; }
  }
});

app.addEventListener('submit', async (ev) => {
  const form = (ev.target as HTMLElement).closest<HTMLFormElement>('#reserve');
  if (!form || !chosen) return;
  ev.preventDefault();
  const fd = new FormData(form);
  const name = String(fd.get('name') || '').trim();
  const phone = String(fd.get('phone') || '').trim();
  const err = $('#err');
  const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
  btn.disabled = true;
  err.hidden = true;
  try {
    done = await rpc<Reservation>('reserve_item', {
      p_variant_id: chosen.id, p_name: name, p_phone: phone, p_note: String(fd.get('note') || ''),
    });
    saveToken(done.token);
    try { localStorage.setItem('taila_name', name); localStorage.setItem('taila_phone', phone); } catch { /* private mode */ }
    draw();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
    btn.disabled = false;
    // Someone else took the last piece: refresh sizes so the tag shows as gone.
    if ((e as { code?: string }).code === 'out_of_stock') { formOpen = false; chosen = null; setTimeout(() => void load(), 1800); }
  }
});

async function load(): Promise<void> {
  try {
    data = /^[0-9a-f-]{36}$/i.test(id) ? await rpc<Data>('get_item', { p_id: id }) : null;
    if (!data) {
      app.innerHTML = emptyBox(t('item.notfound.h'), t('item.notfound.p'), `<a class="btn small" href="${BASE}">${esc(t('home.link'))}</a>`);
      return;
    }
    // If only one size is in stock, choose it for the shopper.
    const avail = data.product.variants.filter((v) => v.qty > 0);
    if (!chosen && avail.length === 1) chosen = avail[0];
    draw();
  } catch (e) {
    app.innerHTML = emptyBox(errText(e), '', `<button class="btn small" id="retry" type="button">${esc(t('retry'))}</button>`);
  }
}
void load();
