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

// 各語言的首頁設計圖(星星與按鈕位置相同)：手機用 1242 寬的版本，平板與電腦用 2160 寬的原圖
const DESIGN = {
  'zh-Hant': ['assets/brand/home-design-m.webp', 'assets/brand/home-design.webp'],
  en: ['assets/brand/home-design-en-m.webp', 'assets/brand/home-design-en.webp'],
  ja: ['assets/brand/home-design-ja-m.webp', 'assets/brand/home-design-ja.webp'],
};
const SIZES = 'min(100vw, 56.25vh)';

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
    preloadDesigns();
    return;
  }
  show(settings.acceptingPreorders ? 'ready' : 'closed');
  preloadDesigns(); // 按鈕出現後才在背景下載其他語言的設計圖，不和登入搶網路
}

// ===== 語言 =====
// 三種語言的設計圖疊在同一個位置，切換時只顯示或隱藏，不必重新下載或解碼
// 第一張(頁面原有的 #home-img)給開啟時的語言；其他語言的圖層在按鈕出現後才建立並下載
const layers = new Map(); // 語言 → <img>
let currentLang = '';

function setSources(img, lang) {
  const [mobile, full] = DESIGN[lang] || DESIGN['zh-Hant'];
  img.sizes = SIZES;
  img.srcset = `${mobile} 1242w, ${full} 2160w`;
  img.src = mobile;
}

function layerFor(lang) {
  if (layers.has(lang)) return layers.get(lang);
  const base = $('#home-img');
  const img = document.createElement('img');
  img.className = 'home__img home__layer';
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.decoding = 'async';
  img.width = 2160;
  img.height = 3840;
  setSources(img, lang);
  base.after(img);
  layers.set(lang, img);
  return img;
}

function isLoaded(img) {
  return img.complete && img.naturalWidth > 0;
}

function showLayer(lang) {
  for (const [l, img] of layers) img.classList.toggle('is-current', l === lang);
}

function applyDesign(lang, initial = false) {
  for (const item of $$('.lang-menu__item')) {
    const on = item.dataset.lang === lang;
    item.setAttribute('aria-pressed', String(on));
    item.classList.toggle('is-current', on);
  }
  currentLang = lang;
  if (initial) {
    // 開啟頁面時：頁面原有的圖直接換成這個語言，避免先閃出中文版
    const base = $('#home-img');
    if (lang !== 'zh-Hant') setSources(base, lang);
    base.classList.add('home__layer', 'is-current');
    layers.set(lang, base);
    return;
  }
  const img = layerFor(lang);
  if (isLoaded(img)) {
    showLayer(lang);
    return;
  }
  // 還沒下載完：下載好再切換(期間保留目前的圖)；連續快速切換時只套用最後選的語言
  img.addEventListener('load', () => {
    if (currentLang === lang) showLayer(lang);
  }, { once: true });
}

// 背景預先下載其他語言的設計圖(圖片放在 GitHub Pages，不佔 Firebase 額度)；手機開啟省流量模式時不預先下載
let preloaded = false;
function preloadDesigns() {
  if (preloaded || navigator.connection?.saveData) return;
  preloaded = true;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  idle(() => Object.keys(DESIGN).forEach((lang) => {
    const img = layerFor(lang);
    // 預先解碼，切換時直接顯示
    img.decode?.().catch(() => undefined);
  }), { timeout: 1500 });
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

onLangChange((lang) => applyDesign(lang));
applyDesign(getLang(), true);

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

// 營業設定是公開資料，和登入、查詢訂單同時開始讀取，按鈕可以更早出現
async function init() {
  api.watchSettings((s) => {
    settings = s;
    render();
  });
  try {
    await api.initCustomer();
    customerState = await api.getCustomerState();
  } catch (err) {
    customerState = { session: null, order: null };
    toast(errorText(err), 'danger');
  }
  render();
}

init();
