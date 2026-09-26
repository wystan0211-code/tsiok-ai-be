// 介面共用元件：選取器、圖標、提示訊息、對話框、展示模式橫幅
import { escapeHtml } from './format.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

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
  actions = [{ label: '確定', value: 'ok', variant: 'primary' }],
  cancelLabel = '取消',
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
export async function confirmDialog(title, message, { confirmLabel = '確定', danger = false, solid = false } = {}) {
  let variant = 'primary';
  if (danger) variant = solid ? 'danger-solid' : 'danger';
  const { value } = await openDialog({
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    actions: [{ label: confirmLabel, value: 'ok', variant }],
  });
  return value === 'ok';
}

export async function alertDialog(title, message) {
  await openDialog({
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    actions: [{ label: '知道了', value: 'ok' }],
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
