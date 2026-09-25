// 叫號大螢幕：顯示製作中與可取餐的編號，新的可取餐編號出現時播放提示音
import { api, IS_DEMO } from '../api/index.js';
import { $, showDemoBanner } from '../core/ui.js';
import { requireStaff } from '../core/guard.js';
import { escapeHtml, time } from '../core/format.js';
import { beep } from '../core/sound.js';

showDemoBanner(IS_DEMO, false);

let knownReady = null;

function render(orders) {
  const making = orders.filter((o) => o.status === 'accepted');
  const ready = orders.filter((o) => o.status === 'ready').sort((a, b) => (b.readyAt || 0) - (a.readyAt || 0));
  $('#making').innerHTML = making.map((o) => `<span>${escapeHtml(o.no)}</span>`).join('') || '<span class="muted">—</span>';
  $('#ready').innerHTML = ready.map((o) => `<span>${escapeHtml(o.no)}</span>`).join('') || '<span class="muted">—</span>';
  const ids = new Set(ready.map((o) => o.id));
  if (knownReady && [...ids].some((id) => !knownReady.has(id))) beep(3);
  knownReady = ids;
}

$('#fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

function tick() {
  $('#clock').textContent = time(Date.now());
}

requireStaff('staff', () => {
  tick();
  setInterval(tick, 10000);
  api.watchTodayOrders(render);
});
