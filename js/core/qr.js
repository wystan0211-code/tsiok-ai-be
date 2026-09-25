// QR code 產生(使用 MIT 授權的 qrcode-generator，已放在 js/vendor)
import qrcode from '../vendor/qrcode.mjs';

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: text });
}
