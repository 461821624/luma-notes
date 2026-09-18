/* The sandbox has no same-origin permission and no Tauri bridge. */
(async () => {
  const config = window.previewConfig;
  const send = (type, payload) => parent.postMessage({ token: config.token, type, payload }, '*');
  let suppressScroll = false;
  const tasks = [...document.querySelectorAll('input[type=checkbox][data-task-line]')];
  tasks.forEach(el => { el.disabled = config.ppt; el.addEventListener('change', () => send('task', Number(el.dataset.taskLine))); });
  document.querySelectorAll('input:not([data-task-line])').forEach(el => { el.disabled = true; });
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#wiki:')) send('wiki', decodeURIComponent(href.slice(6)));
      else if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView();
      else if (/^https?:/.test(href)) send('link', href);
      else send('attachment', href);
    }
    if (event.target.tagName === 'IMG') event.target.classList.toggle('zoomed');
  });
  window.addEventListener('scroll', () => {
    if (!suppressScroll) send('scroll', scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight));
  }, { passive: true });
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.data?.token !== config.token) return;
    const { type, payload } = event.data;
    if (type === 'scroll' && typeof payload === 'number') {
      suppressScroll = true; scrollTo(0, payload * Math.max(0, document.documentElement.scrollHeight - innerHeight));
      setTimeout(() => { suppressScroll = false; }, 100);
    }
    if (type === 'heading') document.getElementById(`heading-${payload}`)?.scrollIntoView();
    if (type === 'find' && typeof payload === 'string') window.find(payload);
    if (type === 'snapshot') {
      await document.fonts.ready;
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script,meta[http-equiv],base').forEach(node => node.remove());
      // Inline styles so the exported document no longer depends on the app server.
      for (const link of [...clone.querySelectorAll('link[rel=stylesheet]')]) {
        const sheet = [...document.styleSheets].find(sheet => sheet.href === new URL(link.getAttribute('href'), document.baseURI).href);
        try { const style = document.createElement('style'); style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n'); link.replaceWith(style); }
        catch { link.setAttribute('href', new URL(link.getAttribute('href'), document.baseURI).href); }
      }
      send('snapshot', '<!doctype html>' + clone.outerHTML);
    }
  });
  try {
    window.hljs?.highlightAll();
    window.renderMathInElement?.(document.body, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }], throwOnError: false });
    if (window.mermaid) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: config.dark ? 'dark' : 'default' });
      for (const [i, code] of [...document.querySelectorAll('code.language-mermaid')].entries()) {
        try { const { svg } = await mermaid.render(`diagram-${i}`, code.textContent); const div = document.createElement('div'); div.innerHTML = svg; code.parentElement.replaceWith(div); }
        catch { code.parentElement.classList.add('diagram-error'); }
      }
    }
    for (const code of document.querySelectorAll('code.language-markmap')) {
      try { const transformed = new window.markmap.Transformer().transform(code.textContent); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.style.cssText = 'width:100%;height:420px'; code.parentElement.replaceWith(svg); window.markmap.Markmap.create(svg, {}, transformed.root); }
      catch { code.parentElement?.classList.add('diagram-error'); }
    }
    for (const code of document.querySelectorAll('code.language-plantuml')) {
      if (!config.plantuml) { const tip = document.createElement('p'); tip.className = 'diagram-error'; tip.textContent = 'PlantUML 需要向渲染服务发送图表内容，请在设置中启用。'; code.parentElement.after(tip); continue; }
      try { const endpoint = new URL(config.plantuml); if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error(); const img = document.createElement('img'); img.alt = 'PlantUML'; img.src = config.plantuml.replace(/\/?$/, '/') + window.plantumlEncoder.encode(code.textContent); code.parentElement.replaceWith(img); }
      catch { code.parentElement?.classList.add('diagram-error'); }
    }
    if (config.ppt && window.Reveal) await Reveal.initialize({ hash: false, embedded: true, controls: true, progress: true, transition: 'none', keyboard: true });
    await Promise.all([...document.images].map(img => img.complete ? Promise.resolve() : new Promise(resolve => { img.onload = img.onerror = resolve; setTimeout(resolve, 10000); })));
  } finally { send('ready', null); }
})();
