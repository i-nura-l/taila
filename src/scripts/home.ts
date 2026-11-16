// Home page: one database call returns the items and the filter choices.
import { rpc, esc, sortSizes, qs, $ } from '../lib/api';
import { t } from '../i18n';
import { card, skeleton, emptyBox, errText, CATEGORIES, shopUrl } from '../lib/ui';

type Item = { id: string; title: string; price: number; old_price: number | null; photo: string | null; shop_name: string; shop_slug: string; district: string | null; sizes: string[] };
type Facets = { sizes: string[]; districts: string[]; shops: { slug: string; name: string; district: string | null; kind: string; count: number }[] };
type Result = { items: Item[]; facets: Facets | null };

const PAGE = 24;
const state = { q: qs('q'), size: qs('size'), district: qs('district'), category: qs('cat'), offset: 0 };
const grid = $('#grid');
const summary = $('#summary');
const moreWrap = $('#more-wrap');
let facetsDrawn = false;
let requestNo = 0;

function chip(label: string, value: string, group: string, current: string, cls = 'chip'): string {
  return `<button type="button" class="${cls}" data-group="${group}" data-value="${esc(value)}" aria-pressed="${value === current}">${esc(label)}</button>`;
}

function drawFacets(f: Facets): void {
  $('#sizes').innerHTML = sortSizes(f.sizes).map((s) => chip(s, s, 'size', state.size, 'tag')).join('');
  $('#cats').innerHTML = chip(t('all'), '', 'category', state.category) +
    CATEGORIES.map((c) => chip(t(`cat.${c}`), c, 'category', state.category)).join('');
  $('#districts').innerHTML = f.districts.length > 1
    ? chip(t('home.alld'), '', 'district', state.district) + f.districts.map((d) => chip(d, d, 'district', state.district)).join('')
    : '';
  $('#shops').innerHTML = f.shops.map((s) => `<a class="shoprow" href="${shopUrl(s.slug)}">
      <span><b>${esc(s.name)}</b><span class="small muted">${esc([t(`kind.${s.kind}`), s.district].filter(Boolean).join(', '))}</span></span>
      <span class="small muted">${esc(t('home.items', { n: s.count }))}</span></a>`).join('');
  facetsDrawn = true;
}

function syncUrl(): void {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.size) p.set('size', state.size);
  if (state.district) p.set('district', state.district);
  if (state.category) p.set('cat', state.category);
  const s = p.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

function markPressed(): void {
  document.querySelectorAll<HTMLElement>('[data-group]').forEach((b) => {
    const key = b.dataset.group as 'size' | 'district' | 'category';
    b.setAttribute('aria-pressed', String(b.dataset.value === state[key]));
  });
}

async function load(reset: boolean): Promise<void> {
  const mine = ++requestNo;
  if (reset) { state.offset = 0; grid.innerHTML = skeleton(); }
  try {
    const r = await rpc<Result>('search_items', {
      p_q: state.q, p_size: state.size, p_district: state.district, p_category: state.category,
      p_limit: PAGE, p_offset: state.offset,
    });
    if (mine !== requestNo) return; // a newer search has started
    if (r.facets && !facetsDrawn) drawFacets(r.facets);
    const html = r.items.map((i) => card({ ...i, sub: [i.shop_name, i.district].filter(Boolean).join(', ') })).join('');
    if (reset) grid.innerHTML = html; else grid.insertAdjacentHTML('beforeend', html);
    const filtered = !!(state.q || state.size || state.district || state.category);
    if (reset && r.items.length === 0) {
      grid.innerHTML = '';
      summary.innerHTML = emptyBox(t('home.empty.h'), t('home.empty.p'),
        `<button class="btn ghost small" id="reset" type="button">${esc(t('home.reset'))}</button>`);
    } else {
      summary.textContent = filtered && reset ? t('home.count', { n: r.items.length + (r.items.length === PAGE ? '+' : '') }) : (reset ? '' : summary.textContent);
    }
    moreWrap.hidden = r.items.length < PAGE;
  } catch (e) {
    if (mine !== requestNo) return;
    grid.innerHTML = '';
    summary.innerHTML = emptyBox(errText(e), '', `<button class="btn small" id="retry" type="button">${esc(t('retry'))}</button>`);
    moreWrap.hidden = true;
  }
}

document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-group], #reset, #retry, #more');
  if (!el) return;
  if (el.id === 'more') { state.offset += PAGE; void load(false); return; }
  if (el.id === 'reset') { state.q = state.size = state.district = state.category = ''; ($('#q') as HTMLInputElement).value = ''; }
  else if (el.dataset.group) {
    const key = el.dataset.group as 'size' | 'district' | 'category';
    const v = el.dataset.value || '';
    state[key] = state[key] === v ? '' : v; // tapping the chosen size again clears it
  }
  markPressed(); syncUrl(); void load(true);
});

let typing = 0;
const input = $('#q') as HTMLInputElement;
input.value = state.q;
input.addEventListener('input', () => {
  clearTimeout(typing);
  typing = window.setTimeout(() => { state.q = input.value.trim(); syncUrl(); void load(true); }, 350);
});
$('#search').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearTimeout(typing);
  state.q = input.value.trim(); syncUrl(); void load(true);
  input.blur();
});

void load(true);
