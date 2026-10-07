// 品項照片的共用規則
// 新格式：item.images = ['照片ID', ...]，第一張是封面；每張照片在 itemImages 存兩份：
//   itemImages/{照片ID}_s(小圖，菜單用)、itemImages/{照片ID}_l(大圖，詳細頁用)
// 舊格式：item.hasImage = true，照片存在 itemImages/{品項ID}，大小圖共用同一份

export const MAX_ITEM_IMAGES = 10;
export const MAX_BANNERS = 5;

// 回傳品項的照片參照：[{ id, legacy }]
export function itemImageRefs(item) {
  if (Array.isArray(item?.images) && item.images.length) {
    return item.images.map((id) => ({ id, legacy: false }));
  }
  if (item?.hasImage) return [{ id: item.id, legacy: true }];
  return [];
}

// 照片在 itemImages 集合中的文件 ID
export function imageDocId(refItem, size) {
  return refItem.legacy ? refItem.id : `${refItem.id}_${size === 'l' ? 'l' : 's'}`;
}

// 快取鍵：照片 ID + 尺寸
export function imageKey(refItem, size) {
  return `${imageDocId(refItem, size)}`;
}
