// "My reservations": reads the saved tokens and asks the database for their status.
import { rpc, esc, savedTokens, toast, $, BASE } from '../lib/api';
import { t } from '../i18n';
import { slip, emptyBox, errText, type Reservation } from '../lib/ui';

const app = $('#app');

async function load(): Promise<void> {
  const tokens = savedTokens();
  if (tokens.length === 0) {
    app.innerHTML = emptyBox(t('my.empty.h'), t('my.empty.p'), `<a class="btn small" href="${BASE}">${esc(t('home.link'))}</a>`);
    return;
  }
  try {
    const list = await rpc<Reservation[]>('my_reservations', { p_tokens: tokens });
    app.innerHTML = list.length
      ? list.map((r) => slip(r)).join('')
      : emptyBox(t('my.empty.h'), t('my.empty.p'), `<a class="btn small" href="${BASE}">${esc(t('home.link'))}</a>`);
  } catch (e) {
    app.innerHTML = emptyBox(errText(e), '', `<button class="btn small" id="retry" type="button">${esc(t('retry'))}</button>`);
  }
}

app.addEventListener('click', async (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest('#retry')) { void load(); return; }
  const b = target.closest<HTMLButtonElement>('[data-cancel]');
  if (!b) return;
  // Two taps instead of a pop-up: the first tap asks, the second cancels.
  if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = t('slip.cancel2'); return; }
  b.disabled = true;
  try {
    await rpc('cancel_reservation', { p_token: b.dataset.cancel });
    toast(t('slip.cancelled'));
    void load();
  } catch (e) { toast(errText(e)); b.disabled = false; }
});

void load();
