// 圖片裁切工具(後台使用)：拖曳移動、滑桿或雙指縮放，選擇要顯示的區域
// mode 'fit'：預設完整顯示整張圖，空白處補黑邊，可放大裁掉不要的部分(品項照片 1:1)
// mode 'cover'：一定填滿框，不會有黑邊(橫幅 9:5)
import { openDialog, icon } from './ui.js';
import { escapeHtml } from './format.js';

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取圖片，請換一張圖片。'));
    };
    img.src = url;
  });
}

// 輸出 JPEG，超過大小上限時逐步降低品質
function exportJpeg(canvas, maxChars) {
  let q = 0.85;
  let url = canvas.toDataURL('image/jpeg', q);
  while (url.length > maxChars && q > 0.45) {
    q -= 0.08;
    url = canvas.toDataURL('image/jpeg', q);
  }
  return url;
}

/**
 * 開啟裁切視窗
 * @param {File} file
 * @param {{ aspect: number, mode: 'fit'|'cover', title?: string,
 *           outputs: Array<{ width: number, maxChars: number }> }} opts
 * @returns {Promise<string[]|null>} 依 outputs 順序回傳 dataURL；取消時回傳 null
 */
export async function cropImage(file, { aspect, mode = 'fit', title = '調整顯示範圍', outputs }) {
  const { img, url } = await loadImage(file);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  let W = 0;
  let H = 0;
  let scale = 1;
  let minScale = 1;
  let maxScale = 1;
  let x = 0;
  let y = 0;

  const hint = mode === 'fit'
    ? '拖曳移動、用滑桿或雙指縮放。預設完整顯示整張圖，空白處會補黑邊。'
    : '拖曳移動、用滑桿或雙指縮放，選擇要顯示的區域。';

  const result = await openDialog({
    title,
    size: 'wide',
    body: `
      <p class="muted text-sm">${escapeHtml(hint)}</p>
      <div class="crop" style="aspect-ratio:${aspect}">
        <img class="crop__img" src="${url}" alt="" draggable="false">
        <div class="crop__frame" aria-hidden="true"></div>
      </div>
      <label class="crop__zoom">
        ${icon('zoom_out', 'icon--sm')}
        <input type="range" min="0" max="1000" value="0" aria-label="縮放">
        ${icon('zoom_in', 'icon--sm')}
      </label>`,
    actions: [{ label: '使用這個範圍', value: 'ok' }],
    onOpen(dlg) {
      const stage = dlg.querySelector('.crop');
      const el = dlg.querySelector('.crop__img');
      const range = dlg.querySelector('input[type=range]');

      const clamp = () => {
        const w = iw * scale;
        const h = ih * scale;
        x = w >= W ? Math.min(0, Math.max(W - w, x)) : Math.max(0, Math.min(W - w, x));
        y = h >= H ? Math.min(0, Math.max(H - h, y)) : Math.max(0, Math.min(H - h, y));
      };
      const draw = () => {
        clamp();
        el.style.width = `${iw * scale}px`;
        el.style.height = `${ih * scale}px`;
        el.style.transform = `translate(${x}px, ${y}px)`;
        range.value = String(Math.round(((scale - minScale) / (maxScale - minScale || 1)) * 1000));
      };
      // 以框內某點為中心縮放
      const zoomTo = (next, cx = W / 2, cy = H / 2) => {
        const s = Math.max(minScale, Math.min(maxScale, next));
        x = cx - ((cx - x) * s) / scale;
        y = cy - ((cy - y) * s) / scale;
        scale = s;
        draw();
      };

      // 框的高度一律由寬度與比例計算，不使用量到的高度(手機上視窗較矮時，量到的高度可能被壓縮)
      const setup = () => {
        W = stage.clientWidth;
        H = W / aspect;
        const contain = Math.min(W / iw, H / ih);
        const cover = Math.max(W / iw, H / ih);
        minScale = mode === 'fit' ? contain : cover;
        maxScale = cover * 4;
        scale = minScale;
        x = (W - iw * scale) / 2;
        y = (H - ih * scale) / 2;
        draw();
      };
      requestAnimationFrame(setup);
      // 視窗寬度改變(例如出現捲軸、轉向)時，等比例調整目前的位置與縮放，維持同一個裁切範圍
      const ro = new ResizeObserver(() => {
        const w = stage.clientWidth;
        if (!W || !w || Math.abs(w - W) < 0.5) return;
        const k = w / W;
        x *= k;
        y *= k;
        scale *= k;
        minScale *= k;
        maxScale *= k;
        W = w;
        H = W / aspect;
        draw();
      });
      ro.observe(stage);
      dlg.addEventListener('close', () => ro.disconnect(), { once: true });

      range.addEventListener('input', () => {
        zoomTo(minScale + (Number(range.value) / 1000) * (maxScale - minScale));
      });

      // 拖曳與雙指縮放
      const pointers = new Map();
      let pinch = null;
      stage.addEventListener('pointerdown', (e) => {
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
        }
      });
      stage.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        pointers.set(e.pointerId, cur);
        if (pointers.size === 2 && pinch) {
          const [a, b] = [...pointers.values()];
          const r = stage.getBoundingClientRect();
          const cx = (a.x + b.x) / 2 - r.left;
          const cy = (a.y + b.y) / 2 - r.top;
          zoomTo(pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist), cx, cy);
        } else if (pointers.size === 1) {
          x += cur.x - prev.x;
          y += cur.y - prev.y;
          draw();
        }
      });
      const end = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
      };
      stage.addEventListener('pointerup', end);
      stage.addEventListener('pointercancel', end);
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomTo(scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
    },
  });

  if (result.value !== 'ok') {
    URL.revokeObjectURL(url);
    return null;
  }
  // 依目前的框選範圍輸出各尺寸
  const out = outputs.map(({ width, maxChars }) => {
    const height = Math.round(width / aspect);
    const k = width / W;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000000';
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, x * k, y * k, iw * scale * k, ih * scale * k);
    return exportJpeg(canvas, maxChars);
  });
  URL.revokeObjectURL(url);
  return out;
}

// 品項照片：1:1，小圖 360px(菜單)、大圖 1080px(詳細頁)
export function cropItemImage(file) {
  return cropImage(file, {
    aspect: 1,
    mode: 'fit',
    title: '調整照片顯示範圍',
    outputs: [{ width: 360, maxChars: 45000 }, { width: 1080, maxChars: 240000 }],
  });
}

// 橫幅：9:5，1080×600
export function cropBannerImage(file) {
  return cropImage(file, {
    aspect: 9 / 5,
    mode: 'cover',
    title: '調整橫幅顯示範圍',
    outputs: [{ width: 1080, maxChars: 240000 }],
  });
}
