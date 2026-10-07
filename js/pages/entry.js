// 入口頁：QR code 的目標網址。畫面直接使用設計圖，按鈕依狀態顯示(公告只顯示在點餐頁)
// 左上角地球按鈕可切換語言，之後的顧客頁面都使用所選語言
import { api, IS_DEMO } from '../api/index.js';
import { $, $$, showDemoBanner, withBusy, toast } from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { isFinal } from '../core/order-logic.js';
import { goTo } from '../core/transition.js';
import { getLang, setLang, onLangChange } from '../core/i18n.js';
import { isLineInApp } from '../core/env.js';

showDemoBanner(IS_DEMO);

// 各語言的首頁設計圖(星星與按鈕位置相同)
const DESIGN = {
  'zh-Hant': 'assets/brand/home-design.webp',
  en: 'assets/brand/home-design-en.webp',
  ja: 'assets/brand/home-design-ja.webp',
};

const states = ['loading', 'closed', 'active', 'line'];
function show(requested) {
  const name = isLineInApp() ? 'line' : requested;
  for (const s of states) $(`#state-${s}`).hidden = s !== name;
  $('#start-btn').hidden = name !== 'ready';
  $('#active-link').hidden = name !== 'active';
}

// LINE 內建瀏覽器：一開始就顯示提示，不必等資料載入
if (isLineInApp()) show('line');

let settings = null;
let customerState = null;

function render() {
  if (!settings || !customerState) return;
  const { order } = customerState;
  if (order && !isFinal(order)) {
    $('#active-link').href = `track.html?o=${encodeURIComponent(order.id)}`;
    $('#active-no').textContent = order.no;
    show('active');
    return;
  }
  show(settings.acceptingPreorders ? 'ready' : 'closed');
}

// ===== 語言 =====
function applyDesign(lang) {
  const img = $('#home-img');
  const src = DESIGN[lang] || DESIGN['zh-Hant'];
  if (!img.src.endsWith(src)) img.src = src;
  for (const item of $$('.lang-menu__item')) {
    const on = item.dataset.lang === lang;
    item.setAttribute('aria-pressed', String(on));
    item.classList.toggle('is-current', on);
  }
}

function toggleMenu(open) {
  const menu = $('#lang-menu');
  const willOpen = open ?? menu.hidden;
  menu.hidden = !willOpen;
  $('#lang-btn').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) (menu.querySelector('.is-current') || menu.querySelector('button')).focus();
}

$('#lang-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});

$('#lang-menu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-lang]');
  if (!item) return;
  setLang(item.dataset.lang);
  toggleMenu(false);
  $('#lang-btn').focus();
});

// 點選單以外的地方或按 Esc 關閉
document.addEventListener('click', (e) => {
  if (!e.target.closest('.home__lang')) toggleMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#lang-menu').hidden) {
    toggleMenu(false);
    $('#lang-btn').focus();
  }
});

onLangChange(applyDesign);
applyDesign(getLang());

// ===== 開始點餐 =====
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
