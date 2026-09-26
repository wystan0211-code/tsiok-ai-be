// 預設設定：Firestore 尚未建立設定文件時使用，管理後台第一次開啟時會自動寫入

export const DEFAULT_SETTINGS = {
  stallName: '九愛！買',
  bannerText: '',
  bannerActive: false,
  acceptingPreorders: true,
  maxItemsPerOrder: 10,
  pickupReminderMinutes: 15,
  showStockLeft: true, // 顧客端是否顯示「剩 N 份」
  consentText: '我同意攤位使用我填寫的姓氏與電話，於餐點完成時通知我取餐。',
  messageTemplates: [
    '您的餐點已完成，請至攤位取餐。',
    '餐點製作中，請再稍候片刻。',
    '部分品項已售完，請至攤位確認。',
  ],
  smsTemplate: '【九愛！買】{surname}您好，您的訂單 {no} 已完成，請至攤位出示編號取餐。',
  paymentMethods: ['園遊券', '現金'],
};

// 展示模式的示範品項
export const DEMO_ITEMS = [
  {
    id: 'demo-donut', name: '甜甜圈', price: 30, description: '現炸甜甜圈，外酥內軟。',
    prepMinutes: 8, options: ['糖粉', '巧克力', '原味'], stockLimit: 60, soldCount: 0,
    active: true, soldOut: false, sortOrder: 1, hasImage: false, imageVersion: 0,
  },
  {
    id: 'demo-cake', name: '雞蛋糕', price: 50, description: '一份 6 顆，現烤出爐。',
    prepMinutes: 10, options: [], stockLimit: null, soldCount: 0,
    active: true, soldOut: false, sortOrder: 2, hasImage: false, imageVersion: 0,
  },
  {
    id: 'demo-tea', name: '古早味紅茶', price: 20, description: '冰涼解渴。',
    prepMinutes: 1, options: ['正常冰', '少冰'], stockLimit: null, soldCount: 0,
    active: true, soldOut: false, sortOrder: 3, hasImage: false, imageVersion: 0,
  },
];

// 展示模式的示範帳號(僅存在瀏覽器中，正式版由管理員建立)
export const DEMO_USERS = [
  { uid: 'demo-admin', username: 'admin', password: 'admin1234', displayName: '管理員', role: 'admin', disabled: false },
  { uid: 'demo-manager', username: 'manager', password: 'manager1234', displayName: '攤位主管', role: 'manager', disabled: false },
  { uid: 'demo-staff', username: 'staff', password: 'staff1234', displayName: '店員小明', role: 'staff', disabled: false },
];
