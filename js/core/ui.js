// 介面共用元件：選取器、圖標、提示訊息、對話框、展示模式橫幅
import { escapeHtml } from './format.js';
import { t } from './i18n.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// iPhone Safari 需要頁面上有 touchstart 監聽，按鈕的 :active 按下效果才會即時出現
document.addEventListener('touchstart', () => {}, { passive: true });

// 即時按下回饋：只套用在 3.13.1 原本就有按下回饋的按鈕，手指一碰到就加上 is-pressed
// (瀏覽器的 :active 在手機上常會晚一點才出現)；放開時至少維持 90 毫秒，快速點一下也看得到回饋
// 顧客端的商品卡、數量加減(.mi-ctrl 與 .stepper 裡的 .press)不使用回饋
const PRESS_TARGETS = '.btn, .press, .cat-chip, .radio-chip, .stepper button, .carousel__nav, .home__start';
const PRESS_EXCLUDE = '.mi-ctrl .press, .stepper .press';
const PRESS_MIN_MS = 90;
const PRESS_SLOP = 8;
let pressed = null; // { el, at, x, y }

function pressRelease() {
  if (!pressed) return;
  const { el, at } = pressed;
  pressed = null;
  const left = PRESS_MIN_MS - (performance.now() - at);
  if (left > 0) setTimeout(() => el.classList.remove('is-pressed'), left);
  else el.classList.remove('is-pressed');
}

document.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || !e.isPrimary) return;
  const el = e.target.closest?.(PRESS_TARGETS);
  pressRelease();
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.matches(PRESS_EXCLUDE)) return;
  pressed = { el, at: performance.now(), x: e.clientX, y: e.clientY };
  el.classList.add('is-pressed');
}, { passive: true, capture: true });

document.addEventListener('pointermove', (e) => {
  if (!pressed || !e.isPrimary) return;
  if (Math.abs(e.clientX - pressed.x) > PRESS_SLOP || Math.abs(e.clientY - pressed.y) > PRESS_SLOP) pressRelease();
}, { passive: true, capture: true });

for (const type of ['pointerup', 'pointercancel', 'dragstart', 'contextmenu']) {
  document.addEventListener(type, pressRelease, { passive: true, capture: true });
}
// 開始捲動、切到背景時取消
document.addEventListener('scroll', pressRelease, { passive: true, capture: true });
window.addEventListener('blur', pressRelease);

// Material Symbols Rounded 圖標(新增圖標時記得同步更新 HTML 中的 icon_names 清單)
export function icon(name, extraClass = '') {
  return `<span class="material-symbols-rounded icon ${extraClass}" aria-hidden="true">${name}</span>`;
}

// 右下角提示訊息
export function toast(message, kind = 'info', duration = 3200) {
  let box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    box.className = 'toast-box';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), duration);
}

/**
 * 開啟對話框
 * body 可放入表單欄位；按下動作按鈕時會先做表單驗證
 * 回傳 { value: 按下的按鈕值或 'cancel', data: FormData }
 */
export function openDialog({
  title,
  body = '',
  actions = [{ label: t('common.ok'), value: 'ok', variant: 'primary' }],
  cancelLabel = t('common.cancel'),
  size = '',
  onOpen,
}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = `dialog ${size ? `dialog--${size}` : ''}`;
    dlg.innerHTML = `
      <form method="dialog" class="dialog__form">
        <header class="dialog__header"><h2 class="dialog__title">${escapeHtml(title)}</h2></header>
        <div class="dialog__body">${body}</div>
        <footer class="dialog__actions">
          ${cancelLabel ? `<button type="submit" class="btn btn--ghost" value="cancel" formnovalidate>${escapeHtml(cancelLabel)}</button>` : ''}
          ${actions.map((a) => `<button type="submit" class="btn btn--${a.variant || 'primary'}" value="${escapeHtml(a.value)}">${escapeHtml(a.label)}</button>`).join('')}
        </footer>
      </form>`;
    const form = dlg.querySelector('form');
    let data = null;
    form.addEventListener('submit', () => {
      data = new FormData(form);
    });
    dlg.addEventListener('close', () => {
      resolve({ value: dlg.returnValue || 'cancel', data: data || new FormData(form) });
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg);
  });
}

// solid:true 時確認按鈕為紅底白字
export async function confirmDialog(title, message, {
  confirmLabel = t('common.ok'), cancelLabel = t('common.cancel'), danger = false, solid = false,
} = {}) {
  let variant = 'primary';
  if (danger) variant = solid ? 'danger-solid' : 'danger';
  const { value } = await openDialog({
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    actions: [{ label: confirmLabel, value: 'ok', variant }],
    cancelLabel,
  });
  return value === 'ok';
}

export async function alertDialog(title, message) {
  await openDialog({
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    actions: [{ label: t('common.gotIt'), value: 'ok' }],
    cancelLabel: '',
  });
}

// 按鈕處理中狀態，避免重複送出
export async function withBusy(button, task) {
  if (!button) return task();
  if (button.disabled) return undefined;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

// 展示模式橫幅
export function showDemoBanner(isDemo, links = true) {
  if (!isDemo) return;
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.innerHTML = `
    <strong>展示模式</strong>
    <span>資料只存在這個瀏覽器，尚未連接 Firebase。</span>
    ${links ? `<nav class="demo-bar__links">
      <a href="index.html">入口</a>
      <a href="login.html">員工登入</a>
      <a href="stall.html">營運</a>
      <a href="admin.html">後台</a>
      <a href="display.html">叫號</a>
    </nav>` : ''}`;
  document.body.prepend(bar);
}
