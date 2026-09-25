// 員工頁面權限檢查：未登入或權限不足時導向登入頁
import { api } from '../api/index.js';

export const ROLE_LEVEL = { staff: 1, manager: 2, admin: 3 };

export function hasRole(profile, minRole) {
  return !!profile && (ROLE_LEVEL[profile.role] || 0) >= ROLE_LEVEL[minRole];
}

// 等待登入狀態，符合權限時呼叫 onReady(profile)；登出時自動導回登入頁
export function requireStaff(minRole, onReady) {
  let started = false;
  api.onStaffAuth((profile) => {
    if (!hasRole(profile, minRole)) {
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
