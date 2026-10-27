// localStorage 安全包裝：無痕模式或容量不足時不讓頁面壞掉
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('無法寫入本機儲存', err);
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 忽略
    }
  },
};
