// 多語言模組：只用在顧客點餐頁面(首頁、點餐、訂單進度)
// 頁面的 <html> 需標記 data-i18n-page="on" 才會套用所選語言；攤位與後台一律使用中文
// 「九愛！買」為商標，任何語言都不翻譯

const KEY = 'tab-lang';

export const LANGS = [
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
];

const CODES = LANGS.map((l) => l.code);
const IS_CUSTOMER_PAGE = document.documentElement.dataset.i18nPage === 'on';

export function getLang() {
  if (!IS_CUSTOMER_PAGE) return 'zh-Hant';
  try {
    const v = localStorage.getItem(KEY);
    return CODES.includes(v) ? v : 'zh-Hant';
  } catch {
    return 'zh-Hant';
  }
}

export function setLang(code) {
  try {
    localStorage.setItem(KEY, CODES.includes(code) ? code : 'zh-Hant');
  } catch {
    // 無法儲存時只影響這一頁
  }
  applyLang();
}

// 字典：[繁體中文, English, 日本語]；{名稱} 為代入的變數
const DICT = {
  // 共用
  'common.loading': ['載入中', 'Loading', '読み込み中'],
  'common.cancel': ['取消', 'Cancel', 'キャンセル'],
  'common.ok': ['確定', 'OK', 'OK'],
  'common.gotIt': ['知道了', 'Got it', 'わかりました'],
  'common.back': ['返回', 'Back', '戻る'],
  'common.language': ['語言', 'Language', '言語'],

  // 首頁
  'home.title': ['九愛！買｜預先點餐', '九愛！買 | Pre-order', '九愛！買｜事前注文'],
  'home.alt': ['九愛！買 Tsiok ài bé。線上先點餐。就是快 Just Grab & Go', '九愛！買 Tsiok ài bé. Just Grab & GO', '九愛！買 Tsiok ài bé。サッと手に取って、そのまま出発'],
  'home.start': ['開始', 'Start', 'はじめる'],
  'home.viewOrder': ['查看訂單進度', 'Track my order', '注文状況を見る'],
  'home.closed': ['攤位目前暫停接受預點，請直接到攤位點餐', 'Pre-orders are paused. Please order at the stall.', 'ただいま事前注文を停止しています。屋台で直接ご注文ください。'],
  'home.findOrder': ['找回我的訂單', 'Find my order', '注文を探す'],

  // 點餐頁
  'order.title': ['九愛！買｜點餐', '九愛！買 | Order', '九愛！買｜注文'],
  'order.back': ['返回菜單', 'Back to menu', 'メニューに戻る'],
  'order.invalid': ['點餐連結已失效，請重新掃描攤位的 QR code。', 'This ordering link has expired. Please scan the QR code at the stall again.', 'この注文リンクは無効になりました。屋台のQRコードをもう一度読み取ってください。'],
  'order.invalidUsed': ['這個點餐連結已經送出過訂單。', 'An order has already been placed with this link.', 'このリンクからはすでに注文が送信されています。'],
  'order.toEntry': ['回到入口', 'Back to start', 'トップに戻る'],
  'order.closed': ['攤位目前暫停接受預點，請直接到攤位點餐。', 'Pre-orders are paused. Please order at the stall.', 'ただいま事前注文を停止しています。屋台で直接ご注文ください。'],
  'order.emptyMenu': ['目前沒有上架的品項', 'No items are available right now.', '現在ご注文いただける商品はありません。'],
  'order.soldOut': ['已售完', 'Sold out', '売り切れ'],
  'order.addedCount': ['已加入 {n} 份', '{n} added', '{n}個追加済み'],
  'order.add': ['加入 {name}', 'Add {name}', '{name}を追加'],
  'order.decrease': ['減少 {name}', 'Remove one {name}', '{name}を1つ減らす'],
  'order.increase': ['增加 {name}', 'Add one more {name}', '{name}を1つ増やす'],
  'order.decreaseShort': ['減少', 'Remove one', '1つ減らす'],
  'order.increaseShort': ['增加', 'Add one', '1つ増やす'],
  'order.prep': ['約 {n} 分鐘', 'About {n} min', '約{n}分'],
  'order.left': ['剩 {n} 份', '{n} left', '残り{n}個'],
  'order.cartBar': ['查看訂單 · {count} · {total}', 'View order · {count} · {total}', '注文を確認 · {count} · {total}'],
  'order.checkoutTitle': ['確認訂單', 'Review order', '注文内容の確認'],
  'order.qty': ['數量', 'Quantity', '数量'],
  'order.total': ['總金額', 'Total', '合計金額'],
  'order.payNote': ['請至攤位以園遊券付款', 'Please pay with festival vouchers at the stall.', 'お支払いは屋台にて金券（園遊券）でお願いします。'],
  'order.limitWarn': ['為了避免惡意棄單，如欲購買大量請至攤位。', 'To prevent abandoned orders, please order large quantities at the stall.', 'いたずら注文防止のため、大量のご注文は屋台で直接お願いします。'],
  'order.contactTitle': ['取餐聯絡資料', 'Pickup contact details', '受け取り用の連絡先'],
  'order.surname': ['姓氏', 'Last name', '名字（姓）'],
  'order.titleLegend': ['稱謂', 'Title', '性別'],
  'title.先生': ['先生', 'Mr.', '男性'],
  'title.小姐': ['小姐', 'Ms.', '女性'],
  'title.其他': ['其他', 'Other', 'その他'],
  'order.phone': ['手機號碼', 'Mobile number', '携帯電話番号'],
  'order.submit': ['送出訂單', 'Place order', '注文を確定する'],
  'order.optionLegend': ['口味 / 選項', 'Flavor / option', '味・オプション'],
  'order.added': ['已加入', 'Added', '追加しました'],
  'order.errSurname': ['請填寫姓氏。', 'Please enter your last name.', '名字を入力してください。'],
  'order.errTitle': ['請選擇稱謂。', 'Please choose a title.', '性別を選択してください。'],
  'order.errPhone': ['手機號碼格式不正確，請輸入 09 開頭的 10 碼號碼。', 'Invalid mobile number. Please enter a 10-digit Taiwan number starting with 09.', '携帯電話番号の形式が正しくありません。09で始まる10桁の台湾の番号を入力してください。'],
  'order.errConsent': ['請勾選同意取餐通知。', 'Please agree to receive pickup notifications.', '受け取り通知への同意にチェックを入れてください。'],
  'order.errEmpty': ['購物車是空的。', 'Your cart is empty.', 'カートが空です。'],
  'order.overTitle': ['訂單未送出', 'Order not sent', '注文は送信されませんでした'],
  'order.overMsg': ['單筆預點最多 {max} 件，你選了 {count} 件，系統已自動拒絕並通知攤位。請直接到攤位點餐。', 'Each pre-order is limited to {max} items, but you selected {count}. The order was declined automatically and the stall has been notified. Please order at the stall.', '1回の事前注文は{max}点までです（選択数：{count}点）。注文は自動的にお断りし、屋台にお知らせしました。屋台で直接ご注文ください。'],
  'order.unavailable': ['無法供應：{list}', 'Unavailable: {list}', 'ご用意できない商品：{list}'],
  'stock.soldout': ['{name}(已售完)', '{name} (sold out)', '{name}（売り切れ）'],
  'stock.short': ['{name}(剩 {n} 份)', '{name} ({n} left)', '{name}（残り{n}個）'],
  'stock.inactive': ['{name}(已下架)', '{name} (no longer available)', '{name}（販売終了）'],
  'stock.deleted': ['已刪除的品項', 'A removed item', '削除された商品'],

  // 訂單進度頁
  'track.title': ['九愛！買｜訂單進度', '九愛！買 | Order status', '九愛！買｜注文状況'],
  'track.heading': ['訂單進度', 'Order status', '注文状況'],
  'track.toEntry': ['回到入口', 'Back to start', 'トップに戻る'],
  'track.findTitle': ['找回訂單', 'Find your order', '注文を探す'],
  'track.orderNo': ['訂單編號', 'Order number', '注文番号'],
  'track.orderNoPh': ['例如：A012', 'e.g. A012', '例：A012'],
  'track.findPhone': ['下單時填寫的手機號碼', 'Mobile number used for the order', '注文時に入力した携帯電話番号'],
  'track.search': ['查詢', 'Search', '検索'],
  'track.deviceOrders': ['這台裝置的訂單', 'Orders on this device', 'この端末の注文'],
  'track.findErr': ['請輸入正確的訂單編號(例如 A012)與手機號碼。', 'Please enter a valid order number (e.g. A012) and mobile number.', '正しい注文番号（例：A012）と携帯電話番号を入力してください。'],
  'track.noMatch': ['找不到符合的訂單，請確認編號與電話。', 'No matching order found. Please check the order number and phone number.', '該当する注文が見つかりません。注文番号と電話番号をご確認ください。'],
  'track.notFound': ['找不到這筆訂單，請輸入編號與電話查詢。', 'Order not found. Please search with your order number and phone number.', 'この注文が見つかりません。注文番号と電話番号で検索してください。'],
  'step.sent': ['已送出', 'Sent', '送信済み'],
  'step.paid': ['已付款', 'Paid', '支払い済み'],
  'step.making': ['製作中', 'Preparing', '調理中'],
  'step.ready': ['可取餐', 'Ready', '受け取り可能'],
  'step.picked': ['已取餐', 'Picked up', '受け取り済み'],
  'status.pending': ['等待接單', 'Waiting for confirmation', '受付待ち'],
  'status.accepted': ['製作中', 'Preparing', '調理中'],
  'status.ready': ['可取餐', 'Ready for pickup', '受け取り可能'],
  'status.picked': ['已取餐', 'Picked up', '受け取り済み'],
  'status.rejected': ['已拒絕', 'Declined', 'お受けできませんでした'],
  'status.cancelled': ['已取消', 'Cancelled', 'キャンセル済み'],
  'status.expired': ['已失效', 'Expired', '無効'],
  'track.pushOn': ['已開啟取餐通知', 'Pickup notifications are on', '受け取り通知はオンです'],
  'track.pushTitle': ['取餐通知', 'Pickup notifications', '受け取り通知'],
  'track.pushDemo': ['展示模式不支援推播。', 'Notifications aren\'t available in demo mode.', 'デモモードでは通知を利用できません。'],
  'track.iosTitle': ['iPhone 開啟取餐通知', 'Turn on notifications on iPhone', 'iPhoneで通知を受け取るには'],
  'track.iosBody': ['iPhone 需要先把網頁加入主畫面才能收到通知：點 Safari 下方的分享按鈕，選「加入主畫面」，再從主畫面開啟「九愛！買」，回到這個頁面按「開啟取餐通知」。', 'To get notifications on iPhone, add this page to your Home Screen first: tap the Share button in Safari, choose "Add to Home Screen", open "九愛！買" from your Home Screen, then come back to this page and tap "Turn on notifications".', 'iPhoneで通知を受け取るには、先にこのページをホーム画面に追加してください。Safariの共有ボタンから「ホーム画面に追加」を選び、ホーム画面の「九愛！買」を開いてこのページに戻り、「通知をオンにする」を押してください。'],
  'track.notifyMe': ['餐點完成時通知我', 'Notify me when my order is ready', '料理ができたらお知らせします'],
  'track.enablePush': ['開啟取餐通知', 'Turn on notifications', '通知をオンにする'],
  'track.docReady': ['【可取餐】{no}｜九愛！買', '[Ready] {no} | 九愛！買', '【受け取り可能】{no}｜九愛！買'],
  'track.etaPending': ['等待攤位確認訂單', 'Waiting for the stall to confirm', '屋台の確認をお待ちください'],
  'track.eta': ['預計 {time} 完成', 'Ready around {time}', '{time}ごろ完成予定'],
  'track.etaSoon': ['即將完成，請留意通知', 'Almost ready. Please watch for the notification.', 'まもなく完成します。通知をお待ちください。'],
  'track.etaMaking': ['攤位製作中', 'Being prepared', '調理中です'],
  'track.etaReady': ['請到攤位出示訂單編號取餐', 'Show your order number at the stall to pick up.', '屋台で注文番号を提示してお受け取りください。'],
  'track.etaPicked': ['已於 {time} 取餐，謝謝光臨', 'Picked up at {time}. Thank you!', '{time}にお受け取り済みです。ありがとうございました！'],
  'track.rejTitle': ['攤位未接受這筆訂單', 'The stall couldn\'t accept this order', '屋台でこの注文をお受けできませんでした'],
  'track.rejReason': ['原因：{r}', 'Reason: {r}', '理由：{r}'],
  'track.rejHint': ['歡迎直接到攤位點餐。', 'You\'re welcome to order at the stall.', '屋台で直接ご注文いただけます。'],
  'track.cancelled': ['訂單已取消。', 'This order has been cancelled.', 'この注文はキャンセルされました。'],
  'track.voided': ['此訂單已由攤位作廢。如有疑問，請到攤位詢問。', 'This order was voided by the stall. Please ask at the stall if you have any questions.', 'この注文は屋台により無効になりました。ご不明な点は屋台でお尋ねください。'],
  'track.expired': ['此訂單已超過 12 小時，已自動失效。如有疑問，請到攤位詢問。', 'This order is more than 12 hours old and has expired. Please ask at the stall if you have any questions.', 'この注文は 12 時間以上経過したため無効になりました。ご不明な点は屋台でお尋ねください。'],
  'track.readyStrong': ['餐點已完成！', 'Your order is ready!', '料理ができました！'],
  'track.readyBody': ['請到攤位出示編號 {no} 取餐。', 'Show number {no} at the stall to pick it up.', '屋台で番号 {no} を提示してお受け取りください。'],
  'track.messagesTitle': ['攤位訊息', 'Messages from the stall', '屋台からのメッセージ'],
  'track.detailsTitle': ['訂單明細', 'Order details', '注文内容'],
  'track.sentAt': ['送出時間 {t}', 'Sent {t}', '送信日時 {t}'],
  'track.confirmedAt': ['確立時間 {t}', 'Confirmed {t}', '確定日時 {t}'],
  'track.cancelBtn': ['取消訂單', 'Cancel order', '注文をキャンセル'],
  'track.cancelConfirm': ['確定要取消這筆訂單嗎？', 'Are you sure you want to cancel this order?', 'この注文をキャンセルしてもよろしいですか？'],
  'track.cancelKeep': ['取消', 'Keep order', '戻る'],
  'track.cancelledToast': ['訂單已取消', 'Order cancelled', '注文をキャンセルしました'],
  'track.cancelFail': ['目前無法取消，請至攤位洽詢。', 'This order can no longer be cancelled. Please ask at the stall.', 'この注文はキャンセルできません。屋台にお問い合わせください。'],
  'track.again': ['再點一次', 'Order again', 'もう一度注文する'],
  'track.testSound': ['測試提示音', 'Test alert sound', '通知音をテスト'],
  'track.readyToast': ['餐點已完成，請到攤位取餐！', 'Your order is ready. Please pick it up at the stall!', '料理ができました。屋台でお受け取りください！'],
  'track.notiTitle': ['餐點已完成', 'Order ready', '料理ができました'],
  'track.notiBody': ['訂單 {no} 可以取餐了', 'Order {no} is ready for pickup', '注文 {no} をお受け取りいただけます'],
  'track.acceptedToast': ['攤位已接單，開始製作', 'The stall has accepted your order and started preparing it', '屋台が注文を受け付け、調理を始めました'],
  'track.messageToast': ['攤位訊息：{text}', 'Message from the stall: {text}', '屋台からのメッセージ：{text}'],
  'track.sentToast': ['訂單已送出，等待攤位接單', 'Order sent. Waiting for the stall to confirm.', '注文を送信しました。屋台の確認をお待ちください。'],

  // 菜單、輪播、詳細頁
  'common.backHome': ['回到首頁', 'Back to home', 'ホームに戻る'],
  'common.close': ['關閉', 'Close', '閉じる'],
  'menu.featured': ['推薦', 'Recommended', 'おすすめ'],
  'menu.other': ['其他', 'Other', 'その他'],
  'menu.categories': ['菜單分類', 'Menu categories', 'メニューのカテゴリー'],
  'carousel.label': ['宣傳輪播', 'Promotions', 'お知らせ'],
  'carousel.prev': ['上一張', 'Previous', '前へ'],
  'carousel.next': ['下一張', 'Next', '次へ'],
  // 缺貨處理(確認訂單第二頁、訂單進度頁、通知)
  'order.continue': ['繼續', 'Continue', '次へ'],
  'order.limitMax': ['單筆預點最多 {n} 件，請減少數量或直接到攤位點餐。', 'Each pre-order is limited to {n} items. Please reduce the quantity or order at the stall.', '1回の事前注文は{n}点までです。数量を減らすか、屋台で直接ご注文ください。'],
  'sub.title': ['如果特定商品已售完', 'If an item is sold out', '商品が売り切れの場合'],
  'sub.choose': ['立即選擇替代商品', 'Let me choose a replacement', '代わりの商品を自分で選ぶ'],
  'sub.chooseHint': ['從替代清單中選擇', 'Choose from a list of replacements', '代替リストから選びます'],
  'sub.similar': ['更換為任何類似商品', 'Replace with something similar', '似た商品に変更する'],
  'sub.similarHint': ['攤位會挑選其他口味或其他品項', 'The stall will pick another flavor or item', '屋台が別の味や商品を選びます'],
  'sub.remove': ['刪除該品項', 'Remove the item', 'その商品を削除する'],
  'sub.required': ['請選擇一項', 'Please choose one', '1つ選んでください'],
  'short.removed': ['{item} ×{qty} 已售完，已從訂單中刪除。', '{item} ×{qty} is sold out and has been removed from your order.', '{item} ×{qty} は売り切れのため、注文から削除しました。'],
  'short.replaced': ['{item} ×{qty} 已售完，已更換為 {to}。', '{item} ×{qty} is sold out and has been replaced with {to}.', '{item} ×{qty} は売り切れのため、{to} に変更しました。'],
  'short.askTitle': ['部分品項已售完', 'Some items are sold out', '売り切れの商品があります'],
  'short.askBody': ['請在時間內選擇替代品項，逾時將由攤位處理。', 'Please choose a replacement in time. Otherwise the stall will handle it.', '時間内に代わりの商品を選んでください。時間を過ぎると屋台が対応します。'],
  'short.askPush': ['訂單 {no} 有品項售完，請開啟訂單選擇替代品項。', 'An item in order {no} is sold out. Open your order to choose a replacement.', '注文 {no} に売り切れの商品があります。注文を開いて代わりの商品を選んでください。'],
  'short.left': ['剩 {s} 秒', '{s}s left', '残り{s}秒'],
  'short.submit': ['確認選擇', 'Confirm', '決定'],
  'short.sent': ['已送出，等待攤位處理', 'Sent. Waiting for the stall.', '送信しました。屋台の対応をお待ちください。'],
  'short.totalChanged': ['金額已變更', 'Total updated', '金額が変更されました'],
  'track.stallCancelled': ['攤位已取消此訂單', 'The stall cancelled this order', '屋台がこの注文を取り消しました'],
  'track.stallCancelledReason': ['原因：{r}', 'Reason: {r}', '理由：{r}'],
  'track.stallCancelledPush': ['訂單 {no} 已被攤位取消。{r}', 'Order {no} was cancelled by the stall. {r}', '注文 {no} は屋台により取り消されました。{r}'],
  'detail.addToOrder': ['加入訂單', 'Add to order', '注文に追加'],
  'detail.required': ['必填', 'Required', '必須'],
  'detail.photo': ['照片 {i} / {n}', 'Photo {i} of {n}', '写真 {i} / {n}'],

  // 取餐提醒、通知、引導
  'track.ack': ['我知道了', 'Got it', 'わかりました'],
  'track.readyBar': ['餐點完成了！請到攤位出示 {no} 取餐', 'Your order is ready! Show {no} at the stall.', '料理ができました！屋台で {no} を提示してください'],
  'track.batteryTip': ['若收不到通知，請到手機設定把 Chrome 的電池最佳化關閉。', 'If notifications don\'t arrive, turn off battery optimization for Chrome in your phone settings.', '通知が届かない場合は、端末の設定で Chrome のバッテリー最適化をオフにしてください。'],
  'track.pushDeniedBody': ['通知已被封鎖。請點網址列旁的設定圖示(或到瀏覽器設定 > 網站設定 > 通知)，把這個網站改為「允許」，再重新整理頁面。', 'Notifications are blocked. Tap the settings icon next to the address bar (or go to browser settings > Site settings > Notifications), set this site to "Allow", then reload the page.', '通知がブロックされています。アドレスバー横の設定アイコン（またはブラウザの設定 > サイトの設定 > 通知）から、このサイトを「許可」にして、ページを再読み込みしてください。'],
  'track.lineTip': ['請點右上角，改用 Chrome／Safari 開啟，才能收到取餐通知', 'To receive pickup notifications, tap the menu at the top right and open this page in Chrome or Safari.', '受け取り通知を受信するには、右上のメニューから Chrome または Safari で開き直してください。'],
  'push.promptTitle': ['開啟取餐通知', 'Turn on pickup notifications', '受け取り通知をオンにする'],
  'push.promptBody': ['餐點完成時，我們會傳通知給你。按下按鈕後，請在跳出的視窗選「允許」。', 'We\'ll notify you when your order is ready. After tapping the button, choose "Allow" in the pop-up.', '料理ができたらお知らせします。ボタンを押したあと、表示される画面で「許可」を選んでください。'],
  'push.later': ['稍後再說', 'Maybe later', 'あとで'],
  'guide.button': ['引導我去攤位', 'Guide me to the stall', '屋台への行き方'],
  'guide.soon': ['攤位位置即將公布', 'The stall location will be announced soon.', '屋台の場所はまもなく公開します。'],
  'home.lineTip': ['請用手機相機或 QR code 掃描工具重新掃描。LINE 內無法接收取餐通知。', 'Please scan again with your camera or a QR code app. LINE\'s browser can\'t receive pickup notifications.', 'カメラまたはQRコードアプリで読み取り直してください。LINEのブラウザでは受け取り通知を受信できません。'],

  // 錯誤訊息(顧客可能看到的)
  'err.closed': ['攤位目前暫停接受預點，請直接到攤位點餐。', 'Pre-orders are paused. Please order at the stall.', 'ただいま事前注文を停止しています。屋台で直接ご注文ください。'],
  'err.over-limit': ['單筆預點數量超過上限，請直接到攤位點餐。', 'This order exceeds the item limit. Please order at the stall.', '注文数が上限を超えています。屋台で直接ご注文ください。'],
  'err.phone-active': ['這支電話已有進行中的訂單，取餐完成後才能再預點。', 'This phone number already has an active order. You can order again after picking it up.', 'この電話番号には受け取り前の注文があります。受け取り後に再度ご注文いただけます。'],
  'err.session-invalid': ['點餐連結已失效，請重新掃描攤位的 QR code。', 'This ordering link has expired. Please scan the QR code at the stall again.', 'この注文リンクは無効になりました。屋台のQRコードをもう一度読み取ってください。'],
  'err.active-order': ['你有一筆進行中的訂單，完成後才能再預點。', 'You have an active order. You can order again once it\'s complete.', '進行中の注文があります。完了後に再度ご注文いただけます。'],
  'err.sold-out': ['部分品項已售完或數量不足。', 'Some items are sold out or not enough are left.', '一部の商品が売り切れ、または数量が不足しています。'],
  'err.not-found': ['找不到這筆訂單。', 'Order not found.', '注文が見つかりません。'],
  'err.bad-state': ['訂單狀態已經變更，請重新整理。', 'The order status has changed. Please refresh the page.', '注文の状況が変わりました。ページを再読み込みしてください。'],
  'err.permission': ['沒有權限執行此操作。', 'This action isn\'t allowed.', 'この操作は許可されていません。'],
  'err.network': ['網路連線異常，請稍後再試。', 'Network error. Please try again later.', '通信エラーが発生しました。しばらくしてからもう一度お試しください。'],
  'err.push-unsupported': ['這個瀏覽器不支援推播通知。', 'This browser doesn\'t support notifications.', 'このブラウザは通知に対応していません。'],
  'err.push-denied': ['通知權限被拒絕，請到瀏覽器設定開啟。', 'Notification permission was denied. Please allow it in your browser settings.', '通知が許可されていません。ブラウザの設定で許可してください。'],
  'err.claimed': ['這張訂單已經綁定到其他裝置。', 'This order is already linked to another device.', 'この注文はすでに別の端末に登録されています。'],
  'err.invalid': ['資料格式不正確。', 'Invalid information. Please check and try again.', '入力内容が正しくありません。'],
  'err.unknown': ['發生未預期的錯誤，請稍後再試。', 'Something went wrong. Please try again later.', '予期しないエラーが発生しました。しばらくしてからもう一度お試しください。'],
};

const INDEX = { 'zh-Hant': 0, en: 1, ja: 2 };

export function t(key, vars = {}, lang = getLang()) {
  const row = DICT[key];
  if (!row) return key;
  const text = row[INDEX[lang]] ?? row[0];
  return text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

export function hasKey(key) {
  return key in DICT;
}

// 件數：英文單複數不同
export function itemCount(n, lang = getLang()) {
  if (lang === 'en') return n === 1 ? '1 item' : `${n} items`;
  if (lang === 'ja') return `${n}点`;
  return `${n} 件`;
}

// 價格：品項維持 NT$；確認訂單頁的總金額在英日文前面改為 NTD
export function totalMoney(n, lang = getLang()) {
  const num = Number(n || 0).toLocaleString('zh-TW');
  return lang === 'zh-Hant' ? `NT$ ${num}` : `NTD ${num}`;
}

// 顧客姓名在各語言的稱呼方式(資料庫仍存中文稱謂，攤位看到的是「王先生」)
export function personNameFor(surname, title, lang = getLang()) {
  if (!surname) return '';
  if (lang === 'en') {
    if (title === '先生') return `Mr. ${surname}`;
    if (title === '小姐') return `Ms. ${surname}`;
    return surname;
  }
  if (lang === 'ja') return `${surname}様`;
  return `${surname}${title || ''}`;
}

// 品項的翻譯：item.i18n = { en: { name, description, options }, ja: {...} }，沒有翻譯時顯示中文
export function itemText(item, lang = getLang()) {
  const tr = lang === 'zh-Hant' ? null : item?.i18n?.[lang];
  return {
    name: tr?.name || item?.name || '',
    description: tr?.description || item?.description || '',
  };
}

// 分類名稱的翻譯
export function categoryText(cat, lang = getLang()) {
  if (lang === 'zh-Hant') return cat?.name || '';
  return cat?.i18n?.[lang]?.name || cat?.name || '';
}

// 標籤的翻譯：依位置對應，沒有翻譯時顯示中文
export function tagsText(item, lang = getLang()) {
  const tags = item?.tags || [];
  if (lang === 'zh-Hant') return tags;
  const tr = item?.i18n?.[lang]?.tags || [];
  return tags.map((tag, i) => tr[i] || tag);
}

// 口味選項的翻譯：訂單內存中文選項，依位置對應翻譯
export function optionText(item, option, lang = getLang()) {
  if (!option || lang === 'zh-Hant') return option || '';
  const idx = (item?.options || []).indexOf(option);
  return (idx >= 0 && item?.i18n?.[lang]?.options?.[idx]) || option;
}

// 品項名稱加口味：中文「甜甜圈(巧克力)」、英文「Donut (Chocolate)」、日文「ドーナツ（チョコレート）」
export function withOption(name, option, lang = getLang()) {
  if (!option) return name;
  if (lang === 'en') return `${name} (${option})`;
  if (lang === 'ja') return `${name}（${option}）`;
  return `${name}(${option})`;
}

// 設定中顧客看得到的文字：settings.i18n = { en: { bannerText, consentText }, ja: {...} }
export function settingText(settings, field, lang = getLang()) {
  if (lang === 'zh-Hant') return settings?.[field] || '';
  return settings?.i18n?.[lang]?.[field] || settings?.[field] || '';
}

// 套用靜態文字：data-i18n(文字)、data-i18n-placeholder、data-i18n-aria、data-i18n-alt
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  root.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = t(titleKey);
}

// 日文使用 Noto Sans JP，只在選擇日文時才載入字型
function ensureJapaneseFont() {
  if (document.getElementById('font-ja')) return;
  const link = document.createElement('link');
  link.id = 'font-ja';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;600&display=swap';
  document.head.append(link);
}

const listeners = new Set();
export function onLangChange(fn) {
  listeners.add(fn);
}

export function applyLang() {
  const lang = getLang();
  if (IS_CUSTOMER_PAGE) document.documentElement.lang = lang === 'zh-Hant' ? 'zh-Hant-TW' : lang;
  if (lang === 'ja') ensureJapaneseFont();
  if (IS_CUSTOMER_PAGE) applyStatic();
  listeners.forEach((fn) => fn(lang));
}

// 顧客頁面載入時立即套用
if (IS_CUSTOMER_PAGE) applyLang();
