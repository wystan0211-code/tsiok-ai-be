// 管理後台：品項、營業設定、收支(攤位主管可檢視，管理員可編輯)、帳號與系統(僅管理員)
import { api, IS_DEMO } from '../api/index.js';
import {
  $, $$, icon, toast, openDialog, confirmDialog, showDemoBanner, withBusy,
} from '../core/ui.js';
import { errorText } from '../core/errors.js';
import { requireStaff, hasRole } from '../core/guard.js';
import {
  escapeHtml, money, dateTime, toDateInput, fromDateInput, personName,
  STATUS_LABEL, TYPE_LABEL, ROLE_LABEL,
} from '../core/format.js';
import { displayLines, isPaid, lineLabel, summarizeLines } from '../core/order-logic.js';
import { compressImage } from '../core/image.js';
import { cropItemImage, cropBannerImage } from '../core/cropper.js';
import { itemImageRefs, MAX_ITEM_IMAGES, MAX_BANNERS } from '../core/images.js';
import { randomToken } from '../core/format.js';
import { qrSvg } from '../core/qr.js';

showDemoBanner(IS_DEMO);

let profile = null;
let isAdmin = false;
let items = [];
let categories = [];
let banners = [];
let images = {};
const MAX_FEATURED = 5;
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

// ===== 菜單分類 =====
const catName = (id) => categories.find((c) => c.id === id)?.name || '';

function renderCategories() {
  const box = $('#cat-list');
  if (!categories.length) {
    box.innerHTML = '<p class="muted text-sm">尚未建立分類</p>';
    return;
  }
  box.innerHTML = categories.map((c, i) => {
    const count = items.filter((it) => it.categoryId === c.id).length;
    return `<div class="cat-row" data-cat="${c.id}">
      <span class="cat-row__name">${escapeHtml(c.name)} <span class="muted text-sm">${count} 項</span></span>
      <button class="btn btn--ghost btn--icon" data-cat-act="up" ${i === 0 ? 'disabled' : ''} aria-label="上移">${icon('arrow_upward')}</button>
      <button class="btn btn--ghost btn--icon" data-cat-act="down" ${i === categories.length - 1 ? 'disabled' : ''} aria-label="下移">${icon('arrow_downward')}</button>
      <button class="btn btn--ghost btn--icon" data-cat-act="edit" aria-label="編輯">${icon('edit')}</button>
      <button class="btn btn--ghost btn--icon" data-cat-act="delete" aria-label="刪除">${icon('delete')}</button>
    </div>`;
  }).join('');
}

async function editCategory(cat) {
  const { value, data } = await openDialog({
    title: cat ? `編輯分類 ${cat.name}` : '新增分類',
    body: `
      <label class="field"><span class="field__label">分類名稱</span>
        <input class="input" name="name" maxlength="16" required value="${escapeHtml(cat?.name || '')}"></label>
      <details class="tr-box">
        <summary>英文與日文翻譯(儲存時自動翻譯，可手動修改)</summary>
        ${TR_LANGS.map(([lang, label]) => `<label class="field"><span class="field__hint">${label}</span>
          <input class="input" name="tr_${lang}_name" maxlength="40" value="${escapeHtml(cat?.i18n?.[lang]?.name || '')}"></label>`).join('')}
      </details>`,
    actions: [{ label: '儲存', value: 'save' }],
  });
  if (value !== 'save') return;
  const name = str(data.get('name'));
  if (!name) {
    toast('請填寫分類名稱', 'danger');
    return;
  }
  const changed = name !== (cat?.name || '');
  const i18n = {};
  const todo = [];
  for (const [lang] of TR_LANGS) {
    const typed = str(data.get(`tr_${lang}_name`));
    i18n[lang] = { name: typed };
    if (needAuto(typed, cat?.i18n?.[lang]?.name, changed)) todo.push(lang);
  }
  let notice = { auto: 0, failed: false };
  if (todo.length) {
    const res = await api.translate([name], todo);
    if (res) {
      todo.forEach((lang) => { i18n[lang].name = res[lang]?.[0] || ''; });
      notice = { auto: todo.length, failed: false };
    } else notice = { auto: 0, failed: true };
  }
  try {
    await api.saveCategory({
      ...(cat ? { id: cat.id } : { sortOrder: Math.max(0, ...categories.map((c) => c.sortOrder || 0)) + 1 }),
      name, i18n,
    });
    toast(translateNotice(notice), notice.failed ? 'info' : 'success');
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

$('#cat-add').addEventListener('click', () => editCategory(null));

$('#cat-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat-act]');
  if (!btn) return;
  const id = btn.closest('[data-cat]').dataset.cat;
  const index = categories.findIndex((c) => c.id === id);
  const cat = categories[index];
  withBusy(btn, async () => {
    try {
      const act = btn.dataset.catAct;
      if (act === 'edit') await editCategory(cat);
      if (act === 'delete') {
        if (await confirmDialog('刪除分類', `確定要刪除分類「${cat.name}」嗎？裡面的品項不會被刪除，會改為未分類。`, { confirmLabel: '刪除', danger: true })) {
          await api.deleteCategory(id);
          for (const it of items.filter((x) => x.categoryId === id)) await api.saveItem({ id: it.id, categoryId: null });
          toast('已刪除分類');
        }
      }
      if (act === 'up' || act === 'down') {
        const target = act === 'up' ? index - 1 : index + 1;
        const order = categories.slice();
        [order[index], order[target]] = [order[target], order[index]];
        for (const [i, c] of order.entries()) {
          if (c.sortOrder !== i + 1) await api.saveCategory({ id: c.id, sortOrder: i + 1 });
        }
      }
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

// ===== 品項 =====
function renderItems() {
  renderCategories();
  const rows = $('#item-rows');
  if (!items.length) {
    rows.innerHTML = '<tr><td colspan="7" class="empty">尚未建立品項</td></tr>';
    return;
  }
  rows.innerHTML = items.map((it, i) => {
    const status = [
      it.active ? '<span class="badge badge--success">上架</span>' : '<span class="badge">下架</span>',
      it.soldOut ? '<span class="badge badge--danger">售完</span>' : '',
      it.featured ? '<span class="badge badge--primary">推薦</span>' : '',
    ].join(' ');
    const count = itemImageRefs(it).length;
    const thumb = images[it.id]
      ? `<img src="${images[it.id]}" alt="" class="admin-thumb">`
      : `<span class="muted">${icon('image')}</span>`;
    const meta = [catName(it.categoryId) || '未分類', ...(it.tags || []).map((t) => `#${t}`)].join('・');
    return `<tr data-item="${it.id}">
      <td>${thumb}${count > 1 ? `<div class="muted text-xs">${count} 張</div>` : ''}</td>
      <td><strong>${escapeHtml(it.name)}</strong><div class="muted text-sm">${escapeHtml(meta)}</div>${it.options?.length ? `<div class="muted text-sm">選項：${escapeHtml(it.options.join('、'))}</div>` : ''}</td>
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

// ===== 英文與日文翻譯 =====
const TR_LANGS = [['en', '英文'], ['ja', '日文']];
const str = (v) => String(v ?? '').trim();

// 需要自動翻譯：翻譯欄位是空的，或中文改了但翻譯沒有被手動修改過
function needAuto(typed, oldTr, srcChanged) {
  return !typed || (srcChanged && typed === (oldTr || ''));
}

function itemTrFields(item) {
  return `
    <details class="tr-box">
      <summary>英文與日文翻譯(儲存時自動翻譯，可手動修改)</summary>
      ${TR_LANGS.map(([lang, label]) => {
        const tr = item?.i18n?.[lang] || {};
        return `<fieldset class="tr-box__lang">
          <legend class="field__label">${label}</legend>
          <label class="field"><span class="field__hint">名稱</span>
            <input class="input" name="tr_${lang}_name" maxlength="60" value="${escapeHtml(tr.name || '')}"></label>
          <label class="field"><span class="field__hint">說明</span>
            <textarea class="textarea" name="tr_${lang}_description" maxlength="600" rows="2">${escapeHtml(tr.description || '')}</textarea></label>
          <label class="field"><span class="field__hint">選項(用頓號、分隔，順序與中文相同)</span>
            <input class="input" name="tr_${lang}_options" value="${escapeHtml((tr.options || []).join('、'))}"></label>
          <label class="field"><span class="field__hint">標籤(用頓號、分隔，順序與中文相同)</span>
            <input class="input" name="tr_${lang}_tags" value="${escapeHtml((tr.tags || []).join('、'))}"></label>
        </fieldset>`;
      }).join('')}
    </details>`;
}

// 依表單內容產生品項翻譯；回傳 { i18n, auto: 自動翻譯的欄位數, failed: 翻譯服務無法使用 }
async function buildItemI18n(payload, oldItem, data) {
  const old = oldItem || {};
  const changed = {
    name: payload.name !== (old.name || ''),
    description: payload.description !== (old.description || ''),
    options: payload.options.join('、') !== (old.options || []).join('、'),
    tags: payload.tags.join('、') !== (old.tags || []).join('、'),
  };
  const listNeedsAuto = (typed, src, oldTr, srcChanged) => src.length && (typed.length !== src.length
    || (srcChanged && typed.join('、') === (oldTr || []).join('、')));
  const result = {};
  const todo = [];
  for (const [lang] of TR_LANGS) {
    const oldTr = old.i18n?.[lang] || {};
    const typed = {
      name: str(data.get(`tr_${lang}_name`)),
      description: payload.description ? str(data.get(`tr_${lang}_description`)) : '',
      options: payload.options.length ? splitList(data.get(`tr_${lang}_options`)) : [],
      tags: payload.tags.length ? splitList(data.get(`tr_${lang}_tags`)) : [],
    };
    result[lang] = typed;
    if (needAuto(typed.name, oldTr.name, changed.name)) todo.push([lang, 'name']);
    if (payload.description && needAuto(typed.description, oldTr.description, changed.description)) todo.push([lang, 'description']);
    if (listNeedsAuto(typed.options, payload.options, oldTr.options, changed.options)) todo.push([lang, 'options']);
    if (listNeedsAuto(typed.tags, payload.tags, oldTr.tags, changed.tags)) todo.push([lang, 'tags']);
  }
  if (!todo.length) return { i18n: result, auto: 0, failed: false };
  const langs = [...new Set(todo.map(([l]) => l))];
  const optStart = 2;
  const tagStart = 2 + payload.options.length;
  const res = await api.translate([payload.name, payload.description, ...payload.options, ...payload.tags], langs);
  if (!res) return { i18n: result, auto: 0, failed: true };
  for (const [lang, field] of todo) {
    const list = res[lang];
    if (!list) continue;
    if (field === 'name') result[lang].name = list[0] || '';
    if (field === 'description') result[lang].description = list[1] || '';
    if (field === 'options') result[lang].options = list.slice(optStart, tagStart);
    if (field === 'tags') result[lang].tags = list.slice(tagStart);
  }
  return { i18n: result, auto: todo.length, failed: false };
}

function translateNotice({ auto, failed }) {
  if (failed) return '已儲存。自動翻譯目前無法使用，英文與日文可在「翻譯」區手動填寫。';
  if (auto) return '已儲存，並自動翻譯成英文與日文。機器翻譯可能不自然，建議檢查一次。';
  return '已儲存';
}

// ===== 品項照片管理(最多 10 張，第一張為封面) =====
// list 中每張：{ id, legacy, src(小圖預覽), isNew, small, large }
function imageManager(dlg, list) {
  const box = dlg.querySelector('[data-img-mgr]');
  const input = dlg.querySelector('[data-img-file]');
  let dragIndex = -1;

  const render = () => {
    box.innerHTML = list.map((img, i) => `
      <div class="img-tile" draggable="true" data-index="${i}">
        <img src="${img.src}" alt="">
        ${i === 0 ? '<span class="img-tile__cover">封面</span>' : ''}
        <div class="img-tile__bar">
          <button type="button" class="img-tile__btn" data-img-act="left" ${i === 0 ? 'disabled' : ''} aria-label="往前">${icon('chevron_left', 'icon--sm')}</button>
          <button type="button" class="img-tile__btn" data-img-act="del" aria-label="刪除">${icon('delete', 'icon--sm')}</button>
          <button type="button" class="img-tile__btn" data-img-act="right" ${i === list.length - 1 ? 'disabled' : ''} aria-label="往後">${icon('chevron_right', 'icon--sm')}</button>
        </div>
      </div>`).join('') + (list.length < MAX_ITEM_IMAGES ? `
      <button type="button" class="img-tile img-tile--add" data-img-act="add">
        ${icon('add_photo_alternate')}<span class="text-sm">新增照片</span><span class="muted text-xs">${list.length} / ${MAX_ITEM_IMAGES}</span>
      </button>` : '');
  };

  const move = (from, to) => {
    if (to < 0 || to >= list.length || from === to) return;
    const [img] = list.splice(from, 1);
    list.splice(to, 0, img);
    render();
  };

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-img-act]');
    if (!btn) return;
    const i = Number(btn.closest('[data-index]')?.dataset.index);
    const act = btn.dataset.imgAct;
    if (act === 'add') input.click();
    if (act === 'left') move(i, i - 1);
    if (act === 'right') move(i, i + 1);
    if (act === 'del') {
      list.splice(i, 1);
      render();
    }
  });

  // 電腦版可直接拖曳排序
  box.addEventListener('dragstart', (e) => {
    dragIndex = Number(e.target.closest('[data-index]')?.dataset.index ?? -1);
  });
  box.addEventListener('dragover', (e) => e.preventDefault());
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = Number(e.target.closest('[data-index]')?.dataset.index ?? -1);
    if (dragIndex >= 0 && target >= 0) move(dragIndex, target);
    dragIndex = -1;
  });

  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    const room = MAX_ITEM_IMAGES - list.length;
    if (files.length > room) toast(`每個品項最多 ${MAX_ITEM_IMAGES} 張，只會加入前 ${room} 張`, 'info', 5000);
    for (const file of files.slice(0, room)) {
      try {
        const out = await cropItemImage(file);
        if (!out) continue;
        list.push({ id: randomToken(8), isNew: true, src: out[0], small: out[0], large: out[1] });
        render();
      } catch (err) {
        toast(err.message || '圖片無法使用', 'danger');
      }
    }
  });

  render();
}

async function editItem(item) {
  const it = item || {
    name: '', price: 0, description: '', prepMinutes: 5, options: [], stockLimit: null,
    soldCount: 0, active: true, soldOut: false, categoryId: null, featured: false, tags: [],
  };
  // 現有照片：先載入小圖當預覽
  const refs = item ? itemImageRefs(item) : [];
  let thumbs = {};
  if (refs.length) {
    try {
      thumbs = await api.getImages(refs, 's');
    } catch (err) {
      console.warn(err);
    }
  }
  // 舊格式的照片(只有一份)直接轉成新格式：大小圖都用原本那一份，儲存時刪除舊資料
  const imgList = refs.map((r) => (r.legacy
    ? { id: randomToken(8), isNew: true, src: thumbs[r.id], small: thumbs[r.id], large: thumbs[r.id] }
    : { ...r, src: thumbs[r.id] || '' })).filter((img) => img.src || !img.isNew);
  const featuredOthers = items.filter((x) => x.featured && x.id !== item?.id).length;
  const canFeature = it.featured || featuredOthers < MAX_FEATURED;

  const { value, data } = await openDialog({
    title: item ? `編輯 ${item.name}` : '新增品項',
    size: 'wide',
    body: `
      <div class="field">
        <span class="field__label">照片(最多 ${MAX_ITEM_IMAGES} 張，第一張為菜單封面；可用箭頭或拖曳調整順序)</span>
        <div class="img-grid" data-img-mgr></div>
        <input type="file" accept="image/*" multiple hidden data-img-file>
      </div>
      <label class="field"><span class="field__label">名稱</span>
        <input class="input" name="name" maxlength="20" required value="${escapeHtml(it.name)}"></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1"><span class="field__label">價格(元)</span>
          <input class="input" name="price" type="number" min="0" max="9999" step="1" required value="${it.price}"></label>
        <label class="field" style="flex:1"><span class="field__label">製作時間(分鐘)</span>
          <input class="input" name="prepMinutes" type="number" min="0" max="120" step="1" value="${it.prepMinutes || 0}"></label>
      </div>
      <label class="field"><span class="field__label">分類</span>
        <select class="select" name="categoryId">
          <option value="">未分類</option>
          ${categories.map((c) => `<option value="${c.id}" ${c.id === it.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select></label>
      <label class="field"><span class="field__label">說明</span>
        <textarea class="textarea" name="description" maxlength="300" rows="3">${escapeHtml(it.description || '')}</textarea>
        <span class="field__hint">菜單只顯示第一行，完整內容在品項詳細頁顯示</span></label>
      <label class="field"><span class="field__label">選項(用頓號、分隔，例如：糖粉、巧克力)</span>
        <input class="input" name="options" value="${escapeHtml((it.options || []).join('、'))}">
        <span class="field__hint">留空代表沒有選項；有選項時顧客必須選一個</span></label>
      <label class="field"><span class="field__label">標籤(用頓號、分隔，例如：人氣、辣)</span>
        <input class="input" name="tags" maxlength="60" value="${escapeHtml((it.tags || []).join('、'))}"></label>
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1"><span class="field__label">數量上限(留空為不限)</span>
          <input class="input" name="stockLimit" type="number" min="0" step="1" value="${it.stockLimit ?? ''}"></label>
        <label class="field" style="flex:1"><span class="field__label">已售數量</span>
          <input class="input" name="soldCount" type="number" min="0" step="1" value="${it.soldCount || 0}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="active" ${it.active ? 'checked' : ''}><span>上架</span></label>
      <label class="switch"><input type="checkbox" name="soldOut" ${it.soldOut ? 'checked' : ''}><span>標示售完</span></label>
      <label class="switch"><input type="checkbox" name="featured" ${it.featured ? 'checked' : ''} ${canFeature ? '' : 'disabled'}><span>顯示在推薦區${canFeature ? '' : `(已達 ${MAX_FEATURED} 個上限)`}</span></label>
      ${itemTrFields(item)}`,
    actions: [{ label: '儲存', value: 'save' }],
    onOpen: (dlg) => imageManager(dlg, imgList),
  });
  if (value !== 'save') return;
  const stockRaw = String(data.get('stockLimit') || '').trim();
  const payload = {
    name: String(data.get('name')).trim(),
    price: Math.max(0, Math.round(Number(data.get('price')) || 0)),
    prepMinutes: Math.max(0, Math.round(Number(data.get('prepMinutes')) || 0)),
    description: String(data.get('description') || '').trim(),
    options: splitList(data.get('options')),
    tags: splitList(data.get('tags')).slice(0, 5),
    categoryId: data.get('categoryId') || null,
    stockLimit: stockRaw === '' ? null : Math.max(0, Math.round(Number(stockRaw))),
    soldCount: Math.max(0, Math.round(Number(data.get('soldCount')) || 0)),
    active: data.get('active') === 'on',
    soldOut: data.get('soldOut') === 'on',
    featured: data.get('featured') === 'on',
  };
  if (!payload.name) {
    toast('請填寫名稱', 'danger');
    return;
  }
  if (!item) payload.sortOrder = Math.max(0, ...items.map((i) => i.sortOrder || 0)) + 1;
  try {
    const tr = await buildItemI18n(payload, item, data);
    payload.i18n = tr.i18n;
    const id = await api.saveItem(item ? { id: item.id, ...payload } : payload);
    // 照片有變動才更新
    const order = imgList.map((img) => img.id);
    const before = refs.map((r) => r.id);
    const removed = refs.filter((r) => r.legacy || !order.includes(r.id));
    const added = imgList.filter((img) => img.isNew);
    if (added.length || removed.length || order.join() !== before.join()) {
      await api.saveItemImages(id, {
        add: added.map(({ id: imgId, small, large }) => ({ id: imgId, small, large })),
        order,
        remove: removed,
      });
    }
    toast(translateNotice(tr), tr.failed ? 'info' : 'success', tr.auto || tr.failed ? 6000 : 3200);
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
        if (await confirmDialog('刪除品項', `確定要刪除「${item.name}」嗎？照片會一併刪除，已成立的訂單明細不受影響。`, { confirmLabel: '刪除', danger: true })) {
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

// ===== 橫幅輪播(最多 5 張) =====
function renderBanners() {
  const box = $('#banner-list');
  box.innerHTML = banners.length ? banners.map((b, i) => `
    <div class="banner-admin__row" data-banner="${b.id}">
      <img src="${b.data}" alt="橫幅 ${i + 1}">
      <span class="text-sm">第 ${i + 1} 張</span>
      <button class="btn btn--ghost btn--icon" data-banner-act="up" ${i === 0 ? 'disabled' : ''} aria-label="上移">${icon('arrow_upward')}</button>
      <button class="btn btn--ghost btn--icon" data-banner-act="down" ${i === banners.length - 1 ? 'disabled' : ''} aria-label="下移">${icon('arrow_downward')}</button>
      <button class="btn btn--ghost btn--icon" data-banner-act="delete" aria-label="刪除">${icon('delete')}</button>
    </div>`).join('') : '<p class="muted text-sm">尚未上傳橫幅，點餐頁不會顯示輪播。</p>';
  $('#banner-add').disabled = banners.length >= MAX_BANNERS;
}

$('#banner-add').addEventListener('click', () => $('#banner-file').click());

$('#banner-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const out = await cropBannerImage(file);
    if (!out) return;
    await api.addBanner(out[0], Math.max(0, ...banners.map((b) => b.sortOrder || 0)) + 1);
    toast('已新增橫幅', 'success');
  } catch (err) {
    toast(err.message && !err.code ? err.message : errorText(err), 'danger');
  }
});

$('#banner-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-banner-act]');
  if (!btn) return;
  const id = btn.closest('[data-banner]').dataset.banner;
  const index = banners.findIndex((b) => b.id === id);
  withBusy(btn, async () => {
    try {
      const act = btn.dataset.bannerAct;
      if (act === 'delete') {
        if (await confirmDialog('刪除橫幅', `確定要刪除第 ${index + 1} 張橫幅嗎？`, { confirmLabel: '刪除', danger: true })) {
          await api.deleteBanner(id);
        }
        return;
      }
      const target = act === 'up' ? index - 1 : index + 1;
      const ids = banners.map((b) => b.id);
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await api.reorderBanners(ids);
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
  f.showStockLeft.checked = settings.showStockLeft !== false;
  f.maxItemsPerOrder.value = settings.maxItemsPerOrder;
  f.pickupReminderMinutes.value = settings.pickupReminderMinutes;
  f.paymentMethods.value = (settings.paymentMethods || []).join('、');
  f.messageTemplates.value = (settings.messageTemplates || []).join('\n');
  f.smsTemplate.value = settings.smsTemplate || '';
  f.consentText.value = settings.consentText || '';
  f.guideActive.checked = settings.guideActive !== false;
  const gt = f.querySelector(`[name=guideType][value="${settings.guideType || ''}"]`);
  if (gt) gt.checked = true;
  f.guideMapUrl.value = settings.guideMapUrl || '';
  updateGuideFields();
  loadGuidePreview();
  for (const [lang] of TR_LANGS) {
    const tr = settings.i18n?.[lang] || {};
    f[`tr_${lang}_bannerText`].value = tr.bannerText || '';
    f[`tr_${lang}_consentText`].value = tr.consentText || '';
    f[`tr_${lang}_messageTemplates`].value = (tr.messageTemplates || []).join('\n');
    f[`tr_${lang}_smsTemplate`].value = tr.smsTemplate || '';
  }
}

// 依設定表單產生翻譯；規則與品項相同
async function buildSettingsI18n(patch, old, f) {
  const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const result = {};
  const todo = []; // [lang, 欄位, 原文索引]
  const texts = [patch.bannerText, patch.consentText, patch.smsTemplate, ...patch.messageTemplates];
  const changed = {
    bannerText: patch.bannerText !== (old.bannerText || ''),
    consentText: patch.consentText !== (old.consentText || ''),
    smsTemplate: patch.smsTemplate !== (old.smsTemplate || ''),
    messageTemplates: patch.messageTemplates.join('\n') !== (old.messageTemplates || []).join('\n'),
  };
  for (const [lang] of TR_LANGS) {
    const oldTr = old.i18n?.[lang] || {};
    const typed = {
      bannerText: patch.bannerText ? str(f[`tr_${lang}_bannerText`].value) : '',
      consentText: str(f[`tr_${lang}_consentText`].value),
      smsTemplate: str(f[`tr_${lang}_smsTemplate`].value),
      messageTemplates: lines(f[`tr_${lang}_messageTemplates`].value),
    };
    result[lang] = typed;
    ['bannerText', 'consentText', 'smsTemplate'].forEach((key, i) => {
      if (patch[key] && needAuto(typed[key], oldTr[key], changed[key])) todo.push([lang, key, i]);
    });
    if (patch.messageTemplates.length && (typed.messageTemplates.length !== patch.messageTemplates.length
      || (changed.messageTemplates && typed.messageTemplates.join('\n') === (oldTr.messageTemplates || []).join('\n')))) {
      todo.push([lang, 'messageTemplates', 3]);
    }
  }
  if (!todo.length) return { i18n: result, auto: 0, failed: false };
  const res = await api.translate(texts, [...new Set(todo.map(([l]) => l))]);
  if (!res) return { i18n: result, auto: 0, failed: true };
  for (const [lang, key, i] of todo) {
    const list = res[lang];
    if (!list) continue;
    result[lang][key] = key === 'messageTemplates' ? list.slice(3) : (list[i] || '');
  }
  return { i18n: result, auto: todo.length, failed: false };
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
      showStockLeft: f.showStockLeft.checked,
      maxItemsPerOrder: Math.max(1, Math.round(Number(f.maxItemsPerOrder.value) || 10)),
      pickupReminderMinutes: Math.max(1, Math.round(Number(f.pickupReminderMinutes.value) || 15)),
      paymentMethods: splitList(f.paymentMethods.value),
      messageTemplates: f.messageTemplates.value.split('\n').map((s) => s.trim()).filter(Boolean),
      smsTemplate: f.smsTemplate.value.trim(),
      consentText: f.consentText.value.trim(),
      guideActive: f.guideActive.checked,
      guideType: f.elements.guideType.value || '',
      guideMapUrl: '',
    };
    if (!patch.paymentMethods.length) {
      toast('至少需要一種付款方式', 'danger');
      return;
    }
    // Google 地圖：可貼整段嵌入碼或網址，只保留 https://www.google.com/maps/embed 開頭的網址
    const rawMap = f.guideMapUrl.value.trim();
    if (rawMap) {
      const url = extractMapUrl(rawMap);
      if (!url) {
        toast('Google 地圖嵌入碼不正確：請到 Google 地圖 > 分享 > 嵌入地圖，複製 HTML 貼上', 'danger', 6000);
        return;
      }
      patch.guideMapUrl = url;
    }
    if (patch.guideType === 'map' && !patch.guideMapUrl) {
      toast('請貼上 Google 地圖嵌入碼，或把顯示內容改為「尚未設定」', 'danger', 5000);
      return;
    }
    try {
      const tr = await buildSettingsI18n(patch, settings || {}, f);
      patch.i18n = tr.i18n;
      await api.saveSettings(patch);
      f.dataset.dirty = '0';
      $('#settings-note').textContent = '';
      toast(translateNotice(tr), tr.failed ? 'info' : 'success', tr.auto || tr.failed ? 6000 : 3200);
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  });
});

// ===== 引導我去攤位 =====
function extractMapUrl(raw) {
  const m = raw.match(/src\s*=\s*["']([^"']+)["']/i);
  const url = (m ? m[1] : raw).replace(/&amp;/g, '&').trim();
  return /^https:\/\/www\.google\.com\/maps\/embed\?/.test(url) ? url : '';
}

function updateGuideFields() {
  const type = $('#settings-form').elements.guideType.value;
  for (const el of $$('[data-guide]')) el.hidden = el.dataset.guide !== type;
}

$('#settings-form').addEventListener('change', (e) => {
  if (e.target.name === 'guideType') updateGuideFields();
});

async function loadGuidePreview() {
  const img = $('#guide-preview');
  let data = null;
  try {
    data = settings?.guideImageVersion ? await api.getSiteImage('guide') : null;
  } catch (err) {
    console.warn(err);
  }
  img.hidden = !data;
  $('#guide-remove').hidden = !data;
  if (data) img.src = data;
}

$('#guide-upload').addEventListener('click', () => $('#guide-file').click());

$('#guide-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    // 位置圖維持原比例，只壓縮大小
    const dataUrl = await compressImage(file, 1200);
    await api.setSiteImage('guide', dataUrl);
    await api.saveSettings({ guideImageVersion: Date.now() });
    toast('已更新位置圖片', 'success');
  } catch (err) {
    toast(err.message && !err.code ? err.message : errorText(err), 'danger');
  }
});

$('#guide-remove').addEventListener('click', async () => {
  if (!await confirmDialog('移除位置圖片', '確定要移除位置圖片嗎？', { confirmLabel: '移除', danger: true })) return;
  try {
    await api.setSiteImage('guide', null);
    await api.saveSettings({ guideImageVersion: 0 });
    toast('已移除');
  } catch (err) {
    toast(errorText(err), 'danger');
  }
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
      <td>${o.deleted ? '已刪除' : (o.voided ? '已作廢' : (STATUS_LABEL[o.status] || o.status))}</td>
      <td>${dateTime(o.establishedAt || o.createdAt)}</td>
      <td>${escapeHtml(personName(o.surname, o.title))}</td>
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
    o.no, TYPE_LABEL[o.type] || o.type, o.voided ? '已作廢' : (STATUS_LABEL[o.status] || o.status), o.deleted ? '是' : '',
    personName(o.surname, o.title), contactMap[o.id]?.phone ? `="${contactMap[o.id].phone}"` : '', // 公式寫法讓 Excel 保留開頭的 0
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

// 作廢所有未完成訂單：雙重確認(先看清單，再輸入文字)，只改狀態不刪除資料，不通知顧客
const VOID_WORD = '確認作廢';
$('#void-orders').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  try {
    const list = await api.listUnfinishedOrders();
    if (!list.length) {
      toast('目前沒有未完成的訂單');
      return;
    }
    const rows = list.map((o) => `<li><strong>${escapeHtml(o.no)}</strong> ${escapeHtml(STATUS_LABEL[o.status] || o.status)}<span class="muted"> · ${escapeHtml(dateTime(o.createdAt))}</span></li>`).join('');
    const first = await openDialog({
      title: `作廢 ${list.length} 張未完成訂單？`,
      body: `<p>以下訂單會改為「已取消」並標記為作廢。資料與收支紀錄會保留，不會通知顧客；已扣除的品項庫存不會加回。</p>
        <ul class="void-list">${rows}</ul>`,
      actions: [{ label: '下一步', value: 'next', variant: 'danger' }],
      cancelLabel: '取消',
    });
    if (first.value !== 'next') return;
    const second = await openDialog({
      title: '最後確認',
      body: `<p>這個動作無法復原。請輸入「${VOID_WORD}」後按作廢。</p>
        <label class="field"><input class="input" name="word" autocomplete="off" placeholder="${VOID_WORD}"></label>`,
      actions: [{ label: `作廢 ${list.length} 張`, value: 'ok', variant: 'danger-solid' }],
      cancelLabel: '取消',
      onOpen(dlg) {
        const input = dlg.querySelector('input[name=word]');
        const btn = dlg.querySelector('button[value=ok]');
        btn.disabled = true;
        input.addEventListener('input', () => { btn.disabled = input.value.trim() !== VOID_WORD; });
        input.focus();
      },
    });
    if (second.value !== 'ok' || String(second.data.get('word') || '').trim() !== VOID_WORD) return;
    const n = await api.voidOrders(list.map((o) => o.id));
    toast(`已作廢 ${n} 張訂單`, 'success');
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}));

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

  api.watchCategories((list) => {
    categories = list;
    renderItems();
  });

  api.watchBanners((list) => {
    banners = list;
    renderBanners();
  });

  let lastImageKey = '';
  api.watchAllItems(async (list) => {
    items = list;
    renderItems();
    const key = list.map((i) => `${i.id}:${(i.images || []).join(',')}:${i.imageVersion || 0}`).join('|');
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
