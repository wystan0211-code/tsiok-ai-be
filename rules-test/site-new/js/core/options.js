// 品項選項群組(仿 Uber Eats)：前台、攤位、後台、展示模式後端共用
//
// 資料格式(存在品項文件 item.optionGroups)：
//   [{ id, name, kind, min, max, choices: [{ id, name, price, soldOut }] }]
//   kind：'required-single' 必填單選 / 'optional-multi' 非必填複選 / 'required-multi' 必填複選
// 翻譯：item.i18n[語言].groups = { 群組ID: { name, choices: { 選項ID: 名稱 } } }
// 顧客的選擇(購物車與訂單)：sel = ['群組ID:選項ID', ...]
//
// 舊格式相容：item.options = ['糖粉', '巧克力']，讀取時自動視為一個「必填單選」群組，
// 群組 ID 為 g0、選項 ID 為 c0、c1…，翻譯沿用 item.i18n[語言].options；資料庫原始內容不會被改動

export const OPTION_KINDS = [
  ['required-single', '必填單選'],
  ['optional-multi', '非必填複選'],
  ['required-multi', '必填複選'],
];
export const MAX_GROUPS = 5;
export const MAX_CHOICES = 10;
export const LEGACY_GROUP_ID = 'g0';
// 舊格式群組的名稱(與 i18n 的 order.optionLegend 相同)
const LEGACY_GROUP_NAME = { 'zh-Hant': '口味 / 選項', en: 'Flavor / option', ja: '味・オプション' };

// 取得品項的選項群組(已整理成新格式)
export function optionGroups(item) {
  if (!item) return [];
  if (Array.isArray(item.optionGroups)) return item.optionGroups.filter((g) => g && g.choices?.length);
  if (Array.isArray(item.options) && item.options.length) {
    return [{
      id: LEGACY_GROUP_ID,
      name: LEGACY_GROUP_NAME['zh-Hant'],
      kind: 'required-single',
      min: 1,
      max: 1,
      legacy: true,
      choices: item.options.map((name, i) => ({ id: `c${i}`, name, price: 0, soldOut: false })),
    }];
  }
  return [];
}

export function hasOptions(item) {
  return optionGroups(item).length > 0;
}

// 群組的選擇數量規則：{ min, max, required, multi }
export function groupRule(group) {
  const count = group.choices?.length || 0;
  if (group.kind === 'required-single') return { min: 1, max: 1, required: true, multi: false };
  const max = Math.max(1, Math.min(count || 1, Number(group.max) || count || 1));
  if (group.kind === 'required-multi') {
    const min = Math.max(1, Math.min(max, Number(group.min) || 1));
    return { min, max, required: true, multi: true };
  }
  return { min: 0, max, required: false, multi: true };
}

// 群組標題下方的規則說明(依語言)
export function ruleText(group, lang = 'zh-Hant') {
  const { min, max, multi } = groupRule(group);
  // 必填單選，或必填複選且最少等於最多：「選擇 N」；其他複選：「最多可選擇 N 個項目」
  if (!multi || min === max) {
    if (lang === 'en') return `Choose ${min}`;
    if (lang === 'ja') return `${min}つ選択`;
    return `選擇 ${min}`;
  }
  if (lang === 'en') return `Choose up to ${max}`;
  if (lang === 'ja') return `${max}つまで選択できます`;
  return `最多可選擇 ${max} 個項目`;
}

// 群組與選項名稱(依語言；沒有翻譯時用中文)
export function groupName(item, group, lang = 'zh-Hant') {
  if (lang === 'zh-Hant') return group.name;
  if (group.legacy) return LEGACY_GROUP_NAME[lang] || group.name;
  return item?.i18n?.[lang]?.groups?.[group.id]?.name || group.name;
}

export function choiceName(item, group, choice, lang = 'zh-Hant') {
  if (lang === 'zh-Hant') return choice.name;
  if (group.legacy) {
    const idx = Number(choice.id.slice(1));
    return item?.i18n?.[lang]?.options?.[idx] || choice.name;
  }
  return item?.i18n?.[lang]?.groups?.[group.id]?.choices?.[choice.id] || choice.name;
}

// 選項排列：供應中在前、售完在後(各自維持原本順序)
export function sortedChoices(group) {
  const list = group.choices || [];
  return [...list.filter((c) => !c.soldOut), ...list.filter((c) => c.soldOut)];
}

// 必填群組可選的選項不足時，整個品項無法下單(自動視為售完)
export function blockedByOptions(item) {
  return optionGroups(item).some((g) => {
    const { min } = groupRule(g);
    return min > 0 && g.choices.filter((c) => !c.soldOut).length < min;
  });
}

// 舊訂單或舊購物車只有 option 文字：換成 sel
function legacySel(item, option) {
  if (option == null) return [];
  const g = optionGroups(item).find((x) => x.legacy);
  const c = g?.choices.find((x) => x.name === option);
  return g && c ? [`${g.id}:${c.id}`] : [];
}

// 整理選擇：只保留存在的群組與選項，依群組與選項的順序排列；單選與上限超出的部分捨去
export function normalizeSel(item, line) {
  const raw = Array.isArray(line?.sel) ? line.sel : legacySel(item, line?.option);
  const set = new Set(raw);
  const out = [];
  for (const g of optionGroups(item)) {
    const { max } = groupRule(g);
    const picked = g.choices.filter((c) => set.has(`${g.id}:${c.id}`)).slice(0, max);
    for (const c of picked) out.push(`${g.id}:${c.id}`);
  }
  return out;
}

// 已選的選項：[{ group, choice }]
export function selectedChoices(item, sel) {
  const set = new Set(sel || []);
  const out = [];
  for (const g of optionGroups(item)) {
    for (const c of g.choices) if (set.has(`${g.id}:${c.id}`)) out.push({ group: g, choice: c });
  }
  return out;
}

// 選項加價總和
export function selPrice(item, sel) {
  return selectedChoices(item, sel).reduce((s, { choice }) => s + (Math.max(0, Number(choice.price) || 0)), 0);
}

// 選項文字，例如「少冰、半糖、加珍珠」
export function selText(item, sel, lang = 'zh-Hant') {
  const sep = lang === 'zh-Hant' || lang === 'ja' ? '、' : ', ';
  return selectedChoices(item, sel).map(({ group, choice }) => choiceName(item, group, choice, lang)).join(sep);
}

// 購物車合併用的鍵(相同品項、相同選擇視為同一列)
export function selKey(sel) {
  return (sel || []).slice().sort().join('|');
}

// 檢查選擇是否完整：回傳未滿足規則的群組 [{ group, reason: 'required'|'too-many'|'soldout' }]
export function selProblems(item, sel) {
  const set = new Set(sel || []);
  const problems = [];
  for (const g of optionGroups(item)) {
    const { min, max } = groupRule(g);
    const picked = g.choices.filter((c) => set.has(`${g.id}:${c.id}`));
    if (picked.some((c) => c.soldOut)) problems.push({ group: g, reason: 'soldout' });
    else if (picked.length < min) problems.push({ group: g, reason: 'required' });
    else if (picked.length > max) problems.push({ group: g, reason: 'too-many' });
  }
  return problems;
}

// 加價金額顯示：「+$ 15」
export function addOnText(price) {
  return price > 0 ? `+$ ${Number(price).toLocaleString('zh-TW')}` : '';
}
