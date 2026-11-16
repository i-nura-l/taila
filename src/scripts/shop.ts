// Shop page: one call loads the shop and all its products with sizes.
import { rpc, esc, sortSizes, qs, waNumber, $, BASE } from '../lib/api';
import { t } from '../i18n';
import { card, emptyBox, errText, type Shop, type Variant } from '../lib/ui';

type Product = { id: string; title: string; price: number; old_price: number | null; category: string; photos: string[]; variants: Variant[] };
type Page = { shop: Shop; products: Product[] } | null;

const app = $('#app');
// The address comes from ?s=... (and later from a pretty path like /aika-style).
const slug = qs('s') || decodeURIComponent(location.pathname.replace(BASE, '').replace(/^shop\/?/, '').replace(/\/$/, ''));
let data: Page = null;
let size = '';

const inStock = (p: Product) => p.variants.filter((v) => v.qty > 0).map((v) => v.size);

function draw(): void {
  if (!data) return;
  const s = data.shop;
  const wa = waNumber(s.whatsapp || s.phone);
  const allSizes = sortSizes(data.products.flatMap(inStock));
  const list = data.products.filter((p) => (size ? inStock(p).includes(size) : true));
  document.title = `${s.name} — TAILA`;
  app.innerHTML = `
    <div class="shophead">
      <h1>${esc(s.name)} ${s.is_demo ? `<span class="badge">${esc(t('demo'))}</span>` : ''}</h1>
      <div class="meta">
        <span>${esc([t(`kind.${s.kind}`), s.district].filter(Boolean).join(', '))}</span>
        ${s.address ? `<span>${esc(s.address)}</span>` : ''}
        ${s.working_hours ? `<span>${esc(s.working_hours)}</span>` : ''}
      </div>
      ${s.description ? `<p style="margin-top:10px;max-width:60ch">${esc(s.description)}</p>` : ''}
      <div class="actions">
        ${wa ? `<a class="btn small" href="https://wa.me/${wa}" target="_blank" rel="noopener">${esc(t('shop.wa'))}</a>` : ''}
        ${s.phone ? `<a class="btn small ghost" href="tel:${esc(s.phone)}">${esc(t('shop.call'))}</a>` : ''}
        ${s.instagram ? `<a class="btn small ghost" href="https://instagram.com/${encodeURIComponent(s.instagram)}" target="_blank" rel="noopener">Instagram</a>` : ''}
      </div>
    </div>
    ${allSizes.length > 1 ? `<div class="scroller" style="padding-top:12px">
      <button type="button" class="chip" data-size="" aria-pressed="${size === ''}">${esc(t('shop.allsizes'))}</button>
      ${allSizes.map((x) => `<button type="button" class="tag" data-size="${esc(x)}" aria-pressed="${x === size}">${esc(x)}</button>`).join('')}
    </div>` : ''}
    ${data.products.length === 0 ? emptyBox(t('shop.empty'), '') : ''}
    ${data.products.length > 0 && list.length === 0 ? emptyBox(t('home.empty.h'), '') : ''}
    <div class="grid">${list.map((p) => card({ id: p.id, title: p.title, price: p.price, old_price: p.old_price, photo: p.photos[0], sizes: inStock(p) })).join('')}</div>`;
}

app.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-size]');
  if (b) { size = b.dataset.size || ''; draw(); return; }
  if ((ev.target as HTMLElement).closest('#retry')) void load();
});

async function load(): Promise<void> {
  try {
    data = slug ? await rpc<Page>('get_shop_page', { p_slug: slug }) : null;
    if (!data) {
      app.innerHTML = emptyBox(t('shop.notfound.h'), t('shop.notfound.p'), `<a class="btn small" href="${BASE}">${esc(t('home.link'))}</a>`);
      return;
    }
    draw();
  } catch (e) {
    app.innerHTML = emptyBox(errText(e), '', `<button class="btn small" id="retry" type="button">${esc(t('retry'))}</button>`);
  }
}
void load();
