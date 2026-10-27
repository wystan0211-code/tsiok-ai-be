// 顧客顯示頁的 QR code 浮動視窗(customer.html 與從顧客顯示頁切過去的 display.html 共用)
// 攤位在訂單卡按「顯示 QR code」時寫入 screens 文件的 overlay = { no, total, url, at }，關掉視窗時寫回 null
// 浮動視窗蓋在目前畫面上(半透明陰影)，不影響下面的輪播、明細或謝謝光臨；最多顯示 1 分鐘
import { escapeHtml } from './format.js';
import { t } from './i18n.js';
import { qrSvg } from './qr.js';

export const OVERLAY_MS = 60 * 1000;

let box = null;
let timer = 0;
let shownKey = '';
const firstSeen = new Map(); // 浮動視窗在這台裝置第一次出現的時間(兩台裝置的時鐘可能不同步，以本機時間計算 1 分鐘)
const STALE_MS = 10 * 60 * 1000; // 攤位寫入超過 10 分鐘的舊視窗(例如攤位頁沒關視窗就關掉)不再顯示

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'cs-overlay';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  document.body.append(box);
  return box;
}

// 依 screens 文件更新浮動視窗；lang 為顧客顯示頁目前的語言
export function renderOverlay(screen, lang) {
  const el = ensureBox();
  const o = screen?.overlay;
  clearTimeout(timer);
  let age = Infinity;
  if (o && Math.abs(Date.now() - (Number(o.at) || 0)) < STALE_MS) {
    const id = `${o.no}|${o.at}`;
    if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
    age = Date.now() - firstSeen.get(id);
  }
  if (!o || age >= OVERLAY_MS) {
    el.hidden = true;
    shownKey = '';
    return;
  }
  const key = `${o.no}|${o.at}|${lang}`;
  if (key !== shownKey) {
    shownKey = key;
    const total = `＄${Number(o.total || 0).toLocaleString('zh-TW')}`;
    el.innerHTML = `<div class="cs-overlay__card">
      <p class="muted">${escapeHtml(t('screen.no', {}, lang))}</p>
      <p class="display-no cs-overlay__no">${escapeHtml(o.no || '')}</p>
      <p class="muted">${escapeHtml(t(o.unpaid ? 'screen.toPay' : 'screen.paid', { total }, lang))}</p>
      ${o.url ? `<div class="qr-box cs-overlay__qr">${qrSvg(o.url)}</div>
      <p class="text-sm">${escapeHtml(t('screen.scan', {}, lang))}</p>` : ''}
    </div>`;
  }
  el.hidden = false;
  // 時間到自動消失(攤位忘了關視窗、或攤位頁被關掉時的保險)
  timer = setTimeout(() => {
    el.hidden = true;
    shownKey = '';
  }, OVERLAY_MS - age);
}
