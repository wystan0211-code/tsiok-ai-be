// 管理後台：品項、營業設定、收支(攤位主管可檢視，管理員可編輯)、帳號與系統(僅管理員)
import { api, IS_DEMO } from '../api/index.js';
import {
  $, $$, icon, toast, openDialog, confirmDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { requireStaff, hasRole } from '../core/guard.js';
import {
  escapeHtml, money, dateTime, toDateInput, fromDateInput,
  STATUS_LABEL, TYPE_LABEL, ROLE_LABEL,
} from '../core/format.js';
import { displayLines, isPaid, lineLabel, summarizeLines } from '../core/order-logic.js';
import { compressImage } from '../core/image.js';
import { qrSvg } from '../core/qr.js';

showDemoBanner(IS_DEMO);

let profile = null;
let isAdmin = false;
let items = [];
let images = {};
let settings = null;
let financeOrders = [];

// ===== 分頁 =====
function selectTab(name) {
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of ['items', 'settings', 'finance', 'accounts', 'system']) $(`#panel-${panel}`).hidden = panel !== name;
  if (name === 'finance' && !financeOrders.length) loadFinance();
  if (name === 'accounts') loadAccounts();
}
$$('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

// ===== 品項 =====
function renderItems() {
  const rows = $('#item-rows');
  if (!items.length) {
    rows.innerHTML = '<tr><td colspan="7" class="empty">尚未建立品項</td></tr>';
    return;
  }
  rows.innerHTML = items.map((it, i) => {
    const status = [
      it.active ? '<span class="badge badge--success">上架</span>' : '<span class="badge">下架</span>',
      it.soldOut ? '<span class="badge badge--danger">售完</span>' : '',
    ].join(' ');
    const thumb = images[it.id]
      ? `<img src="${images[it.id]}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:var(--radius)">`
      : `<span class="muted">${icon('image')}</span>`;
    return `<tr data-item="${it.id}">
      <td>${thumb}</td>
      <td><strong>${escapeHtml(it.name)}</strong>${it.options?.length ? `<div class="muted">${escapeHtml(it.options.join('、'))}</div>` : ''}</td>
      <td class="num">${money(it.price)}</td>
      <td class="num">${it.soldCount || 0} / ${it.stockLimit ?? '不限'}</td>
      <td>${status}</td>
      <td><div class="row" style="flex-wrap:nowrap">
        <button class="btn btn--ghost btn--icon" data-item-act="up" ${i === 0 ? 'disabled' : ''} aria-label="上移">${icon('arrow_upward')}</button>
        <button class="btn btn--ghost btn--icon" data-item-act="down" ${i === items.length - 1 ? 'disabled' : ''} aria-label="下移">${icon('arrow_downward')}</button>
      </div></td>
      <td><div class="row" style="flex-wrap:nowrap">
        <button class="btn btn--sm" data-item-act="edit">${icon('edit', 'icon--sm')}編輯</button>
        <button class="btn btn--sm btn--danger" data-item-act="delete">${icon('delete', 'icon--sm')}刪除</button>
      </div></td>
    </tr>`;
  }).join('');
}

function splitList(value) {
  return String(value || '').split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
}

async function editItem(item) {
  const it = item || {
    name: '', price: 0, description: '', prepMinutes: 5, options: [], stockLimit: null,
    soldCount: 0, active: true, soldOut: false,
  };
  const { value, data } = await openDialog({
    title: item ? `編輯 ${item.name}` : '新增品項',
    size: 'wide',
    body: `
      <label class="field"><span class="field__label">名稱</span>
        <input class="input" name="name" maxlength="20" required value="${escapeHtml(it.name)}"></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1"><span class="field__label">價格(元)</span>
          <input class="input" name="price" type="number" min="0" max="9999" step="1" required value="${it.price}"></label>
        <label class="field" style="flex:1"><span class="field__label">製作時間(分鐘)</span>
          <input class="input" name="prepMinutes" type="number" min="0" max="120" step="1" value="${it.prepMinutes || 0}"></label>
      </div>
      <label class="field"><span class="field__label">說明</span>
        <input class="input" name="description" maxlength="80" value="${escapeHtml(it.description || '')}"></label>
      <label class="field"><span class="field__label">選項(用頓號、分隔，例如：糖粉、巧克力)</span>
        <input class="input" name="options" value="${escapeHtml((it.options || []).join('、'))}">
        <span class="field__hint">留空代表沒有選項；有選項時顧客必須選一個</span></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1"><span class="field__label">數量上限(留空為不限)</span>
          <input class="input" name="stockLimit" type="number" min="0" step="1" value="${it.stockLimit ?? ''}"></label>
        <label class="field" style="flex:1"><span class="field__label">已售數量</span>
          <input class="input" name="soldCount" type="number" min="0" step="1" value="${it.soldCount || 0}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="active" ${it.active ? 'checked' : ''}><span>上架</span></label>
      <label class="switch"><input type="checkbox" name="soldOut" ${it.soldOut ? 'checked' : ''}><span>標示售完</span></label>
      <label class="field"><span class="field__label">圖片(會自動壓縮)</span>
        <input class="input" name="image" type="file" accept="image/*"></label>
      ${item?.hasImage ? '<label class="check"><input type="checkbox" name="removeImage"><span>移除目前圖片</span></label>' : ''}`,
    actions: [{ label: '儲存', value: 'save' }],
  });
  if (value !== 'save') return;
  const stockRaw = String(data.get('stockLimit') || '').trim();
  const payload = {
    name: String(data.get('name')).trim(),
    price: Math.max(0, Math.round(Number(data.get('price')) || 0)),
    prepMinutes: Math.max(0, Math.round(Number(data.get('prepMinutes')) || 0)),
    description: String(data.get('description') || '').trim(),
    options: splitList(data.get('options')),
    stockLimit: stockRaw === '' ? null : Math.max(0, Math.round(Number(stockRaw))),
    soldCount: Math.max(0, Math.round(Number(data.get('soldCount')) || 0)),
    active: data.get('active') === 'on',
    soldOut: data.get('soldOut') === 'on',
  };
  if (!payload.name) {
    toast('請填寫名稱', 'danger');
    return;
  }
  if (!item) payload.sortOrder = Math.max(0, ...items.map((i) => i.sortOrder || 0)) + 1;
  try {
    const id = await api.saveItem(item ? { id: item.id, ...payload } : payload);
    const file = data.get('image');
    if (file && file.size) {
      const dataUrl = await compressImage(file);
      await api.setItemImage(id, dataUrl);
    } else if (data.get('removeImage') === 'on') {
      await api.setItemImage(id, null);
    }
    toast('已儲存', 'success');
  } catch (err) {
    toast(err.message && !err.code ? err.message : errorText(err), 'danger');
  }
}

$('#item-add').addEventListener('click', () => editItem(null));

$('#item-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-item-act]');
  if (!btn) return;
  const id = btn.closest('[data-item]').dataset.item;
  const index = items.findIndex((i) => i.id === id);
  const item = items[index];
  const act = btn.dataset.itemAct;
  withBusy(btn, async () => {
    try {
      if (act === 'edit') await editItem(item);
      if (act === 'delete') {
        if (await confirmDialog('刪除品項', `確定要刪除「${item.name}」嗎？已成立的訂單明細不受影響。`, { confirmLabel: '刪除', danger: true })) {
          await api.deleteItem(id);
          toast('已刪除');
        }
      }
      if (act === 'up' || act === 'down') {
        const target = act === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= items.length) return;
        // 交換位置後，把所有品項的排序值重新編成 1、2、3…，只更新有變動的品項
        const order = items.slice();
        [order[index], order[target]] = [order[target], order[index]];
        for (const [i, it] of order.entries()) {
          if (it.sortOrder !== i + 1) await api.saveItem({ id: it.id, sortOrder: i + 1 });
        }
      }
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

// ===== 營業設定 =====
function fillSettings() {
  const f = $('#settings-form');
  if (f.dataset.dirty === '1') {
    $('#settings-note').textContent = '設定已被其他人更新，儲存時會以你目前的內容覆蓋。';
    return;
  }
  f.bannerActive.checked = !!settings.bannerActive;
  f.bannerText.value = settings.bannerText || '';
  f.acceptingPreorders.checked = !!settings.acceptingPreorders;
  f.maxItemsPerOrder.value = settings.maxItemsPerOrder;
  f.pickupReminderMinutes.value = settings.pickupReminderMinutes;
  f.paymentMethods.value = (settings.paymentMethods || []).join('、');
  f.messageTemplates.value = (settings.messageTemplates || []).join('\n');
  f.smsTemplate.value = settings.smsTemplate || '';
  f.consentText.value = settings.consentText || '';
}

$('#settings-form').addEventListener('input', (e) => {
  e.currentTarget.dataset.dirty = '1';
});

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  withBusy(f.querySelector('button[type=submit]'), async () => {
    const patch = {
      bannerActive: f.bannerActive.checked,
      bannerText: f.bannerText.value.trim(),
      acceptingPreorders: f.acceptingPreorders.checked,
      maxItemsPerOrder: Math.max(1, Math.round(Number(f.maxItemsPerOrder.value) || 10)),
      pickupReminderMinutes: Math.max(1, Math.round(Number(f.pickupReminderMinutes.value) || 15)),
      paymentMethods: splitList(f.paymentMethods.value),
      messageTemplates: f.messageTemplates.value.split('\n').map((s) => s.trim()).filter(Boolean),
      smsTemplate: f.smsTemplate.value.trim(),
      consentText: f.consentText.value.trim(),
    };
    if (!patch.paymentMethods.length) {
      toast('至少需要一種付款方式', 'danger');
      return;
    }
    try {
      await api.saveSettings(patch);
      f.dataset.dirty = '0';
      $('#settings-note').textContent = '';
      toast('設定已儲存', 'success');
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

// ===== 收支 =====
const financeForm = $('#finance-form');
financeForm.from.value = toDateInput(Date.now());
financeForm.to.value = toDateInput(Date.now());

function financeRange() {
  const from = fromDateInput(financeForm.from.value);
  const to = fromDateInput(financeForm.to.value) + 86400000; // 結束日期當天也包含
  return { from, to };
}

async function loadFinance() {
  const { from, to } = financeRange();
  if (to <= from) {
    toast('結束日期不能早於開始日期', 'danger');
    return;
  }
  try {
    financeOrders = await api.listOrders({ from, to });
    renderFinance();
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

financeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(financeForm.querySelector('button[type=submit]'), loadFinance);
});

function renderFinance() {
  const valid = financeOrders.filter((o) => !o.deleted);
  const paid = valid.filter(isPaid);
  const unpaid = valid.filter((o) => o.type === 'preorder' && ['accepted', 'ready'].includes(o.status));
  const sum = (list) => list.reduce((s, o) => s + (o.total || 0), 0);

  const byPayment = {};
  for (const o of paid) byPayment[o.payment || '未指定'] = (byPayment[o.payment || '未指定'] || 0) + (o.total || 0);

  const byItem = {};
  for (const o of paid) {
    for (const l of o.lines || []) {
      const key = l.name || '其他';
      byItem[key] ??= { qty: 0, amount: 0 };
      byItem[key].qty += l.qty;
      byItem[key].amount += l.subtotal ?? l.price * l.qty;
    }
  }

  $('#finance-stats').innerHTML = `
    <div class="stat"><p class="muted text-sm">已收款</p><p class="stat__value">${money(sum(paid))}</p><p class="muted text-sm">${paid.length} 筆</p></div>
    <div class="stat"><p class="muted text-sm">待收款(已接單未取餐)</p><p class="stat__value">${money(sum(unpaid))}</p><p class="muted text-sm">${unpaid.length} 筆</p></div>
    ${Object.entries(byPayment).map(([k, v]) => `<div class="stat"><p class="muted text-sm">${escapeHtml(k)}</p><p class="stat__value">${money(v)}</p></div>`).join('')}`;

  const itemRows = Object.entries(byItem).sort((a, b) => b[1].amount - a[1].amount);
  $('#finance-breakdown').innerHTML = itemRows.length ? `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>品項(已收款)</th><th class="num">數量</th><th class="num">金額</th></tr></thead>
      <tbody>${itemRows.map(([name, v]) => `<tr><td>${escapeHtml(name)}</td><td class="num">${v.qty}</td><td class="num">${money(v.amount)}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  const rows = $('#finance-rows');
  rows.innerHTML = financeOrders.length ? financeOrders.slice().reverse().map((o) => `
    <tr data-order="${o.id}" class="${o.deleted ? 'is-deleted' : ''}">
      <td class="display-no">${escapeHtml(o.no)}</td>
      <td>${TYPE_LABEL[o.type] || o.type}</td>
      <td>${o.deleted ? '已刪除' : (STATUS_LABEL[o.status] || o.status)}</td>
      <td>${dateTime(o.establishedAt || o.createdAt)}</td>
      <td>${escapeHtml(o.surname || '')}</td>
      <td>${escapeHtml(summarizeLines(displayLines(o, {})))}${o.note ? `<div class="muted">${escapeHtml(o.note)}</div>` : ''}</td>
      <td class="num">${o.total != null ? money(o.total) : '—'}</td>
      <td>${escapeHtml(o.payment || '')}</td>
      <td data-admin ${isAdmin ? '' : 'hidden'}>${o.deleted ? '' : `<div class="row" style="flex-wrap:nowrap">
        <button class="btn btn--sm" data-fin-act="edit">${icon('edit', 'icon--sm')}編輯</button>
        <button class="btn btn--sm btn--danger" data-fin-act="delete">${icon('delete', 'icon--sm')}刪除</button></div>`}</td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">這段期間沒有訂單</td></tr>';
}

$('#finance-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fin-act]');
  if (!btn || !isAdmin) return;
  const o = financeOrders.find((x) => x.id === btn.closest('[data-order]').dataset.order);
  if (!o) return;
  withBusy(btn, async () => {
    try {
      if (btn.dataset.finAct === 'delete') {
        if (await confirmDialog('刪除紀錄', `確定要刪除 ${o.no} 嗎？紀錄會標示為已刪除，不列入收支。`, { confirmLabel: '刪除', danger: true })) {
          await api.adminDeleteOrder(o.id);
          toast('已刪除');
          await loadFinance();
        }
      } else await editFinance(o);
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

function paymentOptions(selected) {
  const methods = settings?.paymentMethods || ['園遊券', '現金'];
  const list = selected && !methods.includes(selected) ? [...methods, selected] : methods;
  return list.map((m) => `<option ${m === selected ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
}

async function editFinance(o) {
  const statuses = ['pending', 'accepted', 'ready', 'picked', 'rejected', 'cancelled'];
  const { value, data } = await openDialog({
    title: `編輯 ${o.no}`,
    body: `
      <p class="muted text-sm">${escapeHtml(summarizeLines(displayLines(o, {})))}</p>
      <label class="field"><span class="field__label">金額(元)</span>
        <input class="input" name="total" type="number" min="0" step="1" required value="${o.total ?? 0}"></label>
      <label class="field"><span class="field__label">付款方式</span>
        <select class="select" name="payment"><option value="">未指定</option>${paymentOptions(o.payment)}</select></label>
      <label class="field"><span class="field__label">狀態</span>
        <select class="select" name="status">${statuses.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
      <label class="field"><span class="field__label">備註</span>
        <input class="input" name="note" maxlength="100" value="${escapeHtml(o.note || '')}"></label>`,
    actions: [{ label: '儲存', value: 'save' }],
  });
  if (value !== 'save') return;
  await api.adminUpdateOrder(o.id, {
    total: Math.max(0, Math.round(Number(data.get('total')) || 0)),
    payment: data.get('payment') || '',
    status: data.get('status'),
    note: String(data.get('note') || '').trim(),
  });
  toast('已更新', 'success');
  await loadFinance();
}

$('#finance-add').addEventListener('click', async () => {
  const { value, data } = await openDialog({
    title: '新增收支',
    body: `
      <p class="muted text-sm">用於補登未經系統的交易，例如忘記記帳的現場訂單。</p>
      <label class="field"><span class="field__label">項目名稱</span><input class="input" name="name" maxlength="30" required></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1"><span class="field__label">單價(元)</span><input class="input" name="price" type="number" step="1" required></label>
        <label class="field" style="flex:1"><span class="field__label">數量</span><input class="input" name="qty" type="number" min="1" step="1" value="1" required></label>
      </div>
      <label class="field"><span class="field__label">付款方式</span><select class="select" name="payment">${paymentOptions()}</select></label>
      <label class="field"><span class="field__label">備註</span><input class="input" name="note" maxlength="100"></label>`,
    actions: [{ label: '新增', value: 'save' }],
  });
  if (value !== 'save') return;
  const price = Math.round(Number(data.get('price')) || 0);
  const qty = Math.max(1, Math.round(Number(data.get('qty')) || 1));
  const name = String(data.get('name') || '').trim();
  try {
    await api.adminCreateManual({
      lines: [{ itemId: null, name, price, qty, option: null, subtotal: price * qty }],
      total: price * qty, payment: data.get('payment'), note: String(data.get('note') || '').trim(),
    });
    toast('已新增', 'success');
    await loadFinance();
  } catch (err) {
    toast(errorText(err), 'danger');
  }
});

// 匯出 CSV(含電話，請妥善保管檔案)
$('#finance-export').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  if (!financeOrders.length) {
    toast('沒有可匯出的資料', 'danger');
    return;
  }
  let contactMap = {};
  try {
    contactMap = await api.listContacts(financeOrders.map((o) => o.id));
  } catch (err) {
    console.warn(err);
  }
  const header = ['訂單編號', '類型', '狀態', '已刪除', '姓氏', '電話', '品項', '件數', '金額', '付款方式', '送出時間', '確立時間', '取餐時間', '備註'];
  const rows = financeOrders.map((o) => [
    o.no, TYPE_LABEL[o.type] || o.type, STATUS_LABEL[o.status] || o.status, o.deleted ? '是' : '',
    o.surname || '', contactMap[o.id]?.phone ? `="${contactMap[o.id].phone}"` : '', // 公式寫法讓 Excel 保留開頭的 0
    (o.lines || []).map((l) => `${lineLabel(l)}×${l.qty}`).join('、'), o.itemCount ?? '', o.total ?? '',
    o.payment || '', dateTime(o.createdAt), dateTime(o.establishedAt), dateTime(o.pickedAt), o.note || '',
  ]);
  const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  // 加上 BOM，Excel 開啟中文才不會亂碼
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `九愛買收支_${financeForm.from.value}_${financeForm.to.value}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}));

// ===== 帳號 =====
let accounts = [];

async function loadAccounts() {
  try {
    accounts = await api.listAccounts();
    if (!accounts.some((a) => a.uid === profile.uid)) {
      accounts.unshift({ uid: profile.uid, username: profile.username, displayName: profile.displayName, role: 'admin', disabled: false });
    }
    renderAccounts();
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

function renderAccounts() {
  $('#account-rows').innerHTML = accounts.map((a) => `
    <tr data-uid="${a.uid}">
      <td>${escapeHtml(a.username)}</td>
      <td>${escapeHtml(a.displayName || '')}</td>
      <td>${ROLE_LABEL[a.role] || a.role}</td>
      <td>${a.disabled ? '<span class="badge badge--danger">停用</span>' : '<span class="badge badge--success">啟用</span>'}</td>
      <td>${a.role === 'admin' ? '<span class="muted text-sm">管理員帳號請到 Firebase 主控台管理</span>' : `<div class="row" style="flex-wrap:nowrap">
        <button class="btn btn--sm" data-acc-act="edit">${icon('edit', 'icon--sm')}編輯</button>
        <button class="btn btn--sm btn--danger" data-acc-act="delete">${icon('delete', 'icon--sm')}刪除</button></div>`}</td>
    </tr>`).join('');
}

function roleOptions(selected) {
  return ['staff', 'manager'].map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
}

$('#account-add').addEventListener('click', async () => {
  const { value, data } = await openDialog({
    title: '新增帳號',
    body: `
      <label class="field"><span class="field__label">帳號(小寫英文、數字、底線，3 到 20 字)</span>
        <input class="input" name="username" required pattern="[a-z0-9_]{3,20}" autocapitalize="none"></label>
      <label class="field"><span class="field__label">顯示名稱</span><input class="input" name="displayName" maxlength="20" required></label>
      <label class="field"><span class="field__label">權限</span><select class="select" name="role">${roleOptions('staff')}</select></label>
      <label class="field"><span class="field__label">密碼(至少 8 字)</span><input class="input" name="password" type="text" minlength="8" required autocomplete="new-password"></label>`,
    actions: [{ label: '建立', value: 'save' }],
  });
  if (value !== 'save') return;
  try {
    await api.createAccount({
      username: String(data.get('username')).trim().toLowerCase(),
      displayName: String(data.get('displayName')).trim(),
      role: data.get('role'),
      password: String(data.get('password')),
    });
    toast('帳號已建立', 'success');
    await loadAccounts();
  } catch (err) {
    toast(errorText(err), 'danger', 5000);
  }
});

$('#account-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-acc-act]');
  if (!btn) return;
  const a = accounts.find((x) => x.uid === btn.closest('[data-uid]').dataset.uid);
  if (!a) return;
  withBusy(btn, async () => {
    try {
      if (btn.dataset.accAct === 'delete') {
        if (await confirmDialog('刪除帳號', `確定要刪除帳號「${a.username}」嗎？`, { confirmLabel: '刪除', danger: true })) {
          await api.deleteAccount(a.uid);
          toast('已刪除');
          await loadAccounts();
        }
        return;
      }
      const { value, data } = await openDialog({
        title: `編輯 ${a.username}`,
        body: `
          <label class="field"><span class="field__label">顯示名稱</span><input class="input" name="displayName" maxlength="20" required value="${escapeHtml(a.displayName || '')}"></label>
          <label class="field"><span class="field__label">權限</span><select class="select" name="role">${roleOptions(a.role)}</select></label>
          <label class="switch"><input type="checkbox" name="disabled" ${a.disabled ? 'checked' : ''}><span>停用帳號</span></label>
          <label class="field"><span class="field__label">新密碼(不修改請留空，至少 8 字)</span><input class="input" name="password" type="text" minlength="8" autocomplete="new-password"></label>`,
        actions: [{ label: '儲存', value: 'save' }],
      });
      if (value !== 'save') return;
      const patch = {
        displayName: String(data.get('displayName')).trim(),
        role: data.get('role'),
        disabled: data.get('disabled') === 'on',
      };
      if (data.get('password')) patch.password = String(data.get('password'));
      await api.updateAccount(a.uid, patch);
      toast('已更新', 'success');
      await loadAccounts();
    } catch (err) {
      toast(errorText(err), 'danger', 5000);
    }
  });
});

// ===== 系統 =====
$('#reset-counters').addEventListener('click', async (e) => {
  if (!await confirmDialog('編號歸零', '確定要讓訂單編號從 001 重新開始嗎？', { confirmLabel: '歸零', danger: true })) return;
  withBusy(e.currentTarget, async () => {
    try {
      await api.resetCounters();
      toast('編號已歸零', 'success');
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

// 入口頁 QR code(依目前網站網址產生)
const entryUrl = new URL('index.html', location.href).href;
$('#entry-qr').innerHTML = qrSvg(entryUrl);
$('#entry-url').textContent = entryUrl;
$('#print-qr').addEventListener('click', () => {
  const win = window.open('', '_blank');
  if (!win) {
    toast('瀏覽器擋住了新視窗，請允許彈出視窗', 'danger');
    return;
  }
  win.document.write(`<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>九愛！買 點餐 QR code</title>
    <style>body{font-family:sans-serif;text-align:center;padding:40px}svg{width:70mm;height:70mm}h1{font-size:28px}</style></head>
    <body><h1>掃描預先點餐</h1>${qrSvg(entryUrl)}<p>${escapeHtml(entryUrl)}</p></body></html>`);
  win.document.close();
  win.focus();
  win.print();
});

$('#demo-reset').addEventListener('click', async () => {
  if (!await confirmDialog('重設展示資料', '所有展示訂單、品項與設定都會恢復成初始狀態。', { confirmLabel: '重設', danger: true })) return;
  await api.resetDemo();
  location.href = 'login.html';
});

$('#logout').addEventListener('click', async () => {
  if (await confirmDialog('登出', '確定要登出嗎？')) await api.staffLogout();
});

// ===== 初始化 =====
requireStaff('manager', async (p) => {
  profile = p;
  isAdmin = hasRole(p, 'admin');
  $('#who').textContent = `${p.displayName}(${ROLE_LABEL[p.role]})${isAdmin ? '' : '・收支為唯讀'}`;
  for (const el of $$('[data-admin]')) el.hidden = !isAdmin;
  $('#demo-reset-box').hidden = !IS_DEMO;

  try {
    await api.ensureSettings();
  } catch (err) {
    toast(errorText(err), 'danger');
  }

  api.watchSettings((s) => {
    settings = s;
    fillSettings();
  });

  let lastImageKey = '';
  api.watchAllItems(async (list) => {
    items = list;
    renderItems();
    const key = list.map((i) => `${i.id}:${i.imageVersion || 0}`).join('|');
    if (key !== lastImageKey) {
      lastImageKey = key;
      try {
        images = await api.getItemImages(list);
        renderItems();
      } catch (err) {
        console.warn(err);
      }
    }
  });

  selectTab('items');
});
