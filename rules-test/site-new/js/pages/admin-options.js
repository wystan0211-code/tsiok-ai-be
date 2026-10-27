// 後台：品項的選項群組編輯器(必填單選、非必填複選、必填複選)
// 包含：新增 / 排序 / 刪除群組與選項、加價、售完開關、一次貼上多個選項、從其他品項複製、顧客畫面即時預覽、英日翻譯
import { api } from '../api/index.js';
import { $, $$, icon, openDialog } from '../core/ui.js';
import { escapeHtml, randomToken } from '../core/format.js';
import {
  OPTION_KINDS, MAX_GROUPS, MAX_CHOICES, optionGroups, groupRule, ruleText, groupName, choiceName,
  sortedChoices, addOnText,
} from '../core/options.js';

const LANGS = [['en', '英文'], ['ja', '日文']];
const newId = (prefix) => `${prefix}${randomToken(4)}`;
const clean = (v) => String(v ?? '').trim();

// 一次貼上多個選項：用頓號、逗號或換行分隔
function splitNames(value) {
  return String(value || '').split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
}

// ===== 由品項建立可編輯的狀態(含翻譯) =====
export function groupsFromItem(item) {
  return optionGroups(item).map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    min: groupRule(g).min,
    max: groupRule(g).max,
    choices: g.choices.map((c) => ({ id: c.id, name: c.name, price: Number(c.price) || 0, soldOut: !!c.soldOut })),
    // 只保留真正有翻譯的文字；沒有翻譯(與中文相同)時留空，儲存時自動翻譯
    tr: Object.fromEntries(LANGS.map(([lang]) => {
      const gName = groupName(item, g, lang);
      return [lang, {
        name: gName !== g.name ? gName : '',
        choices: Object.fromEntries(g.choices.map((c) => {
          const cName = choiceName(item, g, c, lang);
          return [c.id, cName !== c.name ? cName : ''];
        })),
      }];
    })),
  }));
}

function emptyTr() {
  return Object.fromEntries(LANGS.map(([lang]) => [lang, { name: '', choices: {} }]));
}

// 深拷貝(複製到其他品項時換新的 ID)
function cloneGroup(g, fresh = false) {
  const gid = fresh ? newId('g') : g.id;
  const idMap = {};
  const choices = g.choices.map((c) => {
    const cid = fresh ? newId('c') : c.id;
    idMap[c.id] = cid;
    // 複製到其他品項時，售完狀態一律恢復為供應中
    return { ...c, id: cid, soldOut: fresh ? false : c.soldOut };
  });
  const tr = emptyTr();
  for (const [lang] of LANGS) {
    tr[lang].name = g.tr?.[lang]?.name || '';
    for (const [oldId, val] of Object.entries(g.tr?.[lang]?.choices || {})) {
      if (idMap[oldId]) tr[lang].choices[idMap[oldId]] = val;
    }
  }
  return { ...g, id: gid, choices, tr };
}

// ===== 檢查(儲存前)：回傳錯誤訊息，沒有問題時回傳空字串 =====
export function validateGroups(groups) {
  for (const [i, g] of groups.entries()) {
    const label = g.name ? `「${g.name}」` : `第 ${i + 1} 個群組`;
    if (!clean(g.name)) return `請填寫第 ${i + 1} 個選項群組的名稱`;
    const named = g.choices.filter((c) => clean(c.name));
    if (!named.length) return `${label}至少要有一個選項`;
    const names = named.map((c) => clean(c.name));
    if (new Set(names).size !== names.length) return `${label}有重複的選項名稱`;
    if (g.kind !== 'required-single') {
      if (g.max < 1 || g.max > named.length) return `${label}的「最多可選」要在 1 到 ${named.length} 之間`;
      if (g.kind === 'required-multi' && (g.min < 1 || g.min > g.max)) return `${label}的「最少要選」要在 1 到 ${g.max} 之間`;
    }
  }
  return '';
}

// ===== 儲存用的資料 =====
export function groupsForSave(groups) {
  return groups.map((g) => {
    const choices = g.choices.filter((c) => clean(c.name)).map((c) => ({
      id: c.id, name: clean(c.name), price: Math.max(0, Math.round(Number(c.price) || 0)), soldOut: !!c.soldOut,
    }));
    const max = g.kind === 'required-single' ? 1 : Math.max(1, Math.min(choices.length, Math.round(g.max) || 1));
    const min = g.kind === 'required-single' ? 1 : (g.kind === 'required-multi' ? Math.max(1, Math.min(max, Math.round(g.min) || 1)) : 0);
    return { id: g.id, name: clean(g.name), kind: g.kind, min, max, choices };
  });
}

// ===== 翻譯：空白，或中文改了但翻譯沒有手動改過，才自動翻譯；回傳 { groups: {en, ja}, auto, failed } =====
export async function buildGroupI18n(groups, oldItem) {
  const oldGroups = Object.fromEntries(groupsFromItem(oldItem).map((g) => [g.id, g]));
  const result = Object.fromEntries(LANGS.map(([lang]) => [lang, {}]));
  const todo = []; // [lang, groupId, choiceId|null, 中文]
  for (const g of groups) {
    const old = oldGroups[g.id];
    for (const [lang] of LANGS) {
      const tr = g.tr?.[lang] || { name: '', choices: {} };
      const out = { name: clean(tr.name), choices: {} };
      const gChanged = !old || old.name !== g.name;
      if (!out.name || (gChanged && out.name === (old?.tr?.[lang]?.name || ''))) todo.push([lang, g.id, null, g.name]);
      for (const c of g.choices) {
        const typed = clean(tr.choices?.[c.id]);
        const oldC = old?.choices.find((x) => x.id === c.id);
        const cChanged = !oldC || oldC.name !== c.name;
        out.choices[c.id] = typed;
        if (!typed || (cChanged && typed === (old?.tr?.[lang]?.choices?.[c.id] || ''))) todo.push([lang, g.id, c.id, c.name]);
      }
      result[lang][g.id] = out;
    }
  }
  if (!todo.length) return { groups: result, auto: 0, failed: false };
  // 相同的中文只翻一次；Apps Script 每次最多 50 筆，分批送出
  const texts = [...new Set(todo.map((x) => x[3]))];
  const langs = [...new Set(todo.map((x) => x[0]))];
  const translated = Object.fromEntries(langs.map((l) => [l, {}]));
  for (let i = 0; i < texts.length; i += 50) {
    const chunk = texts.slice(i, i + 50);
    const res = await api.translate(chunk, langs);
    if (!res) return { groups: result, auto: 0, failed: true };
    for (const l of langs) chunk.forEach((txt, j) => { translated[l][txt] = res[l]?.[j] || ''; });
  }
  for (const [lang, gid, cid, zh] of todo) {
    const val = translated[lang]?.[zh] || '';
    if (cid) result[lang][gid].choices[cid] = val;
    else result[lang][gid].name = val;
  }
  return { groups: result, auto: todo.length, failed: false };
}

// ===== 編輯器畫面 =====
export function groupEditorHtml() {
  return `
    <div class="og-editor-wrap"><div class="og-editor" data-og-root>
      <div class="og-editor__main">
        <div class="og-editor__head">
          <span class="field__label">選項群組(最多 ${MAX_GROUPS} 組，每組最多 ${MAX_CHOICES} 個選項)</span>
          <div class="row">
            <button type="button" class="btn btn--sm" data-og="copy">${icon('content_copy', 'icon--sm')}從其他品項複製</button>
            <button type="button" class="btn btn--sm" data-og="add-group">${icon('add', 'icon--sm')}新增選項群組</button>
          </div>
        </div>
        <div class="og-editor__list" data-og-list></div>
        <button type="button" class="btn btn--sm btn--ghost og-editor__preview-toggle" data-og="preview" aria-expanded="false">${icon('visibility', 'icon--sm')}預覽顧客畫面</button>
      </div>
      <aside class="og-editor__preview" data-og-preview aria-label="顧客畫面預覽"></aside>
    </div></div>`;
}

function kindRadios(g, gi) {
  return `<div class="radio-group">${OPTION_KINDS.map(([value, label]) => `
    <label class="radio-chip"><input type="radio" name="og_kind_${gi}" value="${value}" data-og-field="kind" ${g.kind === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
}

function numberField(label, field, value, min, max) {
  return `<label class="og-num"><span class="field__hint">${label}</span>
    <input class="input" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${value}" data-og-field="${field}"></label>`;
}

function groupCardHtml(g, gi, total) {
  const named = g.choices.length;
  let rule = '';
  if (g.kind === 'optional-multi') rule = numberField('最多可選', 'max', g.max, 1, Math.max(1, named));
  if (g.kind === 'required-multi') {
    rule = `${numberField('最少要選', 'min', g.min, 1, Math.max(1, g.max))}${numberField('最多可選', 'max', g.max, 1, Math.max(1, named))}`;
  }
  const choices = g.choices.map((c, ci) => `
    <div class="og-choice ${c.soldOut ? 'is-soldout' : ''}" data-ci="${ci}">
      <input class="input og-choice__name" placeholder="選項名稱(可一次貼上多個，用頓號分隔)" maxlength="20" value="${escapeHtml(c.name)}" data-og-field="choice-name">
      <label class="og-choice__price"><span class="visually-hidden">加價</span>
        <span class="og-choice__plus" aria-hidden="true">+$</span>
        <input class="input" type="number" inputmode="numeric" min="0" max="9999" step="1" placeholder="0" value="${c.price || ''}" data-og-field="choice-price"></label>
      <label class="switch og-choice__soldout"><input type="checkbox" data-og-field="choice-soldout" ${c.soldOut ? 'checked' : ''}><span>售完</span></label>
      <div class="og-choice__acts">
        <button type="button" class="btn btn--ghost btn--icon" data-og="choice-up" ${ci === 0 ? 'disabled' : ''} aria-label="上移">${icon('arrow_upward', 'icon--sm')}</button>
        <button type="button" class="btn btn--ghost btn--icon" data-og="choice-down" ${ci === g.choices.length - 1 ? 'disabled' : ''} aria-label="下移">${icon('arrow_downward', 'icon--sm')}</button>
        <button type="button" class="btn btn--ghost btn--icon" data-og="choice-del" aria-label="刪除選項">${icon('close', 'icon--sm')}</button>
      </div>
    </div>`).join('');
  const trFields = LANGS.map(([lang, label]) => `
    <fieldset class="tr-box__lang">
      <legend class="field__label">${label}</legend>
      <label class="field"><span class="field__hint">群組名稱</span>
        <input class="input" maxlength="40" value="${escapeHtml(g.tr?.[lang]?.name || '')}" data-og-field="tr-name" data-lang="${lang}"></label>
      ${g.choices.map((c) => `<label class="field"><span class="field__hint">${escapeHtml(c.name || '(未命名選項)')}</span>
        <input class="input" maxlength="40" value="${escapeHtml(g.tr?.[lang]?.choices?.[c.id] || '')}" data-og-field="tr-choice" data-lang="${lang}" data-cid="${c.id}"></label>`).join('')}
    </fieldset>`).join('');
  return `
    <section class="og-card" data-gi="${gi}">
      <div class="og-card__head">
        <input class="input og-card__name" placeholder="群組名稱，例如：冰度" maxlength="20" value="${escapeHtml(g.name)}" data-og-field="name" aria-label="群組名稱">
        <button type="button" class="btn btn--ghost btn--icon" data-og="group-up" ${gi === 0 ? 'disabled' : ''} aria-label="群組上移">${icon('arrow_upward', 'icon--sm')}</button>
        <button type="button" class="btn btn--ghost btn--icon" data-og="group-down" ${gi === total - 1 ? 'disabled' : ''} aria-label="群組下移">${icon('arrow_downward', 'icon--sm')}</button>
        <button type="button" class="btn btn--ghost btn--icon" data-og="group-del" aria-label="刪除群組">${icon('delete', 'icon--sm')}</button>
      </div>
      ${kindRadios(g, gi)}
      ${rule ? `<div class="og-card__rule">${rule}</div>` : ''}
      <div class="og-card__choices">${choices}</div>
      <button type="button" class="btn btn--sm" data-og="add-choice" ${g.choices.length >= MAX_CHOICES ? 'disabled' : ''}>${icon('add', 'icon--sm')}新增選項(${g.choices.length} / ${MAX_CHOICES})</button>
      <details class="tr-box og-card__tr">
        <summary>英文與日文翻譯(儲存時自動翻譯，可手動修改)</summary>
        ${trFields}
      </details>
    </section>`;
}

// 顧客畫面預覽(中文，格式與點餐頁相同)
function previewHtml(groups) {
  const list = groupsForSave(groups).filter((g) => g.name && g.choices.length);
  if (!list.length) return '<p class="muted text-sm og-preview__empty">新增選項群組後，這裡會顯示顧客看到的樣子</p>';
  return `<div class="og-preview__phone"><div class="og-list">${list.map((g) => {
    const { required, multi } = groupRule(g);
    return `<section class="og">
      <div class="og__head">
        <div><h2 class="og__title">${escapeHtml(g.name)}</h2><p class="og__rule">${escapeHtml(ruleText(g))}</p></div>
        ${required ? '<span class="og__req">必填</span>' : ''}
      </div>
      <div class="og__rows">${sortedChoices(g).map((c) => `
        <div class="og__row ${c.soldOut ? 'og__row--soldout' : ''}">
          <span class="og__text"><span class="og__name">${escapeHtml(c.name)}</span>
            ${c.soldOut ? '<span class="og__price">售完</span>' : (c.price > 0 ? `<span class="og__price">${addOnText(c.price)}</span>` : '')}</span>
          <span class="og__mark og__mark--${multi ? 'check' : 'radio'}" aria-hidden="true">${multi ? icon('check', 'icon--sm') : ''}</span>
        </div>`).join('')}</div>
    </section>`;
  }).join('')}</div></div>`;
}

/**
 * 在對話框中掛上編輯器
 * @param {HTMLElement} dlg
 * @param {Array} groups 可編輯的狀態(會直接修改)
 * @param {{ items: Array, currentId: string|null, onChange?: Function }} ctx
 */
export function mountGroupEditor(dlg, groups, { items, currentId }) {
  const root = $('[data-og-root]', dlg);
  const list = $('[data-og-list]', root);
  const preview = $('[data-og-preview]', root);

  const renderPreview = () => { preview.innerHTML = previewHtml(groups); };
  const render = () => {
    list.innerHTML = groups.length
      ? groups.map((g, gi) => groupCardHtml(g, gi, groups.length)).join('')
      : '<p class="muted text-sm">沒有選項群組時，顧客按「+」會直接加入購物車</p>';
    $('[data-og="add-group"]', root).disabled = groups.length >= MAX_GROUPS;
    renderPreview();
  };

  const groupOf = (el) => groups[Number(el.closest('[data-gi]')?.dataset.gi)];
  const choiceIndex = (el) => Number(el.closest('[data-ci]')?.dataset.ci);

  // 文字與數字輸入：只更新狀態與預覽，不重畫整個編輯器(避免輸入中斷)
  root.addEventListener('input', (e) => {
    const field = e.target.dataset.ogField;
    const g = groupOf(e.target);
    if (!field || !g) return;
    const ci = choiceIndex(e.target);
    if (field === 'name') g.name = e.target.value;
    if (field === 'choice-name') g.choices[ci].name = e.target.value;
    if (field === 'choice-price') g.choices[ci].price = Math.max(0, Math.round(Number(e.target.value) || 0));
    if (field === 'min') g.min = Math.round(Number(e.target.value) || 1);
    if (field === 'max') g.max = Math.round(Number(e.target.value) || 1);
    if (field === 'tr-name') g.tr[e.target.dataset.lang].name = e.target.value;
    if (field === 'tr-choice') g.tr[e.target.dataset.lang].choices[e.target.dataset.cid] = e.target.value;
    renderPreview();
  });

  root.addEventListener('change', (e) => {
    const field = e.target.dataset.ogField;
    const g = groupOf(e.target);
    if (!field || !g) return;
    const ci = choiceIndex(e.target);
    if (field === 'kind') {
      g.kind = e.target.value;
      const count = Math.max(1, g.choices.length);
      if (g.kind === 'optional-multi') g.max = Math.min(Math.max(g.max || count, 1), count);
      if (g.kind === 'required-multi') {
        g.max = Math.min(Math.max(g.max || count, 1), count);
        g.min = Math.min(Math.max(g.min || 1, 1), g.max);
      }
      render();
    }
    if (field === 'choice-soldout') {
      g.choices[ci].soldOut = e.target.checked;
      render();
    }
    // 名稱含頓號、逗號或換行：拆成多個選項
    if (field === 'choice-name') {
      const parts = splitNames(e.target.value);
      if (parts.length > 1) {
        g.choices[ci].name = parts[0];
        const room = MAX_CHOICES - g.choices.length;
        const extra = parts.slice(1, 1 + room).map((name) => ({ id: newId('c'), name, price: 0, soldOut: false }));
        g.choices.splice(ci + 1, 0, ...extra);
        render();
      }
    }
    if (field === 'min' || field === 'max') render();
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-og]');
    if (!btn) return;
    const act = btn.dataset.og;
    const g = groupOf(btn);
    const gi = groups.indexOf(g);
    const ci = choiceIndex(btn);
    if (act === 'add-group' && groups.length < MAX_GROUPS) {
      groups.push({ id: newId('g'), name: '', kind: 'required-single', min: 1, max: 1, choices: [{ id: newId('c'), name: '', price: 0, soldOut: false }], tr: emptyTr() });
      render();
      $$('.og-card__name', list).at(-1)?.focus();
    }
    if (act === 'group-up' && gi > 0) [groups[gi - 1], groups[gi]] = [groups[gi], groups[gi - 1]];
    if (act === 'group-down' && gi < groups.length - 1) [groups[gi + 1], groups[gi]] = [groups[gi], groups[gi + 1]];
    if (act === 'group-del') groups.splice(gi, 1);
    if (act === 'add-choice' && g.choices.length < MAX_CHOICES) {
      g.choices.push({ id: newId('c'), name: '', price: 0, soldOut: false });
      render();
      $$(`[data-gi="${gi}"] .og-choice__name`, list).at(-1)?.focus();
      return;
    }
    if (act === 'choice-up' && ci > 0) [g.choices[ci - 1], g.choices[ci]] = [g.choices[ci], g.choices[ci - 1]];
    if (act === 'choice-down' && ci < g.choices.length - 1) [g.choices[ci + 1], g.choices[ci]] = [g.choices[ci], g.choices[ci + 1]];
    if (act === 'choice-del') g.choices.splice(ci, 1);
    if (act === 'preview') {
      const open = !root.classList.contains('is-preview-open');
      root.classList.toggle('is-preview-open', open);
      btn.setAttribute('aria-expanded', String(open));
      return;
    }
    if (act === 'copy') {
      await copyFromItem(groups, items, currentId);
    }
    if (act !== 'add-group') render();
  });

  render();
}

// 從其他品項複製選項群組(加在目前群組的後面，超過上限的部分不複製)
async function copyFromItem(groups, items, currentId) {
  const sources = items.filter((it) => it.id !== currentId && optionGroups(it).length);
  if (!sources.length) {
    await openDialog({ title: '從其他品項複製', body: '<p>其他品項目前都沒有選項群組。</p>', cancelLabel: '' });
    return;
  }
  const { value, data } = await openDialog({
    title: '從其他品項複製選項群組',
    body: `<p class="muted text-sm">勾選要複製的群組，會加在目前群組的後面(含翻譯與加價)。</p>
      ${sources.map((it) => `<fieldset class="field og-copy">
        <legend class="field__label">${escapeHtml(it.name)}</legend>
        ${optionGroups(it).map((g) => `<label class="og-copy__row"><input type="checkbox" name="copy" value="${escapeHtml(`${it.id}|${g.id}`)}">
          <span>${escapeHtml(g.name)}<span class="muted text-sm">・${OPTION_KINDS.find(([k]) => k === g.kind)?.[1] || ''}・${g.choices.map((c) => c.name).join('、')}</span></span></label>`).join('')}
      </fieldset>`).join('')}`,
    actions: [{ label: '複製', value: 'copy' }],
  });
  if (value !== 'copy') return;
  for (const key of data.getAll('copy')) {
    if (groups.length >= MAX_GROUPS) break;
    const [itemId, gid] = key.split('|');
    const src = groupsFromItem(items.find((it) => it.id === itemId)).find((g) => g.id === gid);
    if (src) groups.push(cloneGroup(src, true));
  }
}
