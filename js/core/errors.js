// 統一的錯誤類別：code 用於程式判斷，message 直接顯示給使用者

export const ERROR_MESSAGES = {
  closed: '攤位目前暫停接受預點，請直接到攤位點餐。',
  'over-limit': '單筆預點數量超過上限，請直接到攤位點餐。',
  'phone-active': '這支電話已有進行中的訂單，取餐完成後才能再預點。',
  'session-invalid': '點餐連結已失效，請重新掃描攤位的 QR code。',
  'active-order': '你有一筆進行中的訂單，完成後才能再預點。',
  'sold-out': '部分品項已售完或數量不足。',
  'not-found': '找不到這筆訂單。',
  'bad-state': '訂單狀態已經變更，請重新整理。',
  auth: '帳號或密碼錯誤。',
  permission: '沒有權限執行此操作。',
  network: '網路連線異常，請稍後再試。',
  'no-endpoint': '尚未設定 Apps Script 網址，無法使用此功能。',
  'push-unsupported': '這個瀏覽器不支援推播通知。',
  'push-denied': '通知權限被拒絕，請到瀏覽器設定開啟。',
  claimed: '這張訂單已經綁定到其他裝置。',
  'username-taken': '帳號名稱已被使用。',
  invalid: '資料格式不正確。',
  unknown: '發生未預期的錯誤，請稍後再試。',
};

export class ApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown);
    this.code = code;
    Object.assign(this, extra);
  }
}

// 把任何錯誤轉成可顯示的文字
export function errorText(err) {
  if (err instanceof ApiError) return err.message;
  console.error(err);
  return ERROR_MESSAGES.unknown;
}
