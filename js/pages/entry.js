// 入口頁：QR code 的目標網址。檢查是否有進行中訂單，再產生一次性點餐連結
import { api, IS_DEMO } from '../api/index.js';
import { $, showDemoBanner, withBusy, toast } from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { isFinal } from '../core/order-logic.js';
import { escapeHtml } from '../core/format.js';
import { goTo } from '../core/transition.js';

showDemoBanner(IS_DEMO);

const states = ['loading', 'closed', 'active'];
function show(name) {
  for (const s of states) $(`#state-${s}`).hidden = s !== name;
  $('#start-btn').hidden = name !== 'ready';
  $('#active-link').hidden = name !== 'active';
}

let settings = null;
let customerState = null;

function render() {
  if (!settings || !customerState) return;
  const banner = $('#banner');
  banner.hidden = !(settings.bannerActive && settings.bannerText);
  banner.innerHTML = `<span class="material-symbols-rounded icon" aria-hidden="true">campaign</span><p>${escapeHtml(settings.bannerText)}</p>`;

  const { order } = customerState;
  if (order && !isFinal(order)) {
    $('#active-link').href = `track.html?o=${encodeURIComponent(order.id)}`;
    $('#active-no').textContent = order.no;
    show('active');
    return;
  }
  show(settings.acceptingPreorders ? 'ready' : 'closed');
}

$('#start-btn').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  try {
    const token = await api.startSession();
    goTo(`order.html?t=${token}`, { replace: true });
  } catch (err) {
    if (err.code === 'active-order') {
      customerState = await api.getCustomerState();
      render();
      return;
    }
    toast(errorText(err), 'danger');
  }
}));

$('#active-link').addEventListener('click', (e) => {
  e.preventDefault();
  goTo(e.currentTarget.href);
});

async function init() {
  try {
    await api.initCustomer();
    customerState = await api.getCustomerState();
  } catch (err) {
    customerState = { session: null, order: null };
    toast(errorText(err), 'danger');
  }
  api.watchSettings((s) => {
    settings = s;
    render();
  });
}

init();
