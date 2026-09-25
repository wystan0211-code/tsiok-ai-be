// 員工登入：帳號名稱 + 密碼，依權限導向營運頁或原本要去的頁面
import { api, IS_DEMO } from '../api/index.js';
import { $, showDemoBanner, withBusy } from '../core/ui.js';
import { errorText } from '../core/errors.js';

showDemoBanner(IS_DEMO);
$('#demo-accounts').hidden = !IS_DEMO;

const params = new URLSearchParams(location.search);
const rawNext = params.get('next') || '';
// 只允許站內頁面，避免被導到外部網站
const next = /^[a-z]+\.html(\?.*)?$/.test(rawNext) ? rawNext : '';

if (params.get('denied') === '1') {
  const err = $('#login-error');
  err.textContent = '目前登入的帳號沒有這個頁面的權限，請改用其他帳號登入。';
  err.hidden = false;
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  withBusy(form.querySelector('button[type=submit]'), async () => {
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api.staffLogout();
      await api.staffLogin(form.username.value, form.password.value);
      location.replace(next || 'stall.html');
    } catch (e2) {
      err.textContent = errorText(e2);
      err.hidden = false;
    }
  });
});
