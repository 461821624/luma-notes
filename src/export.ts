import { toPng } from 'html-to-image';
import { request } from './api';

export async function exportDocument(type: 'html' | 'png' | 'pdf', html: string, name: string) {
  if (type === 'html') { await request('export_file', { name: `${name}.html`, content: html }); return; }
  if (type === 'pdf') { await request('export_pdf', { name: `${name}.pdf`, html }); return; }
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1000px;height:1000px;border:0';
  document.body.append(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('图片导出加载超时')), 15000);
      frame.onload = () => { clearTimeout(timer); resolve(); }; frame.srcdoc = html;
    });
    const doc = frame.contentDocument!;
    await doc.fonts.ready;
    const body = doc.body;
    const height = Math.max(body.scrollHeight, doc.documentElement.scrollHeight);
    if (height > 60000) throw new Error('文档过长，请分段导出图片或使用 PDF');
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建图片画布');
    for (let y = 0; y < height; y += 4000) {
      const partHeight = Math.min(4000, height - y);
      const url = await toPng(body, { width: 1000, height: partHeight, pixelRatio: 1,
        style: { transform: `translateY(-${y}px)`, transformOrigin: 'top left' }, skipFonts: true, backgroundColor: '#ffffff' });
      const image = new Image(); image.src = url; await image.decode(); context.drawImage(image, 0, y);
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片编码失败')), 'image/png'));
    await request('export_file', { name: `${name}.png`, bytes: [...new Uint8Array(await blob.arrayBuffer())] });
  } finally { frame.remove(); }
}
