import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown, splitSlides } from './markdown';
import { request, type Settings } from './api';

type Props = { content: string; path: string; settings: Settings; dark: boolean; ppt: boolean;
  onTask: (index: number) => void; onWiki: (name: string) => void; onScroll: (ratio: number) => void;
  onError: (error: string) => void };
export type PreviewHandle = { scroll: (ratio: number) => void; heading: (line: number) => void; find: (query: string) => void; snapshot: () => Promise<string> };
const previewOrigin = () => new URL('/preview/', location.href).href;
const stylesheetCache = new Map<string, Promise<string>>();
async function embedStyles(html: string, base: string) {
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)];
  const styles = await Promise.all(links.map(async ([tag, href]) => {
    const url = new URL(href, base).href;
    if (!stylesheetCache.has(url)) stylesheetCache.set(url, fetch(url).then(response => { if (!response.ok) throw new Error(`样式加载失败：${href}`); return response.text(); }));
    return [tag, `<style>${await stylesheetCache.get(url)}</style>`];
  }));
  for (const [tag, style] of styles) html = html.replace(tag, () => style);
  return html;
}

function sanitize(html: string) {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['video', 'audio', 'source'], ADD_ATTR: ['controls', 'data-source-line', 'data-line-numbers', 'data-fragment-index'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input-form', 'object', 'embed', 'base', 'link', 'meta'],
    FORBID_ATTR: ['style', 'srcdoc', 'formaction'],
  });
}
async function resolveMedia(html: string, path: string): Promise<string> {
  const doc = new DOMParser().parseFromString(sanitize(html), 'text/html');
  await Promise.all([...doc.querySelectorAll<HTMLImageElement>('img,video,audio,source')].map(async el => {
    const src = el.getAttribute('src');
    if (!src || /^(https?:|data:)/i.test(src)) return;
    try { el.setAttribute('src', await request<string>('read_attachment', { path, src })); }
    catch { el.removeAttribute('src'); el.setAttribute('title', `无法读取附件：${src}`); }
  }));
  return doc.body.innerHTML;
}
export const Preview = forwardRef<PreviewHandle, Props>(function Preview(props, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useRef('');
  const callbacks = useRef(props); callbacks.current = props;
  const [document, setDocument] = useState('');
  const [busy, setBusy] = useState(true);
  const rendered = useRef({ path: '', content: '' });
  const pending = useRef<{ resolve: (html: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const post = (type: string, payload: unknown) => frame.current?.contentWindow?.postMessage({ token: token.current, type, payload }, '*');
  useImperativeHandle(ref, () => ({
    scroll: ratio => post('scroll', ratio), heading: line => post('heading', line), find: query => post('find', query),
    snapshot: () => new Promise((resolve, reject) => {
      if (busy || rendered.current.path !== callbacks.current.path || rendered.current.content !== callbacks.current.content) { reject(new Error('预览仍在渲染，请稍后导出')); return; }
      if (pending.current) { reject(new Error('导出正在进行')); return; }
      pending.current = { resolve, reject, timer: setTimeout(() => {
        pending.current = null; reject(new Error('导出预览超时'));
      }, 20000) };
      post('snapshot', null);
    }),
  }), [busy]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.token !== token.current) return;
      if (rendered.current.path !== callbacks.current.path || rendered.current.content !== callbacks.current.content) return;
      const { type, payload } = event.data;
      if (type === 'ready') setBusy(false);
      if (type === 'task' && Number.isInteger(payload) && payload >= 0) callbacks.current.onTask(payload);
      if (type === 'wiki' && typeof payload === 'string') callbacks.current.onWiki(payload);
      if (type === 'scroll' && typeof payload === 'number' && payload >= 0 && payload <= 1) callbacks.current.onScroll(payload);
      if (type === 'link' && typeof payload === 'string' && /^https?:\/\//i.test(payload))
        request('open_url', { url: payload }).catch(e => callbacks.current.onError(String(e)));
      if (type === 'attachment' && typeof payload === 'string')
        request('open_attachment', { path: callbacks.current.path, src: payload }).catch(e => callbacks.current.onError(String(e)));
      if (type === 'snapshot' && typeof payload === 'string' && pending.current) {
        clearTimeout(pending.current.timer); pending.current.resolve(payload); pending.current = null;
      }
    };
    window.addEventListener('message', listener);
    return () => { window.removeEventListener('message', listener); if (pending.current) { clearTimeout(pending.current.timer); pending.current.reject(new Error('预览已关闭')); pending.current = null; } };
  }, []);
  useEffect(() => {
    let cancelled = false;
    token.current = '';
    setBusy(true);
    const timer = setTimeout(async () => {
      const id = crypto.randomUUID();
      setBusy(true);
      try {
        const renderedHTML = props.ppt
          ? splitSlides(props.content).map(slide => `<section>${renderMarkdown(slide)}</section>`).join('')
          : renderMarkdown(props.content);
        const html = await resolveMedia(renderedHTML, props.path);
        if (cancelled) return;
        token.current = id;
        rendered.current = { path: props.path, content: props.content };
        const config = JSON.stringify({ token: id, dark: props.dark, ppt: props.ppt,
          plantuml: props.settings.plantumlEnabled ? props.settings.plantumlEndpoint : '',
        }).replace(/</g, '\\u003c');
        const base = previewOrigin();
        const font = props.settings.previewFont.replace(/[<>"';{}]/g, '');
        const markup = `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${new URL(base).origin} asset: http://asset.localhost; style-src 'unsafe-inline' ${new URL(base).origin}; img-src data: blob: https: http:; font-src data: ${new URL(base).origin}; media-src data: https: http:; connect-src 'none'">
<link rel="stylesheet" href="css/typography.css"><link rel="stylesheet" href="css/katex.min.css">
<link rel="stylesheet" href="css/theme-${props.dark ? 'dark' : 'light'}.css">
${props.ppt ? '<link rel="stylesheet" href="ppt/dist/reveal.css"><link rel="stylesheet" href="ppt/dist/theme/white.css">' : ''}
<style>:root{--text-color:${props.dark ? '#e7e9ea' : '#30343b'};--link-color:#956c4b;--bg-color:${props.dark ? '#202328' : '#ffffff'};--code-bg:${props.dark ? '#292d33' : '#f5f5f5'}}
html{background:var(--bg-color);color:var(--text-color);scroll-behavior:auto}body{margin:0;font-family:'${font}',sans-serif;font-size:${props.settings.fontSize}px;line-height:${props.settings.lineHeight}}#write{max-width:${props.settings.previewWidth || 1200}px;margin:auto;padding:32px 32px 70px}img,svg,video,iframe,table{max-width:100%;height:auto}pre{overflow:auto;background:var(--code-bg);padding:16px;border-radius:6px}code{font-family:Consolas,monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:8px;border:1px solid #8885}blockquote{border-left:3px solid #bba98d;margin-left:0;padding-left:20px;color:#888}a{color:var(--link-color)}.diagram-error{font-size:13px;color:#b75440;white-space:pre-wrap}.task-list-item{list-style:none}input{accent-color:#a58259}.reveal{height:100vh;color:var(--text-color)}.reveal .slides{text-align:left}.reveal section{font-size:26px}.zoomed{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:var(--bg-color);z-index:99;cursor:zoom-out}@media print{#write{padding:0}.reveal{height:auto}.reveal .slides{position:static;transform:none!important;width:auto!important}.reveal .slides section{display:block!important;position:static;page-break-after:always;opacity:1!important}pre,table,svg{break-inside:avoid}}</style>
</head><body>${props.ppt ? `<div class="reveal"><div class="slides">${html}</div></div>` : `<article id="write" class="heti">${html}</article>`}
<script>window.previewConfig=${config}</script>
<script src="js/highlight.min.js"></script><script src="js/katex.min.js"></script><script src="js/auto-render.min.js"></script>
<script src="js/mermaid.min.js"></script><script src="js/d3.min.js"></script><script src="js/markmap.min.js"></script><script src="js/markmap-view.min.js"></script><script src="js/plantuml-encoder.min.js"></script>
${props.ppt ? '<script src="ppt/dist/reveal.js"></script>' : ''}<script src="bridge.js"></script></body></html>`;
        const embedded = await embedStyles(markup, base);
        if (!cancelled) setDocument(embedded);
      } catch (error) { if (!cancelled) { setBusy(false); props.onError(String(error)); } }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [props.content, props.path, props.dark, props.ppt, props.settings.previewFont, props.settings.fontSize, props.settings.lineHeight, props.settings.previewWidth, props.settings.plantumlEnabled, props.settings.plantumlEndpoint]);
  return <div className="preview-pane">{busy && <span className="preview-loading">渲染中…</span>}<iframe ref={frame} title="Markdown 预览" sandbox="allow-scripts" srcDoc={document} /></div>;
});
