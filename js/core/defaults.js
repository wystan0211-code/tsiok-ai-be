// 預設設定：Firestore 尚未建立設定文件時使用，管理後台第一次開啟時會自動寫入

export const DEFAULT_SETTINGS = {
  stallName: '九愛！買',
  // 跑馬燈(菜單頁標題列下方)：bannerText 為內容、bannerActive 為開關
  bannerText: '',
  bannerActive: false,
  // 引導我去攤位(訂單進度頁)：guideType 為 'map'(Google 地圖嵌入)或 'image'(位置圖)，未設定時顯示「即將公布」
  guideActive: true,
  guideType: '',
  guideMapUrl: '',
  guideImageVersion: 0,
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
  // 顧客看得到的文字的英文與日文版本(後台儲存時自動翻譯，可手動修改)
  i18n: {
    en: {
      bannerText: '',
      consentText: 'I agree that the stall may use my last name and phone number to notify me when my order is ready.',
      messageTemplates: [
        'Your order is ready. Please pick it up at the stall.',
        'Your order is being prepared. Please wait a moment.',
        'Some items are sold out. Please check with the stall.',
      ],
      smsTemplate: '【九愛！買】{surname}, your order {no} is ready. Please show your order number at the stall to pick it up.',
    },
    ja: {
      bannerText: '',
      consentText: '料理の準備ができた際に受け取りのお知らせをするため、入力した名字と電話番号を屋台が利用することに同意します。',
      messageTemplates: [
        '料理ができました。屋台でお受け取りください。',
        'ただいま調理中です。もう少々お待ちください。',
        '一部の商品が売り切れました。屋台でご確認ください。',
      ],
      smsTemplate: '【九愛！買】{surname}、ご注文 {no} の準備ができました。屋台で注文番号を提示してお受け取りください。',
    },
  },
};

// 展示模式的示範分類
export const DEMO_CATEGORIES = [
  { id: 'demo-cat-sweet', name: '甜點', sortOrder: 1, i18n: { en: { name: 'Desserts' }, ja: { name: 'スイーツ' } } },
  { id: 'demo-cat-drink', name: '飲料', sortOrder: 2, i18n: { en: { name: 'Drinks' }, ja: { name: 'ドリンク' } } },
];

// 展示模式的示範品項
export const DEMO_ITEMS = [
  {
    id: 'demo-donut', name: '甜甜圈', price: 30, description: '現炸甜甜圈，外酥內軟。',
    prepMinutes: 8, options: ['糖粉', '巧克力', '原味'], stockLimit: 60, soldCount: 0,
    active: true, soldOut: false, sortOrder: 1, hasImage: false, imageVersion: 0,
    categoryId: 'demo-cat-sweet', featured: true, tags: ['人氣'],
    i18n: {
      en: { name: 'Donut', description: 'Freshly fried: crispy outside, soft inside.', options: ['Powdered sugar', 'Chocolate', 'Plain'], tags: ['Popular'] },
      ja: { name: 'ドーナツ', description: '揚げたてで、外はサクッと中はふんわり。', options: ['粉砂糖', 'チョコレート', 'プレーン'], tags: ['人気'] },
    },
  },
  {
    id: 'demo-cake', name: '雞蛋糕', price: 50, description: '一份 6 顆，現烤出爐。',
    prepMinutes: 10, options: [], stockLimit: null, soldCount: 0,
    active: true, soldOut: false, sortOrder: 2, hasImage: false, imageVersion: 0,
    categoryId: 'demo-cat-sweet', featured: true, tags: [],
    i18n: {
      en: { name: 'Taiwanese egg cakes', description: '6 pieces per serving, freshly baked.', options: [] },
      ja: { name: 'ベビーカステラ', description: '1人前6個、焼きたてです。', options: [] },
    },
  },
  {
    id: 'demo-tea', name: '古早味紅茶', price: 20, description: '冰涼解渴。',
    prepMinutes: 1, options: [], stockLimit: null, soldCount: 0,
    active: true, soldOut: false, sortOrder: 3, hasImage: false, imageVersion: 0,
    categoryId: 'demo-cat-drink', featured: false, tags: [],
    // 選項群組示範：必填單選(冰度，含一個售完選項)、非必填複選(加料，有加價，最多 2 項)
    optionGroups: [
      { id: 'g-ice', name: '冰度', kind: 'required-single', min: 1, max: 1, choices: [
        { id: 'c-reg', name: '正常冰', price: 0, soldOut: false },
        { id: 'c-less', name: '少冰', price: 0, soldOut: false },
        { id: 'c-none', name: '去冰', price: 0, soldOut: true },
      ] },
      { id: 'g-top', name: '加料', kind: 'optional-multi', min: 0, max: 2, choices: [
        { id: 'c-pearl', name: '珍珠', price: 10, soldOut: false },
        { id: 'c-jelly', name: '椰果', price: 10, soldOut: false },
        { id: 'c-taro', name: '芋圓', price: 15, soldOut: false },
      ] },
    ],
    i18n: {
      en: { name: 'Old-fashioned black tea', description: 'Ice-cold and refreshing.', options: [],
        groups: { 'g-ice': { name: 'Ice level', choices: { 'c-reg': 'Regular ice', 'c-less': 'Less ice', 'c-none': 'No ice' } },
          'g-top': { name: 'Toppings', choices: { 'c-pearl': 'Tapioca pearls', 'c-jelly': 'Coconut jelly', 'c-taro': 'Taro balls' } } } },
      ja: { name: '昔ながらの紅茶', description: '冷たくてすっきり。', options: [],
        groups: { 'g-ice': { name: '氷の量', choices: { 'c-reg': '氷普通', 'c-less': '氷少なめ', 'c-none': '氷なし' } },
          'g-top': { name: 'トッピング', choices: { 'c-pearl': 'タピオカ', 'c-jelly': 'ナタデココ', 'c-taro': 'タロイモ団子' } } } },
    },
  },
];

// 展示模式的示範帳號(僅存在瀏覽器中，正式版由管理員建立)
export const DEMO_USERS = [
  { uid: 'demo-admin', username: 'admin', password: 'admin1234', displayName: '管理員', role: 'admin', disabled: false },
  { uid: 'demo-manager', username: 'manager', password: 'manager1234', displayName: '攤位主管', role: 'manager', disabled: false },
  { uid: 'demo-staff', username: 'staff', password: 'staff1234', displayName: '店員小明', role: 'staff', disabled: false },
];
