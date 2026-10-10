// 點餐頁：驗證一次性連結、菜單(跑馬燈、橫幅輪播、分類列、推薦區)、品項詳細頁、確認訂單並送出
// 畫面以網址 hash 切換：無 hash 為菜單、#item=品項ID 為詳細頁、#checkout 為確認訂單
// 按手機或瀏覽器的返回鍵會直接回到上一個畫面，不顯示等待畫面
import { api, IS_DEMO } from '../api/index.js';
import {
  $, $$, icon, alertDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { store } from '../core/storage.js';
import { escapeHtml, money, personName, TITLES } from '../core/format.js';
import {
  countItems, priceLines, stockIssues, summarizeLines, normalizePhone, isValidPhone,
} from '../core/order-logic.js';
import { goTo, pageReady, briefWait } from '../core/transition.js';
import {
  t, getLang, itemCount, itemText, settingText, withOption,
  categoryText, tagsText,
} from '../core/i18n.js';
import { itemImageRefs } from '../core/images.js';
import {
  optionGroups, hasOptions, groupRule, ruleText, groupName, choiceName, sortedChoices,
  blockedByOptions, normalizeSel, selPrice, selText, selKey, selProblems, addOnText,
} from '../core/options.js';

showDemoBanner(IS_DEMO);

const CART_KEY = 'tab-cart';
const FORM_KEY = 'tab-checkout';
const HISTORY_KEY = 'tab-history';
const token = new URLSearchParams(location.search).get('t') || '';
const AUTOPLAY_MS = 5000; // 橫幅每 5 秒換一張，使用者操作後 5 秒沒有動作才繼續

let settings = null;
let menu = [];
let categories = [];
let banners = [];
let covers = {}; // 品項封面小圖
let cart = store.get(CART_KEY, { lines: [] });
let ready = false;
let pushedFromMenu = false; // 詳細頁或確認訂單是否由菜單點進來(決定返回鍵用 history.back)
let menuScrollY = 0;

const itemsById = () => Object.fromEntries(menu.map((i) => [i.id, i]));
const stockLeft = (item) => (item.stockLimit != null ? Math.max(0, item.stockLimit - (item.soldCount || 0)) : null);
// 售完：手動標示、數量用完，或必填群組的選項全部售完
const isSoldOut = (item) => item.soldOut || stockLeft(item) === 0 || blockedByOptions(item);

// 儲存購物車；菜單載入後才移除已下架的品項，避免載入前把購物車清空
// 舊版購物車只記 option 文字：菜單載入後換成新的選擇格式(sel)，對應不到的品項移除
function saveCart() {
  const map = itemsById();
  cart.lines = cart.lines.filter((l) => l.qty > 0 && (!menu.length || map[l.itemId]));
  if (menu.length) {
    for (const l of cart.lines) {
      if (!Array.isArray(l.sel)) {
        l.sel = normalizeSel(map[l.itemId], l);
        delete l.option;
      }
    }
    // 有選項的品項若選擇已不完整(例如選項被刪除)，從購物車移除
    cart.lines = cart.lines.filter((l) => !hasOptions(map[l.itemId]) || l.sel.length);
  }
  store.set(CART_KEY, cart);
}

function qtyOf(itemId) {
  return cart.lines.filter((l) => l.itemId === itemId).reduce((s, l) => s + l.qty, 0);
}

// 相同品項且相同選擇合併為同一列
function addToCart(itemId, sel = [], qty = 1) {
  const key = selKey(sel);
  const line = cart.lines.find((l) => l.itemId === itemId && selKey(l.sel) === key);
  if (line) line.qty += qty;
  else cart.lines.push({ itemId, sel: sel.slice(), qty });
  saveCart();
  render();
}

function changeLine(index, delta) {
  const line = cart.lines[index];
  if (!line) return;
  line.qty += delta;
  saveCart();
  render();
}

// ===== 畫面切換 =====
function showState(name) {
  for (const s of ['loading', 'invalid', 'closed']) $(`#state-${s}`).hidden = s !== name;
  if (name) {
    for (const v of ['menu', 'detail', 'checkout', 'info']) $(`#view-${v}`).hidden = true;
    for (const bar of ['#cart-bar', '#detail-bar', '#checkout-bar', '#info-bar']) $(bar).hidden = true;
    $('#marquee').hidden = true;
  }
}

function currentView() {
  const hash = decodeURIComponent(location.hash || '');
  if (hash === '#checkout' && cart.lines.length) return { name: 'checkout' };
  // 第二頁：超過數量上限時不能進入，回到第一頁
  if (hash === '#info' && cart.lines.length) {
    return countItems(cart.lines) > (settings?.maxItemsPerOrder || Infinity) ? { name: 'checkout' } : { name: 'info' };
  }
  if (hash.startsWith('#item=')) {
    const id = hash.slice(6);
    if (itemsById()[id]) return { name: 'detail', id };
  }
  return { name: 'menu' };
}

function navigate(hash) {
  if (currentView().name === 'menu') menuScrollY = window.scrollY;
  pushedFromMenu = true;
  location.hash = hash;
}

let lastViewKey = '';
function render() {
  if (!ready || !settings) return;
  if (!settings.acceptingPreorders) {
    showState('closed');
    pageReady();
    return;
  }
  showState(null);
  pageReady();
  const view = currentView();
  const viewKey = view.name + (view.id || '');
  $('#view-menu').hidden = view.name !== 'menu';
  $('#view-detail').hidden = view.name !== 'detail';
  $('#view-checkout').hidden = view.name !== 'checkout';
  $('#view-info').hidden = view.name !== 'info';
  // 返回鍵：菜單回首頁，詳細頁與確認訂單回菜單
  $('#back-btn').setAttribute('aria-label', view.name === 'menu' ? t('common.backHome') : t('order.back'));
  renderMarquee(view.name === 'menu');
  renderCartBar(view.name);
  if (view.name === 'menu') {
    renderMenu();
    if (lastViewKey && lastViewKey !== viewKey) requestAnimationFrame(() => window.scrollTo(0, menuScrollY));
  }
  if (view.name === 'detail') renderDetail(view.id, lastViewKey !== viewKey);
  if (view.name === 'checkout' || view.name === 'info') renderCheckout();
  if (view.name !== 'menu' && lastViewKey !== viewKey) window.scrollTo(0, 0);
  $('#detail-bar').hidden = view.name !== 'detail';
  $('#checkout-bar').hidden = view.name !== 'checkout';
  $('#info-bar').hidden = view.name !== 'info';
  lastViewKey = viewKey;
}

$('#back-btn').addEventListener('click', (e) => {
  if (currentView().name === 'menu') return; // 連結本身就是回首頁
  e.preventDefault();
  if (pushedFromMenu) history.back();
  else location.replace('#');
});

window.addEventListener('hashchange', () => {
  if (!location.hash) pushedFromMenu = false;
  render();
});

// ===== 跑馬燈(黑底黃字，持續捲動、不暫停) =====
let marqueeText = '';
function renderMarquee(show) {
  const box = $('#marquee');
  const text = settingText(settings, 'bannerText');
  box.hidden = !(show && settings.bannerActive && text);
  if (box.hidden || text === marqueeText) return;
  marqueeText = text;
  requestAnimationFrame(() => layoutMarquee(box, text));
}

// 無縫捲動：同一段文字重複到至少一個畫面寬，再複製一份接在後面，動畫移動剛好一半就回到起點
function layoutMarquee(box, text) {
  const track = $('.marquee__track', box);
  track.innerHTML = `<span class="marquee__text">${escapeHtml(text)}</span>`;
  const unit = track.firstElementChild.offsetWidth || 1;
  const copies = Math.max(1, Math.ceil(box.clientWidth / unit));
  const half = Array.from({ length: copies }, (_, i) => `<span class="marquee__text" ${i ? 'aria-hidden="true"' : ''}>${escapeHtml(text)}</span>`).join('');
  track.innerHTML = half + half.replaceAll('<span class="marquee__text" >', '<span class="marquee__text" aria-hidden="true">');
  // 速度固定約每秒 52px
  box.style.setProperty('--marquee-duration', `${(unit * copies) / 52}s`);
}

let marqueeWidth = 0;
window.addEventListener('resize', () => {
  const box = $('#marquee');
  if (box.hidden || !marqueeText || box.clientWidth === marqueeWidth) return;
  marqueeWidth = box.clientWidth;
  layoutMarquee(box, marqueeText);
});

// ===== 橫幅輪播 =====
const carousel = {
  index: 0,
  timer: null,
  lastInteract: 0,
  holding: false,
  programmatic: false,
};

// 橫幅圖片：英文、日文有上傳時使用該語言的版本，否則用中文版
function bannerSrc(b) {
  const lang = getLang();
  if (lang === 'en' && b.dataEn) return b.dataEn;
  if (lang === 'ja' && b.dataJa) return b.dataJa;
  return b.data;
}

function renderCarousel() {
  const box = $('#carousel');
  box.hidden = banners.length === 0;
  const track = $('#carousel-track');
  track.innerHTML = banners.map((b, i) => `<img class="carousel__slide" src="${bannerSrc(b)}" alt="" draggable="false" ${i ? 'loading="lazy"' : ''}>`).join('');
  $('#carousel-dots').innerHTML = banners.map(() => '<span class="carousel__dot"></span>').join('');
  box.classList.toggle('carousel--single', banners.length < 2);
  carousel.index = 0;
  track.scrollLeft = 0;
  updateDots();
  scheduleAutoplay();
}

function updateDots() {
  $$('.carousel__dot').forEach((d, i) => d.classList.toggle('is-active', i === carousel.index));
}

function goSlide(i, smooth = true) {
  const track = $('#carousel-track');
  const n = banners.length;
  if (!n) return;
  carousel.index = (i + n) % n;
  carousel.lastInteract = Date.now(); // 換張後重新計時 5 秒
  carousel.programmatic = true;
  track.scrollTo({ left: carousel.index * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  updateDots();
  setTimeout(() => { carousel.programmatic = false; }, 900);
}

function scheduleAutoplay() {
  clearInterval(carousel.timer);
  if (banners.length < 2) return;
  carousel.timer = setInterval(() => {
    const visible = !$('#carousel').hidden && !$('#view-menu').hidden && !document.hidden;
    if (!visible || carousel.holding || Date.now() - carousel.lastInteract < AUTOPLAY_MS) return;
    goSlide(carousel.index + 1);
  }, 100); // 每 0.1 秒檢查，換張間隔準確為 5 秒
  carousel.lastInteract = Date.now();
}

function touchCarousel() {
  carousel.lastInteract = Date.now();
}

(() => {
  const box = $('#carousel');
  const track = $('#carousel-track');
  // 按住圖片：暫停並隱藏箭頭與圓點，放開後恢復
  // 手機用 touch 事件判斷(滑動時 pointer 事件會被瀏覽器中斷)，電腦用滑鼠
  const hold = () => {
    carousel.holding = true;
    box.classList.add('is-holding');
    touchCarousel();
  };
  const release = () => {
    if (!carousel.holding) return;
    carousel.holding = false;
    box.classList.remove('is-holding');
    touchCarousel();
  };
  track.addEventListener('touchstart', hold, { passive: true });
  track.addEventListener('touchend', release, { passive: true });
  track.addEventListener('touchcancel', release, { passive: true });
  track.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') hold(); });
  ['pointerup', 'pointerleave'].forEach((ev) => track.addEventListener(ev, (e) => { if (e.pointerType === 'mouse') release(); }));
  // 手指滑動後，依停下的位置更新目前張數
  let scrollTimer = null;
  track.addEventListener('scroll', () => {
    if (!carousel.programmatic) touchCarousel();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== carousel.index) {
        carousel.index = i;
        updateDots();
      }
    }, 80);
  }, { passive: true });
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-carousel]');
    if (!btn) return;
    touchCarousel();
    goSlide(carousel.index + (btn.dataset.carousel === 'next' ? 1 : -1));
  });
  window.addEventListener('resize', () => goSlide(carousel.index, false));
})();

// ===== 菜單 =====
function sectionsData() {
  const list = [];
  const featured = menu.filter((i) => i.featured).slice(0, 5);
  if (featured.length) list.push({ id: 'featured', title: t('menu.featured'), items: featured, featured: true });
  const known = new Set(categories.map((c) => c.id));
  for (const c of categories) {
    const items = menu.filter((i) => i.categoryId === c.id);
    if (items.length) list.push({ id: c.id, title: categoryText(c), items: sortSoldOutLast(items) });
  }
  const rest = menu.filter((i) => !i.categoryId || !known.has(i.categoryId));
  if (rest.length) {
    // 沒有建立任何分類時不顯示標題
    list.push({ id: 'other', title: categories.length ? t('menu.other') : '', items: sortSoldOutLast(rest) });
  }
  return list;
}

// 售完的品項排在該分類最後
function sortSoldOutLast(items) {
  return items.slice().sort((a, b) => Number(isSoldOut(a)) - Number(isSoldOut(b)));
}

function coverHtml(item, cls) {
  return covers[item.id]
    ? `<img class="${cls}" src="${covers[item.id]}" alt="" loading="lazy">`
    : `<div class="${cls} ${cls}--empty">${icon('restaurant')}</div>`;
}

// 菜單、詳細頁與確認訂單的單價只顯示「$ 30」(不顯示 NT，所有語言相同)；購物車列仍用 money()
function menuMoney(n) {
  return `$ ${Number(n || 0).toLocaleString('zh-TW')}`;
}

// 確認訂單頁的總金額：中文「$ 120」，英日文「NTD$ 120」(每一品項只顯示單價「$ 20」)
function checkoutTotal(n) {
  const num = Number(n || 0).toLocaleString('zh-TW');
  return getLang() === 'zh-Hant' ? `$ ${num}` : `NTD$ ${num}`;
}

// 加入購物車的控制項：先顯示 +，加入後變成「− 數量 +」
// 「−」減 1：有選項的品項扣掉最後加入的那一列
function cartControl(item) {
  const name = escapeHtml(itemText(item).name);
  if (isSoldOut(item)) return `<span class="soldout-tag">${t('order.soldOut')}</span>`;
  const qty = qtyOf(item.id);
  // 有選項的品項按「+」進入詳細頁選擇；沒有選項的直接加 1
  const plus = hasOptions(item) ? 'open' : 'plus';
  if (qty) {
    return `<div class="stepper">
        <button type="button" class="press" data-action="minus" data-id="${item.id}" aria-label="${t('order.decrease', { name })}">${icon('remove', 'icon--sm')}</button>
        <span class="stepper__value" aria-live="polite">${qty}</span>
        <button type="button" class="press" data-action="${plus}" data-id="${item.id}" aria-label="${t('order.increase', { name })}">${icon('add', 'icon--sm')}</button>
      </div>`;
  }
  return `<button type="button" class="btn-add press" data-action="${plus}" data-id="${item.id}" aria-label="${t('order.add', { name })}">${icon('add')}</button>`;
}

// 品項列：照片在最左，文字緊貼照片右側；品名與說明使用整個文字區寬度
// 加入控制項固定在右下角、與價格同一列，展開成「− 數量 +」時只佔用價格那一列的空間
function rowHtml(item) {
  const tx = itemText(item);
  const left = stockLeft(item);
  const showLeft = settings.showStockLeft !== false && left != null && left > 0 && left <= 10;
  const tags = tagsText(item);
  return `<article class="mi ${isSoldOut(item) ? 'mi--soldout' : ''}" data-open="${item.id}" tabindex="0" role="button" aria-label="${escapeHtml(tx.name)}">
    ${coverHtml(item, 'mi__img')}
    <div class="mi__text">
      <h3 class="mi__name">${escapeHtml(tx.name)}</h3>
      ${tx.description ? `<p class="mi__desc">${escapeHtml(tx.description.split('\n')[0])}</p>` : ''}
      <div class="mi__foot">
        <div class="mi__foot-main">
          <p class="mi__price">${menuMoney(item.price)}</p>
          ${(tags.length || showLeft) ? `<p class="mi__tags">${tags.map((tg) => `<span class="tag">${escapeHtml(tg)}</span>`).join('')}${showLeft ? `<span class="badge badge--warning">${t('order.left', { n: left })}</span>` : ''}</p>` : ''}
        </div>
        <div class="mi-ctrl" data-ctrl="${item.id}">${cartControl(item)}</div>
      </div>
    </div>
  </article>`;
}

function featuredHtml(item) {
  const tx = itemText(item);
  return `<article class="fc ${isSoldOut(item) ? 'mi--soldout' : ''}" data-open="${item.id}" tabindex="0" role="button" aria-label="${escapeHtml(tx.name)}">
    <div class="fc__media">
      ${coverHtml(item, 'fc__img')}
      <div class="mi-ctrl fc__ctrl" data-ctrl="${item.id}">${cartControl(item)}</div>
    </div>
    <h3 class="fc__name">${escapeHtml(tx.name)}</h3>
    <p class="fc__price">${menuMoney(item.price)}</p>
  </article>`;
}

let sections = [];
function renderMenu() {
  const box = $('#menu-sections');
  if (!menu.length) {
    box.innerHTML = `<p class="empty">${t('order.emptyMenu')}</p>`;
    $('#cat-bar').hidden = true;
    return;
  }
  sections = sectionsData();
  box.innerHTML = sections.map((s) => `
    <section class="menu-sec" id="sec-${s.id}" data-sec="${s.id}">
      ${s.title ? `<h2 class="menu-sec__title">${escapeHtml(s.title)}</h2>` : ''}
      ${s.featured
        ? `<div class="fc-row">${s.items.map(featuredHtml).join('')}</div>`
        : `<div class="mi-list">${s.items.map(rowHtml).join('')}</div>`}
    </section>`).join('');
  const titled = sections.filter((s) => s.title);
  $('#cat-bar').hidden = titled.length < 2;
  const active = $('.cat-chip.is-active')?.dataset.target;
  $('#cat-track').innerHTML = titled.map((s) => `
    <button type="button" class="cat-chip ${s.id === active ? 'is-active' : ''}" data-target="${s.id}">${escapeHtml(s.title)}</button>`).join('');
  if (!active) spy();
}

// 點分類：捲到該分類
$('#cat-track').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-target]');
  if (!chip) return;
  const sec = $(`#sec-${CSS.escape(chip.dataset.target)}`);
  if (!sec) return;
  setActiveChip(chip.dataset.target);
  spyPausedUntil = Date.now() + 800;
  window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - stickyOffset() + 1, behavior: 'smooth' });
});

function stickyOffset() {
  const top = $('.topbar').offsetHeight;
  const bar = $('#cat-bar');
  return top + (bar.hidden ? 0 : bar.offsetHeight) + 8;
}

// 目前看到的分類：分類列跟著標示，並順暢地捲到看得到的位置
function setActiveChip(id) {
  const track = $('#cat-track');
  let chip = null;
  for (const c of $$('.cat-chip', track)) {
    const on = c.dataset.target === id;
    c.classList.toggle('is-active', on);
    if (on) chip = c;
  }
  if (chip) {
    const left = chip.offsetLeft - (track.clientWidth - chip.offsetWidth) / 2;
    track.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }
}

let spyPausedUntil = 0;
let spyFrame = 0;
function spy() {
  if ($('#view-menu').hidden || $('#cat-bar').hidden || Date.now() < spyPausedUntil) return;
  const offset = stickyOffset() + 4;
  let current = null;
  const secs = $$('.menu-sec').filter((sec) => $('.menu-sec__title', sec));
  for (const sec of secs) {
    if (sec.getBoundingClientRect().top <= offset) current = sec.dataset.sec;
  }
  // 已捲到最底：最後一個分類的標題可能到不了頂端，直接標示最後一個
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  if (atBottom && secs.length) current = secs[secs.length - 1].dataset.sec;
  current ??= $('.menu-sec .menu-sec__title')?.closest('.menu-sec')?.dataset.sec;
  if (current && current !== $('.cat-chip.is-active')?.dataset.target) setActiveChip(current);
}

window.addEventListener('scroll', () => {
  cancelAnimationFrame(spyFrame);
  spyFrame = requestAnimationFrame(spy);
}, { passive: true });

// 點 +、− 直接增減購物車；有口味的 + 開啟口味視窗；點卡片其他地方才開啟詳細頁
$('#menu-sections').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) {
    e.stopPropagation();
    const { action, id } = btn.dataset;
    if (action === 'plus') {
      const wasEmpty = countItems(cart.lines) === 0;
      addToCart(id, [], 1);
      bumpFeedback(id, wasEmpty);
    }
    if (action === 'minus') {
      const idx = cart.lines.findLastIndex((l) => l.itemId === id);
      if (idx >= 0) changeLine(idx, -1);
    }
    if (action === 'open') navigate(`#item=${id}`); // 有選項的品項：進入詳細頁選擇
    return;
  }
  if (e.target.closest('.mi-ctrl')) return; // 點到控制項的空白處不開啟詳細頁
  const row = e.target.closest('[data-open]');
  if (row) navigate(`#item=${row.dataset.open}`);
});

// 加入購物車的動態回饋：控制項輕輕彈一下；購物車列只在加入第一件品項時跳一下
function bumpFeedback(itemId, wasEmpty = false) {
  for (const el of $$(`[data-ctrl="${itemId}"]`)) {
    el.classList.remove('is-bump');
    void el.offsetWidth; // 重新觸發動畫
    el.classList.add('is-bump');
  }
  if (!wasEmpty) return;
  const bar = $('#cart-bar');
  bar.classList.remove('is-bump');
  void bar.offsetWidth;
  bar.classList.add('is-bump');
}

$('#menu-sections').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) {
    e.preventDefault();
    navigate(`#item=${e.target.dataset.open}`);
  }
});

function renderCartBar(viewName) {
  const count = countItems(cart.lines);
  const { total } = priceLines(cart.lines, itemsById());
  $('#cart-bar').hidden = viewName !== 'menu' || count === 0;
  $('#cart-bar-text').textContent = t('order.cartBar', { count: itemCount(count), total: money(total) });
}

// ===== 品項詳細頁 =====
const detail = { id: null, qty: 1, large: {}, refs: [], sel: new Set() };

function renderDetail(id, fresh) {
  const item = itemsById()[id];
  if (!item) return;
  const tx = itemText(item);
  if (fresh || detail.id !== id) {
    detail.id = id;
    detail.qty = 1;
    detail.sel = new Set();
    detail.refs = itemImageRefs(item);
    renderGallery(item);
    loadLarge(item);
  }
  $('#d-name').textContent = tx.name;
  $('#d-price').textContent = menuMoney(item.price);
  const left = stockLeft(item);
  const showLeft = settings.showStockLeft !== false && left != null && left > 0 && left <= 10;
  const prep = $('#d-prep');
  prep.hidden = !item.prepMinutes;
  prep.innerHTML = item.prepMinutes ? `${icon('schedule', 'icon--sm')}${t('order.prep', { n: item.prepMinutes })}` : '';
  const meta = [
    ...tagsText(item).map((tg) => `<span class="tag">${escapeHtml(tg)}</span>`),
    showLeft ? `<span class="badge badge--warning">${t('order.left', { n: left })}</span>` : '',
  ].join('');
  $('#d-meta').innerHTML = meta;
  $('#d-meta').hidden = !meta;
  $('#d-desc').textContent = tx.description;
  $('#d-desc').hidden = !tx.description;

  renderGroups(item);
  updateDetailBar(item);
}

// ===== 選項群組(仿 Uber Eats：群組標題、規則說明、必填標籤，每個選項一列，右側為單選鈕或勾選框) =====
function renderGroups(item) {
  const box = $('#d-groups');
  const groups = optionGroups(item);
  box.hidden = !groups.length;
  const lang = getLang();
  // 依目前的選擇清掉已不存在或已售完的選項
  const valid = new Set(normalizeSel(item, { sel: [...detail.sel] }));
  for (const key of [...detail.sel]) if (!valid.has(key)) detail.sel.delete(key);
  box.innerHTML = groups.map((g) => {
    const { required, multi, max } = groupRule(g);
    const count = g.choices.filter((c) => detail.sel.has(`${g.id}:${c.id}`)).length;
    const full = multi && count >= max;
    const rows = sortedChoices(g).map((c) => {
      const key = `${g.id}:${c.id}`;
      const checked = detail.sel.has(key);
      const disabled = c.soldOut || (full && !checked);
      const addOn = addOnText(c.price);
      return `<label class="og__row ${c.soldOut ? 'og__row--soldout' : ''} ${disabled ? 'is-disabled' : ''}">
        <span class="og__text">
          <span class="og__name">${escapeHtml(choiceName(item, g, c, lang))}</span>
          ${c.soldOut ? `<span class="og__price">${t('order.soldOut')}</span>` : (addOn ? `<span class="og__price">${addOn}</span>` : '')}
        </span>
        <input class="og__input" type="${multi ? 'checkbox' : 'radio'}" name="og-${escapeHtml(g.id)}" value="${escapeHtml(key)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="og__mark og__mark--${multi ? 'check' : 'radio'}" aria-hidden="true">${multi ? icon('check', 'icon--sm') : ''}</span>
      </label>`;
    }).join('');
    return `<section class="og" data-group="${escapeHtml(g.id)}">
      <div class="og__head">
        <div>
          <h2 class="og__title">${escapeHtml(groupName(item, g, lang))}</h2>
          <p class="og__rule">${escapeHtml(ruleText(g, lang))}</p>
        </div>
        ${required ? `<span class="og__req">${t('detail.required')}</span>` : ''}
      </div>
      <div class="og__rows">${rows}</div>
    </section>`;
  }).join('');
}

$('#d-groups').addEventListener('change', (e) => {
  const input = e.target.closest('.og__input');
  if (!input) return;
  const item = itemsById()[detail.id];
  if (!item) return;
  const [gid] = input.value.split(':');
  const group = optionGroups(item).find((g) => g.id === gid);
  if (!group) return;
  if (input.type === 'radio') {
    for (const c of group.choices) detail.sel.delete(`${gid}:${c.id}`);
    detail.sel.add(input.value);
  } else if (input.checked) detail.sel.add(input.value);
  else detail.sel.delete(input.value);
  // 選好後取消該群組的紅色提示
  const sec = input.closest('.og');
  const keepY = window.scrollY;
  renderGroups(item);
  window.scrollTo(0, keepY);
  if (sec) $(`.og[data-group="${CSS.escape(gid)}"]`)?.classList.remove('is-error');
});

function updateDetailBar(item) {
  $('#d-qty').textContent = detail.qty;
  const btn = $('#detail-add');
  if (btn.classList.contains('is-added')) return; // 「已加入」顯示期間不更新文字
  const soldOut = isSoldOut(item);
  btn.disabled = soldOut;
  btn.textContent = soldOut ? t('order.soldOut') : t('detail.addToOrder');
}

function renderGallery(item) {
  const track = $('#gallery-track');
  const n = detail.refs.length;
  if (!n) {
    track.innerHTML = `<div class="gallery__slide gallery__slide--empty">${icon('restaurant')}</div>`;
  } else {
    // 先用封面小圖(已在菜單載入)，大圖載入後再替換
    // 用一般元素而非 <button>，避免部分瀏覽器的按鈕樣式讓照片無法填滿方框
    track.innerHTML = detail.refs.map((r, i) => `
      <div class="gallery__slide" role="button" tabindex="0" data-photo="${i}" aria-label="${t('detail.photo', { i: i + 1, n })}">
        ${i === 0 && covers[item.id] ? `<img src="${covers[item.id]}" alt="">` : `<span class="gallery__loading">${icon('progress_activity', 'spin')}</span>`}
      </div>`).join('');
    $$('img', track).forEach(fitSquare);
  }
  track.scrollLeft = 0;
  const count = $('#gallery-count');
  count.hidden = n < 2;
  count.textContent = `1 / ${n}`;
}

// 正方形照片填滿方框(不會有黑邊)；舊版非正方形的照片才完整顯示並補黑邊
function fitSquare(img) {
  const apply = () => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    img.classList.toggle('is-square', w > 0 && Math.abs(w - h) <= Math.max(2, w * 0.01));
  };
  if (img.complete) apply();
  else img.addEventListener('load', apply, { once: true });
}

async function loadLarge(item) {
  const id = item.id;
  try {
    const large = await api.getImages(detail.refs, 'l');
    if (detail.id !== id) return;
    detail.large = large;
    detail.refs.forEach((r, i) => {
      const slide = $(`.gallery__slide[data-photo="${i}"]`);
      if (slide && large[r.id]) {
        slide.innerHTML = `<img src="${large[r.id]}" alt="">`;
        fitSquare(slide.firstElementChild);
      }
    });
  } catch (err) {
    console.warn('照片載入失敗', err);
  }
}

$('#gallery-track').addEventListener('scroll', () => {
  const track = $('#gallery-track');
  const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  $('#gallery-count').textContent = `${i + 1} / ${detail.refs.length}`;
}, { passive: true });

// 點照片：全螢幕檢視(可左右滑動、雙指放大)
$('#gallery-track').addEventListener('click', (e) => {
  const slide = e.target.closest('[data-photo]');
  if (!slide) return;
  openViewer(Number(slide.dataset.photo));
});
$('#gallery-track').addEventListener('keydown', (e) => {
  const slide = e.target.closest('[data-photo]');
  if (slide && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openViewer(Number(slide.dataset.photo));
  }
});

function openViewer(start) {
  const item = itemsById()[detail.id];
  const srcs = detail.refs.map((r, i) => detail.large[r.id] || (i === 0 ? covers[item?.id] : '') || '');
  const viewer = $('#viewer');
  const track = $('#viewer-track');
  track.innerHTML = srcs.map((src) => `<div class="viewer__slide">${src ? `<img src="${src}" alt="">` : icon('progress_activity', 'spin')}</div>`).join('');
  viewer.hidden = false;
  document.body.classList.add('is-viewer-open');
  track.scrollLeft = start * track.clientWidth;
  $('#viewer-count').textContent = `${start + 1} / ${srcs.length}`;
  $('#viewer-close').focus();
}

function closeViewer() {
  $('#viewer').hidden = true;
  document.body.classList.remove('is-viewer-open');
}

$('#viewer-close').addEventListener('click', closeViewer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer();
});
$('#viewer-track').addEventListener('scroll', () => {
  const track = $('#viewer-track');
  const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  $('#viewer-count').textContent = `${i + 1} / ${detail.refs.length}`;
}, { passive: true });
window.addEventListener('hashchange', closeViewer);

$('#view-detail').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-detail]');
  if (!btn) return;
  const max = settings?.maxItemsPerOrder || 10;
  detail.qty = Math.max(1, Math.min(max, detail.qty + (btn.dataset.detail === 'plus' ? 1 : -1)));
  updateDetailBar(itemsById()[detail.id]);
});

$('#detail-add').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const item = itemsById()[detail.id];
  if (!item || isSoldOut(item) || btn.classList.contains('is-added')) return;
  const sel = normalizeSel(item, { sel: [...detail.sel] });
  // 必填未選或超過上限：捲到第一個有問題的群組，「必填」標籤變紅
  const problems = selProblems(item, sel);
  if (problems.length) {
    $$('.og').forEach((el) => el.classList.remove('is-error'));
    for (const p of problems) $(`.og[data-group="${CSS.escape(p.group.id)}"]`)?.classList.add('is-error');
    const first = $(`.og[data-group="${CSS.escape(problems[0].group.id)}"]`);
    if (first) window.scrollTo({ top: first.getBoundingClientRect().top + window.scrollY - stickyTop() - 8, behavior: 'smooth' });
    return;
  }
  const wasEmpty = countItems(cart.lines) === 0;
  const withOptions = hasOptions(item);
  addToCart(item.id, sel, detail.qty);
  // 按鈕微退色並顯示打勾「已加入」：沒有選項的品項約 0.5 秒後回到菜單；有選項的 1.5 秒後復原並清空選擇
  btn.classList.add('is-added');
  btn.innerHTML = `${icon('check')}${escapeHtml(t('order.added'))}`;
  setTimeout(() => {
    btn.classList.remove('is-added');
    if (!withOptions) {
      if (pushedFromMenu) history.back();
      else location.replace('#');
      setTimeout(() => bumpFeedback(item.id, wasEmpty), 60);
      return;
    }
    detail.qty = 1;
    detail.sel = new Set();
    renderGroups(item);
    updateDetailBar(item);
  }, withOptions ? 1500 : 500);
});

// 標題列高度(捲動定位時避開)
function stickyTop() {
  return $('.topbar')?.offsetHeight || 56;
}

// ===== 確認訂單 =====
function renderCheckout() {
  const map = itemsById();
  const priced = priceLines(cart.lines, map);
  const max = settings.maxItemsPerOrder;
  const count = countItems(cart.lines);
  $('#cart-lines').innerHTML = cart.lines.map((l, i) => {
    const item = map[l.itemId];
    if (!item) return '';
    const name = itemText(item).name;
    const sel = normalizeSel(item, l);
    const opt = selText(item, sel, getLang());
    const unit = item.price + selPrice(item, sel);
    // 選項以較淡的字顯示在名稱後面
    const optText = opt ? withOption(name, opt).slice(name.length) : '';
    return `<div class="cart-line">
      <div class="cart-line__name">
        <div>${escapeHtml(name)}${optText ? `<span class="muted">${escapeHtml(optText)}</span>` : ''}</div>
        <div class="muted text-xs">${menuMoney(unit)}</div>
      </div>
      <div class="stepper">
        <button type="button" class="press" data-action="line-minus" data-index="${i}" aria-label="${t('order.decreaseShort')}">${icon(l.qty === 1 ? 'delete' : 'remove', 'icon--sm')}</button>
        <span class="stepper__value">${l.qty}</span>
        <button type="button" class="press" data-action="line-plus" data-index="${i}" aria-label="${t('order.increaseShort')}">${icon('add', 'icon--sm')}</button>
      </div>
    </div>`;
  }).join('');
  $('#cart-count').textContent = itemCount(count);
  // 總金額：中文「$ 120」，英日文「NTD$ 120」
  $('#cart-total').textContent = checkoutTotal(priced.total);
  // 超過數量上限：顯示上限數字，「繼續」微退色，按下時不會進入第二頁
  const over = count > max;
  const warn = $('#limit-warning');
  warn.hidden = !over;
  warn.innerHTML = `${icon('warning')}<p>${t('order.limitMax', { n: max })}</p>`;
  $('#continue-btn').classList.toggle('is-faded', over);
  $('#submit-btn').classList.toggle('is-faded', over);
  $('#consent-text').textContent = settingText(settings, 'consentText');
}

$('#view-checkout').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'line-plus') changeLine(Number(btn.dataset.index), 1);
  if (btn.dataset.action === 'line-minus') changeLine(Number(btn.dataset.index), -1);
});

// 第一頁「繼續」：超量時捲到提醒並通知攤位收件匣(只有品項與數量，沒有姓氏與電話)，不進入第二頁
let lastOverReport = '';
$('#continue-btn').addEventListener('click', async () => {
  const count = countItems(cart.lines);
  if (count > settings.maxItemsPerOrder) {
    const warn = $('#limit-warning');
    warn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const summary = summarizeLines(priceLines(cart.lines, itemsById()).lines);
    if (summary !== lastOverReport) {
      lastOverReport = summary;
      api.reportOverLimit({ surname: '', phone: '', summary, count }).catch((err) => console.warn(err));
    }
    return;
  }
  briefWait(300);
  navigate('#info');
});

// 第二頁：缺貨偏好(不預設，必選)
$('#sub-box').addEventListener('change', () => $('#sub-box').classList.remove('is-error'));

// 查看訂單：記住菜單位置，返回時回到原處
$('#cart-bar a').addEventListener('click', (e) => {
  e.preventDefault();
  briefWait(300); // 約 0.3 秒的載入中畫面
  navigate('#checkout');
});

// 表單草稿存在本機，重新整理不會消失
const form = $('#checkout-form');
const draft = store.get(FORM_KEY, {});
form.surname.value = draft.surname || '';
form.phone.value = draft.phone || '';
if (TITLES.includes(draft.title)) form.querySelector(`[name=title][value="${draft.title}"]`).checked = true;
form.addEventListener('input', () => {
  store.set(FORM_KEY, { surname: form.surname.value, title: form.elements.title.value, phone: form.phone.value });
});

// 錯誤訊息；code 為技術代碼(送出被系統拒絕時)，以小灰字顯示在訊息下方，方便回報問題
function formError(message, code = '') {
  const el = $('#form-error');
  el.hidden = !message;
  el.textContent = message || '';
  el.classList.toggle('has-code', Boolean(message && code));
  if (message && code) {
    const small = document.createElement('small');
    small.className = 'form-error__code';
    small.textContent = t('err.code', { code });
    el.append(small);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('#submit-btn'), submit);
});

async function submit() {
  formError('');
  const surname = form.surname.value.trim();
  const title = form.elements.title.value;
  const phone = normalizePhone(form.phone.value);
  // 缺貨偏好先檢查(在畫面最上方)
  if (!$('#sub-box').querySelector('input[name=subPref]:checked')) {
    $('#sub-box').classList.add('is-error');
    $('#sub-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return undefined;
  }
  if (!surname) return formError(t('order.errSurname'));
  if (!TITLES.includes(title)) return formError(t('order.errTitle'));
  if (!isValidPhone(phone)) return formError(t('order.errPhone'));
  if (!form.consent.checked) return formError(t('order.errConsent'));

  const map = itemsById();
  const count = countItems(cart.lines);
  if (!count) return formError(t('order.errEmpty'));
  const subPref = $('#sub-box').querySelector('input[name=subPref]:checked').value;

  // 超過上限：自動拒絕並通知攤位收件匣
  if (count > settings.maxItemsPerOrder) {
    const summary = summarizeLines(priceLines(cart.lines, map).lines);
    try {
      await api.reportOverLimit({ surname: personName(surname, title), phone, summary, count });
    } catch (err) {
      console.warn(err);
    }
    await alertDialog(t('order.overTitle'), t('order.overMsg', { max: settings.maxItemsPerOrder, count }));
    return undefined;
  }

  const issues = stockIssues(cart.lines, map);
  if (issues.length) {
    const list = issues.map(({ item, kind, left }) => (kind === 'deleted'
      ? t('stock.deleted')
      : t(`stock.${kind}`, { name: itemText(item).name, n: left }))).join(getLang() === 'en' ? ', ' : '、');
    return formError(t('order.unavailable', { list }));
  }

  try {
    const { orderId, no } = await api.submitPreorder({
      lines: cart.lines, surname, title, phone, lang: getLang(), consentText: settingText(settings, 'consentText'), subPref,
    });
    const history = store.get(HISTORY_KEY, []);
    history.unshift({ orderId, no, at: Date.now() });
    store.set(HISTORY_KEY, history.slice(0, 10));
    cart = { lines: [] };
    store.set(CART_KEY, cart);
    goTo(`track.html?o=${encodeURIComponent(orderId)}&new=1`, { replace: true });
  } catch (err) {
    formError(errorText(err), err?.diag || '');
  }
  return undefined;
}

// ===== 初始化 =====
async function loadCovers() {
  try {
    covers = await api.getItemImages(menu);
    if (ready && settings && currentView().name === 'menu') renderMenu();
  } catch (err) {
    console.warn('圖片載入失敗', err);
  }
}

async function init() {
  // 菜單、設定、分類、橫幅都是公開資料，與「登入＋確認點餐連結」同時開始讀取，縮短等待時間
  // 連結確認通過(ready = true)之前，render() 不會顯示菜單
  startWatchers();
  try {
    await api.initCustomer();
    const check = await api.checkSession(token);
    if (!check.ok) {
      showState('invalid');
      pageReady();
      if (check.reason === 'used' && check.orderId) {
        $('#invalid-text').textContent = t('order.invalidUsed');
        $('#invalid-action').textContent = t('home.viewOrder');
        $('#invalid-action').href = `track.html?o=${encodeURIComponent(check.orderId)}`;
      }
      return;
    }
  } catch (err) {
    showState('invalid');
    pageReady();
    $('#invalid-text').textContent = errorText(err);
    return;
  }
  ready = true;
  render();
}

function startWatchers() {
  api.watchSettings((s) => {
    settings = s;
    render();
  });
  api.watchCategories((list) => {
    categories = list;
    render();
  });
  api.watchBanners((list) => {
    // 順序或目前語言的圖片有變動時才重畫
    const keyOf = (arr) => arr.map((b) => `${b.id}:${b.updatedAt || ''}:${bannerSrc(b)?.length || 0}`).join('|');
    const changed = keyOf(list) !== keyOf(banners);
    banners = list;
    if (changed) renderCarousel();
  });
  let lastImageKey = '';
  api.watchMenu((items) => {
    menu = items;
    saveCart();
    render();
    const key = items.map((i) => `${i.id}:${(i.images || []).join(',')}:${i.imageVersion || 0}`).join('|');
    if (key !== lastImageKey) {
      lastImageKey = key;
      loadCovers();
    }
  });
}

init();
