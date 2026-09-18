import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Folder, FolderPlus, FilePlus2, Search, Settings2, PanelLeftClose, PanelLeftOpen, Columns2,
  Eye, Pencil, MoreHorizontal, Sun, Moon, Trash2, Pin, ChevronRight, ChevronDown, FileText,
  List, WandSparkles, Presentation, Download, X, Check, Loader2, Clock3, FolderOpen,
  Bold, Italic, Link, Code, Quote, ListTodo, Maximize2, Menu, ArrowUpDown, RotateCcw } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { Editor, type EditorHandle } from './Editor';
import { Preview, type PreviewHandle } from './Preview';
import { defaults, desktop, request, SaveQueue, parentPath, baseName, type Document, type Note, type Settings, type Workspace } from './api';
import { headings, snippets, toggleTaskLine, wikiTargets } from './markdown';
import { exportDocument } from './export';

const welcome = '# 让想法发光\n\n欢迎来到 Luma Notes。这里是一个安静、快速、完全属于你的写作空间。\n\n把灵感放进文件夹，用 Markdown 把零散的想法串成自己的知识地图。\n\n## 现在开始\n\n- 选择一个本地文件夹作为你的 Luma Space\n- 用 **Markdown** 写下任何值得留下的东西\n- 用 `[[笔记名称]]` 连接你的想法\n- 在预览、演示或专注模式之间自由切换\n\n> Small thoughts. Bright ideas.\n';
const welcomeDoc: Document = { path: '', name: '开始使用 Luma', content: welcome, revision: '', modified: 0, created: 0 };
const dateLabel = (value: number) => value ? new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
const summary = (text = '') => text.replace(/^---[\s\S]*?---/, '').replace(/[#*`>\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 72);
type Dialog = { title: string; message?: string; value?: string; danger?: boolean; resolve: (value: string | null) => void };

function IconButton({ title, children, onClick, active, disabled }: { title: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button ${active ? 'active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [doc, setDoc] = useState<Document>(welcomeDoc);
  const [content, setContent] = useState(welcome);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);
  const [folder, setFolder] = useState('*');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('通用');
  const [history, setHistory] = useState<{ id: string; modified: number; content: string }[] | null>(null);
  const [historySelection, setHistorySelection] = useState(0);
  const [trash, setTrash] = useState<{ id: string; path: string; deleted: number }[]>([]);
  const [toc, setToc] = useState(false);
  const [focus, setFocus] = useState(false);
  const [ppt, setPpt] = useState(false);
  const [menu, setMenu] = useState(false);
  const [formatMenu, setFormatMenu] = useState(false);
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const session = useRef({ doc: welcomeDoc, content: welcome, dirty: false });
  const queue = useRef(new SaveQueue());
  const editor = useRef<EditorHandle>(null);
  const preview = useRef<PreviewHandle>(null);
  const generation = useRef(0);
  const navigating = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ settings, workspace }); latest.current = { settings, workspace };
  const dark = settings.theme === 'dark' || settings.theme === 'system' && systemDark;
  const notify = useCallback((text: string) => setToast(text), []);
  const fail = useCallback((value: unknown) => setError(String(value)), []);
  const checkForUpdates = useCallback(async () => {
    if (!desktop) { notify('请在 Luma Notes Windows 安装版中检查更新'); return; }
    try {
      const [{ check }, { relaunch }] = await Promise.all([import('@tauri-apps/plugin-updater'), import('@tauri-apps/plugin-process')]);
      const update = await check();
      if (!update) { notify('当前已是最新版本'); return; }
      if (!await confirm('发现 Luma Notes 更新', `新版本 ${update.version} 已发布，是否立即下载并安装？`)) return;
      setBusy(true);
      await update.downloadAndInstall();
      notify('更新已安装，正在重启 Luma Notes');
      await relaunch();
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  }, [fail, notify]);
  const prompt = (title: string, value: string, message?: string) => new Promise<string | null>(resolve => setDialog({ title, value, message, resolve }));
  const confirm = (title: string, message: string, danger = false) => new Promise<boolean>(resolve => setDialog({ title, message, danger, resolve: value => resolve(value !== null) }));
  const applyDocument = (value: Document) => {
    session.current = { doc: value, content: value.content, dirty: false };
    setDoc(value); setContent(value.content); setDirty(false); setSelected(value.path ? [value.path] : []);
    setSettings(s => ({ ...s, lastNote: value.path }));
  };
  const change = (text: string) => {
    session.current.content = text; session.current.dirty = true;
    setContent(text); setDirty(true);
  };
  const flush = useCallback(() => queue.current.run(async () => {
    setSaving(true);
    try {
      while (session.current.dirty && session.current.doc.path) {
      const snapshot = { ...session.current };
      const saved = await request<Document>('save', { path: snapshot.doc.path, content: snapshot.content, revision: snapshot.doc.revision });
      if (session.current.doc.path === snapshot.doc.path) {
        session.current.doc = saved;
        session.current.dirty = session.current.content !== snapshot.content;
        setDoc(saved); setDirty(session.current.dirty);
      }
      setWorkspace(ws => ws ? { ...ws, notes: ws.notes.map(note => note.path === saved.path ? saved : note) } : ws);
      }
    } finally { setSaving(false); }
  }), []);
  const refresh = useCallback(async () => {
    const ws = await request<Workspace>('list'); setWorkspace(ws); return ws;
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    if (navigating.current) return;
    navigating.current = true; setBusy(true); setMenu(false); setError('');
    try { await action(); } catch (e) { fail(e); }
    finally { navigating.current = false; setBusy(false); }
  };
  const openNote = async (path: string) => run(async () => {
    if (path === session.current.doc.path) return;
    await flush(); const id = ++generation.current;
    const value = await request<Document>('read', { path });
    if (id === generation.current) applyDocument(value);
    setPpt(false);
  });
  const chooseWorkspace = () => run(async () => {
    await flush(); const ws = await request<Workspace | null>('choose_workspace');
    if (ws) { setWorkspace(ws); setFolder('*'); applyDocument(welcomeDoc); }
  });
  const createNote = (suggestion = '无标题') => run(async () => {
    if (!workspace) { const ws = await request<Workspace | null>('choose_workspace'); if (ws) setWorkspace(ws); return; }
    const name = await prompt('新建笔记', suggestion, '文件会保存在当前文件夹中。'); if (!name?.trim()) return;
    await flush(); const directory = folder === '*' || folder === '.trash' ? '' : folder;
    const path = [directory, /\.md$/i.test(name) ? name : `${name}.md`].filter(Boolean).join('/');
    const value = await request<Document>('create_note', { path, content: `# ${name.replace(/\.md$/i, '')}\n\n` });
    await refresh(); applyDocument(value); setTimeout(() => editor.current?.focus(), 100);
  });
  const createFolder = () => run(async () => {
    const name = await prompt('新建文件夹', '', '输入文件夹名称，可以用 / 创建多级目录。'); if (!name?.trim()) return;
    await request('create_folder', { path: [folder === '*' || folder === '.trash' ? '' : folder, name].filter(Boolean).join('/') }); await refresh();
  });
  const rename = () => run(async () => {
    const name = await prompt('重命名笔记', baseName(doc.path)); if (!name || name === baseName(doc.path)) return;
    await flush(); const newPath = [parentPath(doc.path), name.endsWith('.md') ? name : `${name}.md`].filter(Boolean).join('/');
    const value = await request<Document>('rename', { path: doc.path, newPath }); await refresh(); applyDocument(value);
  });
  const deleteNotes = () => run(async () => {
    const paths = selected.length ? selected : [doc.path]; if (!paths[0]) return;
    if (!await confirm('移入回收站', `将 ${paths.length} 篇笔记移入应用回收站，可随时恢复。`, true)) return;
    await flush();
    for (const path of paths) {
      await request('trash', { path });
      if (path === session.current.doc.path) applyDocument(welcomeDoc);
    }
    await refresh(); setSelected([]); notify('已移入回收站');
  });
  const format = () => run(async () => {
    const owner = session.current.doc.path; const before = session.current.content;
    const prettier = await import('prettier/standalone'); const parser = await import('prettier/plugins/markdown');
    const result = await prettier.format(before, { parser: 'markdown', plugins: [parser], proseWrap: 'preserve' });
    if (session.current.doc.path === owner && session.current.content === before) { change(result); notify('自动排版完成'); }
    else notify('内容已变化，本次排版未应用');
  });
  const onFiles = (files: File[]) => run(async () => {
    if (!doc.path) throw new Error('请先创建或打开笔记');
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const result = await request<{ path: string; link: string }>('attachment_save', { notePath: doc.path, name: file.name, base64: btoa(binary), image: file.type.startsWith('image/') });
      editor.current?.insert(`${file.type.startsWith('image/') ? '!' : ''}[${file.name.replace(/[\[\]]/g, '')}](${result.link})\n`);
    }
  });
  const exportAs = (type: 'html' | 'png' | 'pdf') => run(async () => {
    await flush(); if (!preview.current) { setSettings(s => ({ ...s, mode: 'split' })); throw new Error('已开启预览，请待预览完成后再次导出'); }
    const html = await preview.current.snapshot();
    await exportDocument(type, html, doc.name.replace(/\.md$/i, '') || 'Luma Note'); notify('导出完成');
  });
  const openWiki = (target: string) => {
    const candidates = workspace?.notes.filter(n => n.path.replace(/\.md$/i, '') === target || n.name.replace(/\.md$/i, '') === target) || [];
    if (candidates.length === 1) void openNote(candidates[0].path);
    else if (candidates.length > 1) { setSearch(target); notify('找到同名笔记，请从列表选择'); }
    else void createNote(target);
  };
  useEffect(() => {
    let cancelled = false;
    if (!desktop) { setReady(true); return; }
    request<{ prefs: Partial<Settings>; workspace: Workspace | null }>('bootstrap').then(async value => {
      if (cancelled) return;
      setSettings({ ...defaults, ...value.prefs }); setWorkspace(value.workspace);
      if (value.prefs.lastNote && value.workspace?.notes.some(n => n.path === value.prefs.lastNote)) {
        const note = await request<Document>('read', { path: value.prefs.lastNote }); if (!cancelled) applyDocument(note);
      }
    }).catch(fail).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { const query = matchMedia('(prefers-color-scheme: dark)'); const update = () => setSystemDark(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  useEffect(() => { if (!ready || !desktop) return; const timer = setTimeout(() => request('prefs', settings as unknown as Record<string, unknown>).catch(fail), 500); return () => clearTimeout(timer); }, [settings, ready]);
  useEffect(() => { if (!dirty || !doc.path) return; const timer = setTimeout(() => flush().catch(fail), 650); return () => clearTimeout(timer); }, [content, dirty, doc.path]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!workspace || !desktop) return;
    const timer = setInterval(async () => {
      if (navigating.current || saving) return;
      try {
        const ws = await request<Workspace>('list'); setWorkspace(ws);
        const current = session.current;
        if (!current.doc.path || current.dirty) return;
        const disk = ws.notes.find(n => n.path === current.doc.path);
        if (disk && disk.content !== undefined && disk.content !== current.content) {
          const fresh = await request<Document>('read', { path: current.doc.path });
          if (session.current.doc.path === fresh.path && !session.current.dirty) { applyDocument(fresh); notify('已载入外部修改'); }
        }
      } catch { /* Active operation reports errors; unavailable folders are not repeatedly toasted. */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [workspace?.root, saving]);
  useEffect(() => {
    if (!desktop) return;
    let gone = false; let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault();
      navigating.current = true; setBusy(true);
      try { await flush(); await getCurrentWindow().destroy(); } catch (e) { fail(e); navigating.current = false; setBusy(false); }
    }).then(fn => { if (gone) fn(); else unlisten = fn; });
    return () => { gone = true; unlisten?.(); };
  }, [flush]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (dialog || settingsOpen || history) return;
      if (event.key === 'Escape') { setPpt(false); setFocus(false); setMenu(false); setToc(false); return; }
      if (!event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const commands: Record<string, () => void> = {
        's': () => void flush().catch(fail), 'n': () => { if (event.shiftKey) void createFolder(); else void createNote(); },
        '1': () => setSettings(s => ({ ...s, showSidebar: !s.showSidebar })),
        '2': () => setSettings(s => ({ ...s, showList: !s.showList })),
        '3': () => setSettings(s => ({ ...s, mode: s.mode === 'preview' ? 'edit' : 'preview' })),
        '4': () => setFocus(v => !v), '5': () => setToc(v => !v),
        '\\': () => setSettings(s => ({ ...s, mode: s.mode === 'split' ? 'edit' : 'split' })),
        ',': () => setSettingsOpen(true), '/': () => searchInput.current?.focus(),
        'b': () => editor.current?.format('**'), 'i': () => editor.current?.format('*'),
        'r': () => void rename(), 'delete': () => void deleteNotes(),
      };
      if (key === 'l' && event.shiftKey) { event.preventDefault(); void format(); return; }
      if (commands[key]) { event.preventDefault(); commands[key](); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });
  const visible = (workspace?.notes || []).filter(note =>
    (folder === '*' || parentPath(note.path) === folder) && (!search || `${note.name}\n${note.content || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  ).sort((a, b) => Number(settings.pinned.includes(b.path)) - Number(settings.pinned.includes(a.path)) ||
    (settings.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : a[settings.sort] - b[settings.sort]) * (settings.ascending ? 1 : -1));
  const backlinks = workspace?.notes.filter(n => n.path !== doc.path && wikiTargets(n.content || '').some(target => target === doc.name.replace(/\.md$/i, '') || target === doc.path.replace(/\.md$/i, ''))) || [];
  const outline = headings(content);
  const css = { '--sidebar-width': `${settings.sidebarWidth}px`, '--list-width': `${settings.listWidth}px`, '--interface-font': settings.interfaceFont } as CSSProperties;
  const resize = (field: 'sidebarWidth' | 'listWidth', event: React.PointerEvent) => {
    const x = event.clientX; const width = settings[field]; event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.currentTarget as HTMLElement;
    const move = (e: PointerEvent) => setSettings(s => ({ ...s, [field]: Math.max(150, Math.min(420, width + e.clientX - x)) }));
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  };
  return <div className={`app ${dark ? 'dark' : ''} buttons-${settings.buttons} ${focus || ppt ? 'focused' : ''}`} style={css}>
    <header className="titlebar"><span className="brand-mark">L</span><span className="brand-word">Luma <small>NOTES</small></span><span className="titlebar-center">{workspace ? baseName(workspace.root) : '让想法发光'}</span><span className="unofficial">LOCAL / PRIVATE</span></header>
    {!desktop && <div className="browser-banner">界面预览 · 本地文件功能请通过 Windows 桌面应用使用</div>}
    <main className="workbench">
      {settings.showSidebar && !focus && !ppt && <><aside className="sidebar">
        <div className="sidebar-heading"><span>YOUR SPACE</span><IconButton title="新建文件夹" onClick={createFolder} disabled={!workspace}><FolderPlus size={17}/></IconButton></div>
        <button className={`folder-row ${folder === '*' ? 'selected' : ''}`} onClick={() => setFolder('*')}><FileText size={17}/><span>All notes</span><small>{workspace?.notes.length || 0}</small></button>
        <div className="sidebar-label">COLLECTIONS</div>
        <div className="folder-tree">{workspace?.folders.map(path => <button key={path} className={`folder-row ${folder === path ? 'selected' : ''}`} style={{ paddingLeft: 15 + path.split('/').length * 9 }} onClick={() => setFolder(path)} onContextMenu={event => { event.preventDefault(); void run(async () => {
          const choice = await prompt('文件夹操作', path, '修改路径以重命名或移动文件夹。'); if (!choice || choice === path) return;
          await flush(); await request('rename', { path, newPath: choice }); await refresh(); applyDocument(welcomeDoc); setFolder(choice);
        }); }}><Folder size={16}/><span>{baseName(path)}</span></button>)}</div>
        <button className={`folder-row trash-link ${folder === '.trash' ? 'selected' : ''}`} onClick={() => void run(async () => { await flush(); setTrash(await request('trash_list')); setFolder('.trash'); })}><Trash2 size={17}/><span>回收站</span></button>
        <div className="sidebar-bottom"><button className="storage-button" onClick={chooseWorkspace} title={workspace?.root || '选择笔记目录'}><FolderOpen size={16}/><span>{workspace ? baseName(workspace.root) : '选择笔记文件夹'}</span></button>
          <div className="sidebar-tools"><IconButton title="偏好设置 Ctrl+," onClick={() => setSettingsOpen(true)}><Settings2 size={17}/></IconButton><span>SYNCED LOCALLY</span><IconButton title="切换主题" onClick={() => setSettings(s => ({ ...s, theme: dark ? 'light' : 'dark' }))}>{dark ? <Sun size={16}/> : <Moon size={16}/>}</IconButton></div></div>
      </aside><div className="resize-handle" onPointerDown={event => resize('sidebarWidth', event)}/></>}
      {settings.showList && !focus && !ppt && <><section className="note-list">
        <div className="list-heading"><div><span className="eyebrow">LUMA SPACE</span><h2>{folder === '*' ? 'All notes' : folder === '.trash' ? '回收站' : baseName(folder)}</h2></div><IconButton title="新建笔记 Ctrl+N" onClick={() => void createNote()} disabled={!workspace}><FilePlus2 size={18}/></IconButton></div>
        <label className="search-box"><Search size={15}/><input ref={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索笔记…" aria-label="搜索笔记"/>{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13}/></button>}</label>
        <div className="list-meta"><span>{folder === '.trash' ? trash.length : visible.length} 篇笔记</span><select aria-label="排序方式" value={settings.sort} onChange={e => setSettings(s => ({ ...s, sort: e.target.value as Settings['sort'] }))}><option value="modified">修改时间</option><option value="created">创建时间</option><option value="name">标题</option></select><button title="切换升降序" onClick={() => setSettings(s => ({ ...s, ascending: !s.ascending }))}><ArrowUpDown size={13}/></button></div>
        <div className="note-cards">{folder === '.trash' ? trash.map(item => <div className="trash-card" key={item.id}><strong>{baseName(item.path)}</strong><small>{dateLabel(item.deleted)}</small><div><button onClick={() => void run(async () => { await request('trash_restore', { id: item.id }); setTrash(await request('trash_list')); await refresh(); })}>恢复</button><button onClick={() => void run(async () => { if (await confirm('移至系统回收站', '从应用回收站移除，之后可在 Windows 回收站找回。', true)) { await request('trash_delete', { id: item.id }); setTrash(await request('trash_list')); } })}>移除</button></div></div>) : visible.map(note => <button key={note.path} className={`note-card ${doc.path === note.path ? 'current' : ''} ${selected.includes(note.path) ? 'checked' : ''}`} onClick={event => {
          if (event.ctrlKey) setSelected(paths => paths.includes(note.path) ? paths.filter(p => p !== note.path) : [...paths, note.path]); else void openNote(note.path);
        }}><div className="note-card-title">{settings.pinned.includes(note.path) && <Pin size={12}/>}<strong>{note.name.replace(/\.md$/i, '')}</strong></div><p>{summary(note.content) || '还没有内容'}</p><div><time>{dateLabel(note.modified)}</time><span>{parentPath(note.path) ? baseName(parentPath(note.path)) : '笔记'}</span></div></button>)}
        {!visible.length && folder !== '.trash' && <div className="empty-list"><Pencil size={24}/><p>{search ? '没有找到相关笔记' : '从第一篇笔记开始'}</p><button onClick={() => workspace ? void createNote() : chooseWorkspace()}>{workspace ? '新建笔记' : '选择文件夹'}</button></div>}</div>
      </section><div className="resize-handle" onPointerDown={event => resize('listWidth', event)}/></>}
      <section className="document-area">
        <div className="document-toolbar"><div className="toolbar-group"><IconButton title="切换文件夹 Ctrl+1" onClick={() => setSettings(s => ({ ...s, showSidebar: !s.showSidebar }))}>{settings.showSidebar ? <PanelLeftClose size={17}/> : <PanelLeftOpen size={17}/>}</IconButton><IconButton title="切换笔记列表 Ctrl+2" onClick={() => setSettings(s => ({ ...s, showList: !s.showList }))}><List size={18}/></IconButton><span className="toolbar-divider"/><span className="breadcrumb">{doc.path ? parentPath(doc.path) || '笔记' : '欢迎'}<ChevronRight size={12}/></span></div>
          <div className="toolbar-group"><IconButton title="自动排版 Ctrl+Shift+L" onClick={format} disabled={!doc.path}><WandSparkles size={17}/></IconButton><div className="mode-switch">{(['edit', 'split', 'preview'] as const).map(mode => <IconButton key={mode} title={{ edit: '编辑', split: '分栏', preview: '预览' }[mode]} active={settings.mode === mode} onClick={() => setSettings(s => ({ ...s, mode }))}>{mode === 'edit' ? <Pencil size={15}/> : mode === 'split' ? <Columns2 size={16}/> : <Eye size={17}/>}</IconButton>)}</div><IconButton title="文档大纲 Ctrl+5" onClick={() => setToc(v => !v)} active={toc}><ListTodo size={17}/></IconButton><IconButton title="更多操作" onClick={() => setMenu(v => !v)}><MoreHorizontal size={20}/></IconButton></div>
          {menu && <div className="dropdown document-menu"><button onClick={rename} disabled={!doc.path}>重命名 <kbd>Ctrl R</kbd></button><button onClick={() => void run(async () => { await flush(); const newPath = await prompt('复制笔记', doc.path.replace(/\.md$/i, ' 副本.md')); if (newPath) { const copy = await request<Document>('duplicate', { path: doc.path, newPath }); await refresh(); applyDocument(copy); } })} disabled={!doc.path}>创建副本</button><button onClick={() => void run(async () => { await flush(); const newPath = await prompt('移动笔记', doc.path, '输入相对于工作区的新路径'); if (newPath && newPath !== doc.path) { const value = await request<Document>('move', { path: doc.path, newPath }); await refresh(); applyDocument(value); } })} disabled={!doc.path}>移动到…</button><button onClick={() => { setSettings(s => ({ ...s, pinned: s.pinned.includes(doc.path) ? s.pinned.filter(p => p !== doc.path) : [...s.pinned, doc.path] })); setMenu(false); }} disabled={!doc.path}>置顶 / 取消置顶</button><hr/>
            <button onClick={() => void run(async () => { await flush(); setHistory(await request('history', { path: doc.path })); setHistorySelection(0); })} disabled={!doc.path}>版本历史</button><button onClick={() => void run(async () => { if (session.current.dirty && !await confirm('重新加载', '未保存内容将被丢弃，是否继续？', true)) return; applyDocument(await request('read', { path: doc.path })); })} disabled={!doc.path}>重新加载</button><button onClick={() => void run(async () => { await request('reveal', { path: doc.path }); })}>在资源管理器中显示</button><button onClick={() => void navigator.clipboard.writeText(workspace ? `${workspace.root}\\${doc.path.replace(/\//g, '\\')}` : '').then(() => notify('路径已复制')).catch(fail)}>复制路径</button><hr/>
            <button onClick={() => void exportAs('html')}>导出 HTML</button><button onClick={() => void exportAs('png')}>导出图片</button><button onClick={() => void exportAs('pdf')}>{ppt ? '导出 PPT PDF' : '导出 PDF'}</button><button onClick={() => { setPpt(v => !v); setMenu(false); }}>Presentation mode</button><button onClick={() => { setFocus(v => !v); setMenu(false); }}>Focus mode</button><hr/><button className="danger" onClick={deleteNotes} disabled={!doc.path}>移入回收站</button><button onClick={() => { setSettingsOpen(true); setMenu(false); }}>偏好设置</button></div>}
        </div>
        <div className="document-heading"><h1 onDoubleClick={doc.path ? rename : undefined}>{doc.name.replace(/\.md$/i, '')}</h1><span className="save-indicator">{saving ? <><Loader2 className="spin" size={12}/>保存中</> : dirty ? <><span className="dirty-dot"/>未保存</> : doc.path ? <><Check size={13}/>已保存到本地</> : '轻灵的 Markdown 笔记本'}</span></div>
        {(focus || ppt) && <button className="exit-focus" onClick={() => { setFocus(false); setPpt(false); }}>退出 {ppt ? 'PPT' : '专注'} · Esc</button>}
        <div className="editing-surface" style={{ flexDirection: settings.splitDirection }}>
          <div className="editor-holder" style={{ display: settings.mode === 'preview' || ppt ? 'none' : 'flex' }}><Editor ref={editor} path={doc.path} content={content} settings={settings} dark={dark} readOnly={busy || !doc.path} onChange={change} onFiles={onFiles} onScroll={ratio => preview.current?.scroll(ratio)}/></div>
          {(settings.mode !== 'edit' || ppt) && <Preview ref={preview} content={content} path={doc.path} settings={settings} dark={dark} ppt={ppt} onTask={line => { if (!navigating.current && doc.path) change(toggleTaskLine(session.current.content, line)); }} onWiki={openWiki} onScroll={ratio => editor.current?.scroll(ratio)} onError={fail}/>}
          {toc && <aside className="outline"><div>文档大纲<button onClick={() => setToc(false)} aria-label="关闭大纲"><X size={14}/></button></div>{outline.map(item => <button key={item.line} style={{ paddingLeft: item.level * 10 }} onClick={() => { preview.current?.heading(item.line); editor.current?.heading(item.line); }}>{item.title}</button>)}{backlinks.length > 0 && <><div>反向链接</div>{backlinks.map(n => <button key={n.path} onClick={() => void openNote(n.path)}>{n.name}</button>)}</>}</aside>}
        </div>
        <footer className="statusbar"><div className="format-tools"><IconButton title="粗体 Ctrl+B" onClick={() => editor.current?.format('**')}><Bold size={14}/></IconButton><IconButton title="斜体 Ctrl+I" onClick={() => editor.current?.format('*')}><Italic size={14}/></IconButton><IconButton title="插入链接" onClick={() => editor.current?.format('[', '](https://)')}><Link size={14}/></IconButton><IconButton title="行内代码" onClick={() => editor.current?.format('`')}><Code size={15}/></IconButton><IconButton title="快捷模板" onClick={() => setFormatMenu(v => !v)}><Menu size={14}/></IconButton>{formatMenu && <div className="dropdown snippet-menu">{Object.keys(snippets).map(key => <button key={key} onClick={() => { editor.current?.insert(snippets[key]); setFormatMenu(false); }}>/{key}</button>)}</div>}</div><div><span>{content.replace(/\s/g, '').length.toLocaleString()} 字</span><span>{content.split('\n').length} 行</span><span>Markdown</span><button title="专注模式" onClick={() => setFocus(v => !v)}><Maximize2 size={13}/></button></div></footer>
      </section>
    </main>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => void flush().then(() => setError('')).catch(fail)}>重试保存</button><button onClick={() => void run(async () => { await request('export_file', { name: doc.name || '恢复笔记.md', content: session.current.content }); notify('内容已另存'); })}>另存内容</button><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={16}/></button></div>}
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
    {busy && <div className="busy-indicator"><Loader2 className="spin" size={14}/>处理中</div>}
    {dialog && <div className="modal-backdrop"><form className="dialog" onSubmit={event => { event.preventDefault(); const value = dialog.value ?? ''; dialog.resolve(value); setDialog(null); }}><h2>{dialog.title}</h2>{dialog.message && <p>{dialog.message}</p>}{dialog.value !== undefined && <input autoFocus value={dialog.value} onChange={e => setDialog({ ...dialog, value: e.target.value })} onFocus={e => e.target.select()}/>}<div className="dialog-actions"><button type="button" onClick={() => { dialog.resolve(null); setDialog(null); }}>取消</button><button className={dialog.danger ? 'danger-button' : 'primary'} type="submit">确认</button></div></form></div>}
    {history && <div className="modal-backdrop"><section className="history-modal"><header><h2>版本历史</h2><button onClick={() => setHistory(null)} aria-label="关闭历史"><X size={20}/></button></header><div className="history-body"><aside>{history.map((item, index) => <button className={index === historySelection ? 'selected' : ''} key={item.id} onClick={() => setHistorySelection(index)}><Clock3 size={14}/>{new Date(item.modified).toLocaleString()}</button>)}{!history.length && <p>暂无历史版本。编辑时自动保存快照。</p>}</aside><pre>{history[historySelection]?.content || ''}</pre></div><footer><button className="primary" disabled={!history.length} onClick={() => void run(async () => { if (!await confirm('恢复此版本', '当前内容会先保留一个历史版本。')) return; await flush(); const value = await request<Document>('history_restore', { path: doc.path, id: history[historySelection].id, revision: session.current.doc.revision }); applyDocument(value); setHistory(null); await refresh(); })}>恢复到此版本</button></footer></section></div>}
    {settingsOpen && <div className="modal-backdrop"><section className="settings-modal"><header><h2>偏好设置</h2><button onClick={() => setSettingsOpen(false)} aria-label="关闭设置"><X size={20}/></button></header><div className="settings-body"><nav>{['通用', '编辑器', '预览', '文件与附件', '关于'].map(tab => <button key={tab} className={tab === settingsTab ? 'selected' : ''} onClick={() => setSettingsTab(tab)}>{tab}</button>)}</nav><div className="settings-content">
      {settingsTab === '通用' && <><h3>外观与窗口</h3><Setting label="外观"><select value={settings.theme} onChange={e => setSettings(s => ({ ...s, theme: e.target.value as Settings['theme'] }))}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></Setting><Setting label="界面字体"><input value={settings.interfaceFont} onChange={e => setSettings(s => ({ ...s, interfaceFont: e.target.value }))}/></Setting><Setting label="按钮显示"><select value={settings.buttons} onChange={e => setSettings(s => ({ ...s, buttons: e.target.value as Settings['buttons'] }))}><option value="always">始终显示</option><option value="hover">悬停显示</option><option value="never">隐藏辅助按钮</option></select></Setting><Setting label="窗口置顶"><input type="checkbox" checked={settings.alwaysOnTop} onChange={e => { const value = e.target.checked; void run(async () => { await getCurrentWindow().setAlwaysOnTop(value); setSettings(s => ({ ...s, alwaysOnTop: value })); }); }}/></Setting><Setting label="全局唤起快捷键"><input value={settings.activateShortcut} onChange={e => setSettings(s => ({ ...s, activateShortcut: e.target.value }))}/></Setting></>}
      {settingsTab === '编辑器' && <><h3>让写作更舒适</h3><Setting label="正文字体"><input value={settings.editorFont} onChange={e => setSettings(s => ({ ...s, editorFont: e.target.value }))}/></Setting><Setting label="字号"><input type="number" min="12" max="40" value={settings.fontSize} onChange={e => setSettings(s => ({ ...s, fontSize: Math.max(12, Math.min(40, Number(e.target.value))) }))}/></Setting><Setting label="行高"><input type="number" min="1.2" max="3" step="0.05" value={settings.lineHeight} onChange={e => setSettings(s => ({ ...s, lineHeight: Number(e.target.value) }))}/></Setting><Setting label="自动换行"><input type="checkbox" checked={settings.wrap} onChange={e => setSettings(s => ({ ...s, wrap: e.target.checked }))}/></Setting><p className="setting-hint">输入 /table、/task、/mermaid 等命令后按 Tab 展开模板。Ctrl+Shift+L 自动排版。</p></>}
      {settingsTab === '预览' && <><h3>阅读与图表</h3><Setting label="预览字体"><input value={settings.previewFont} onChange={e => setSettings(s => ({ ...s, previewFont: e.target.value }))}/></Setting><Setting label="预览宽度"><input type="number" min="400" max="1800" value={settings.previewWidth} onChange={e => setSettings(s => ({ ...s, previewWidth: Number(e.target.value) }))}/></Setting><Setting label="分栏位置"><select value={settings.splitDirection} onChange={e => setSettings(s => ({ ...s, splitDirection: e.target.value as 'row' | 'column' }))}><option value="row">右侧</option><option value="column">底部</option></select></Setting><Setting label="启用 PlantUML 服务"><input type="checkbox" checked={settings.plantumlEnabled} onChange={e => setSettings(s => ({ ...s, plantumlEnabled: e.target.checked }))}/></Setting><p className="setting-hint">启用后会将 PlantUML 图表内容发送到下方服务。其他公式、Mermaid 和思维导图在本地渲染。</p><Setting label="PlantUML 服务地址"><input value={settings.plantumlEndpoint} onChange={e => setSettings(s => ({ ...s, plantumlEndpoint: e.target.value }))}/></Setting></>}
      {settingsTab === '文件与附件' && <><h3>笔记始终是本地文件</h3><p className="storage-path">{workspace?.root || '尚未选择文件夹'}</p><button onClick={chooseWorkspace}>更改存储位置</button><div className="settings-buttons"><button onClick={() => void run(async () => { await flush(); const ws = await request<Workspace | null>('import_files'); if (ws) setWorkspace(ws); })}>导入 Markdown 文件</button><button onClick={() => void run(async () => { await flush(); const ws = await request<Workspace | null>('import_folder'); if (ws) setWorkspace(ws); })}>导入文件夹</button><button onClick={() => void run(async () => { await flush(); const result = await request<{ workspace: Workspace; note: Document } | null>('open_file'); if (result) { setWorkspace(result.workspace); applyDocument(result.note); setSettingsOpen(false); } })}>单独打开文件</button><button onClick={() => void run(async () => { const paths = await request<string[]>('orphan_candidates'); if (!paths.length) { notify('没有发现孤立附件'); return; } if (await confirm('清理孤立附件', `以下 ${paths.length} 个附件将移入回收站：\n${paths.join('\n')}`, true)) { for (const path of paths) await request('trash', { path }); notify('附件已移入回收站'); } })}>清理孤立附件</button></div><p className="setting-hint">如需同步，可选择 OneDrive 或坚果云的本地同步文件夹。软件不会上传笔记正文。</p></>}
      {settingsTab === '关于' && <div className="about"><div className="about-mark">L</div><h2>Luma Notes</h2><p>Small thoughts. Bright ideas.</p><small>0.1.1 · Luma desktop</small><p>Local-first Markdown workspace.<br/>Your files stay yours.</p><button onClick={() => void checkForUpdates()}>检查更新</button></div>}
    </div></div><footer>设置自动保存</footer></section></div>}
  </div>;
}
function Setting({ label, children }: { label: string; children: ReactNode }) { return <label className="setting-row"><span>{label}</span>{children}</label>; }
