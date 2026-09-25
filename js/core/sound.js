// 提示音與震動：瀏覽器規定要先有使用者互動才能播放聲音，所以第一次點擊時解鎖
let ctx = null;

export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

document.addEventListener('pointerdown', unlockAudio, { once: true });

export function isAudioReady() {
  return !!ctx && ctx.state === 'running';
}

// 短促提示音，times 次
export function beep(times = 2, frequency = 880) {
  if (!ctx) return;
  const start = ctx.currentTime;
  for (let i = 0; i < times; i += 1) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    const t = start + i * 0.28;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }
}

// iPhone 的 Safari 不支援震動，會自動略過
export function vibrate(pattern = [200, 100, 200]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 忽略
  }
}
