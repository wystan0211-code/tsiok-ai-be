// 提示音與震動：瀏覽器規定要先有使用者互動才能播放聲音，所以第一次點擊時解鎖
// 聲音經過壓縮器，音量接近最大也不會破音；使用較能穿透人聲的高頻音(約 1.6–2.4 kHz)
// 注意：網頁聲音跟隨手機的「媒體音量」，iPhone 靜音模式時可能沒有聲音，這是系統限制
let ctx = null;
let out = null;

export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    if (!out) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 6;
      const master = ctx.createGain();
      master.gain.value = 1;
      comp.connect(master).connect(ctx.destination);
      out = comp;
    }
  } catch {
    ctx = null;
  }
}

document.addEventListener('pointerdown', unlockAudio, { once: true });

export function isAudioReady() {
  return !!ctx && ctx.state === 'running';
}

// 單一音：方波較響亮，混一點正弦波讓聲音不那麼刺耳
function tone(at, frequency, duration, volume = 0.6) {
  for (const [type, level] of [['square', 0.35], ['sine', 0.65]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume * level, at + 0.015);
    gain.gain.setValueAtTime(volume * level, at + duration - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }
}

// 提示音，times 次
export function beep(times = 2, frequency = 1600) {
  if (!ctx || !out) return;
  const start = ctx.currentTime + 0.02;
  for (let i = 0; i < times; i += 1) tone(start + i * 0.42, frequency, 0.3);
}

// ===== 取餐鬧鈴：重複響到呼叫 stopAlarm()，最長 maxMs =====
let alarmTimer = null;
let alarmEnd = 0;

function alarmCycle() {
  if (Date.now() > alarmEnd) {
    stopAlarm();
    return;
  }
  if (ctx && out) {
    const t = ctx.currentTime + 0.02;
    // 高低交替的三連音
    tone(t, 1800, 0.22, 0.8);
    tone(t + 0.3, 2400, 0.22, 0.8);
    tone(t + 0.6, 1800, 0.22, 0.8);
  }
  vibrate([250, 100, 250, 100, 250]);
}

export function startAlarm(maxMs = 60000) {
  stopAlarm();
  alarmEnd = Date.now() + maxMs;
  alarmCycle();
  alarmTimer = setInterval(alarmCycle, 1600);
}

export function stopAlarm() {
  clearInterval(alarmTimer);
  alarmTimer = null;
  try {
    navigator.vibrate?.(0);
  } catch {
    // 忽略
  }
}

export function isAlarmOn() {
  return alarmTimer !== null;
}

// iPhone 不支援網頁震動，會自動略過
export function vibrate(pattern = [200, 100, 200]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 忽略
  }
}

// ===== 攤位端：較圓潤、較長的「叮咚」提示音(正弦波加泛音，柔和地淡出，類似木琴或門鈴) =====
function softNote(at, frequency, duration, volume = 0.7) {
  // 基音 + 2 倍、3 倍泛音，越高的泛音越小聲、越快消失，聽起來圓潤不刺耳
  for (const [mult, level, decay] of [[1, 1, 1], [2, 0.28, 0.6], [3, 0.08, 0.35]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency * mult;
    const end = at + duration * decay;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume * level, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(end + 0.05);
  }
}

// 一組「叮—咚—叮」，約 1.6 秒
export function chime() {
  if (!ctx || !out) return;
  const t = ctx.currentTime + 0.02;
  softNote(t, 784, 1.1); // G5
  softNote(t + 0.38, 659, 1.1); // E5
  softNote(t + 0.76, 784, 1.0); // G5
}

// 持續響到呼叫 stopChimeLoop()(例如還有等待接單的訂單時)
let chimeTimer = null;
export function startChimeLoop(intervalMs = 3500) {
  if (chimeTimer) return;
  chime();
  vibrate([300, 150, 300]);
  chimeTimer = setInterval(() => {
    chime();
    vibrate([300, 150, 300]);
  }, intervalMs);
}

export function stopChimeLoop() {
  clearInterval(chimeTimer);
  chimeTimer = null;
}

export function isChimeLooping() {
  return chimeTimer !== null;
}
