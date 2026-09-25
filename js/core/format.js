// 格式化工具：訂單編號、金額、時間、狀態文字

// 訂單類型對應的編號字首：預點 A、現場 B、管理員手動新增 M
export const PREFIX = { preorder: 'A', walkin: 'B', manual: 'M' };

export function formatNo(type, seq) {
  const prefix = PREFIX[type] ?? 'X';
  return prefix + String(seq ?? 0).padStart(3, '0');
}

export function money(n) {
  return `NT$ ${Number(n || 0).toLocaleString('zh-TW')}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function time(ms) {
  if (!ms) return '--:--';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${time(ms)}`;
}

// 距今幾分鐘
export function minutesSince(ms, now = Date.now()) {
  return ms ? Math.max(0, Math.floor((now - ms) / 60000)) : 0;
}

export function startOfDay(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 轉成 <input type="date"> 使用的 yyyy-mm-dd
export function toDateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 從 yyyy-mm-dd 取得當地時間 0 點的毫秒數
export function fromDateInput(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export const STATUS_LABEL = {
  pending: '等待接單',
  accepted: '製作中',
  ready: '可取餐',
  picked: '已取餐',
  rejected: '已拒絕',
  cancelled: '已取消',
};

export const TYPE_LABEL = { preorder: '預點', walkin: '現場', manual: '手動' };

export const ROLE_LABEL = { admin: '管理員', manager: '攤位主管', staff: '店員' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 產生隨機十六進位字串(用於一次性點餐連結)
export function randomToken(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 簡訊範本代換：{no} 訂單編號、{surname} 姓氏
export function fillTemplate(template, data) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '');
}
