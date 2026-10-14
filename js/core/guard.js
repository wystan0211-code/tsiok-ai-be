// 員工頁面權限檢查：未登入或權限不足時導向登入頁
import { api } from '../api/index.js';

export const ROLE_LEVEL = { staff: 1, manager: 2, admin: 3 };

export function hasRole(profile, minRole) {
  return !!profile && (ROLE_LEVEL[profile.role] || 0) >= ROLE_LEVEL[minRole];
}

// 預購主管權限：預購主管與管理員(只看預購單、標示付款)
export function canPresale(profile) {
  return !!profile && (profile.role === 'presale' || profile.role === 'admin');
}

// 只有預購主管權限、沒有攤位權限(攤位頁只顯示預購單)
export const presaleOnly = (profile) => profile?.role === 'presale';

// 等待登入狀態，符合權限時呼叫 onReady(profile)；登出時自動導回登入頁
// allowPresale：預購主管也可以進入(攤位頁)
export function requireStaff(minRole, onReady, { allowPresale = false } = {}) {
  let started = false;
  api.onStaffAuth((profile) => {
    if (!hasRole(profile, minRole) && !(allowPresale && canPresale(profile))) {
      const next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
      location.replace(`login.html?next=${next}${profile ? '&denied=1' : ''}`);
      return;
    }
    if (!started) {
      started = true;
      onReady(profile);
    }
  });
}
