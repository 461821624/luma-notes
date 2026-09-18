import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { snippets } from './markdown';
import type { Settings } from './api';

export type EditorHandle = { insert: (text: string) => void; format: (before: string, after?: string) => void;
  scroll: (ratio: number) => void; focus: () => void; search: () => void; heading: (line: number) => void };
type Props = { path: string; content: string; settings: Settings; dark: boolean; readOnly: boolean; onChange: (text: string) => void;
  onScroll: (ratio: number) => void; onFiles: (files: File[]) => void };

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props); current.current = props;
  const theme = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const applying = useRef(false);
  const syncedScroll = useRef(false);
  const cache = useRef(new Map<string, EditorState>());
  const insert = (text: string) => {
    const editor = view.current; if (!editor || !current.current.path) return;
    editor.dispatch(editor.state.replaceSelection(text)); editor.focus();
  };
  useImperativeHandle(ref, () => ({
    insert, focus: () => view.current?.focus(), search: () => { if (view.current) openSearchPanel(view.current); },
    format: (before, after = before) => {
      const editor = view.current; if (!editor || current.current.readOnly) return;
      const range = editor.state.selection.main;
      const selected = editor.state.sliceDoc(range.from, range.to);
      editor.dispatch({ changes: { from: range.from, to: range.to, insert: before + (selected || '文字') + after },
        selection: { anchor: range.from + before.length, head: range.from + before.length + (selected || '文字').length } });
      editor.focus();
    },
    scroll: ratio => { const editor = view.current; if (!editor) return; syncedScroll.current = true;
      editor.scrollDOM.scrollTop = ratio * (editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight);
      setTimeout(() => { syncedScroll.current = false; }, 100); },
    heading: line => { const editor = view.current; if (editor) editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.doc.line(Math.min(line + 1, editor.state.doc.lines)).from, { y: 'start' }) }); },
  }), []);
  useEffect(() => {
    const saved = cache.current.get(props.path);
    const editor = new EditorView({ parent: element.current!, state: saved?.doc.toString() === props.content ? saved : EditorState.create({ doc: props.content, extensions: [
      history(), drawSelection(), lineNumbers(), highlightActiveLine(), markdown(), bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle), highlightSelectionMatches(),
      wrapping.current.of(EditorView.lineWrapping), theme.current.of(EditorView.theme({})),
      editable.current.of(EditorState.readOnly.of(props.readOnly)),
      keymap.of([{ key: 'Tab', run: editor => {
        const cursor = editor.state.selection.main.head;
        const before = editor.state.sliceDoc(Math.max(0, cursor - 24), cursor);
        const match = /\/(\w+)$/.exec(before);
        if (!match) return false;
        const text = match[1] === 'time' ? new Date().toLocaleString('sv-SE') : snippets[match[1]];
        if (!text) return false;
        editor.dispatch({ changes: { from: cursor - match[0].length, to: cursor, insert: text } }); return true;
      } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of(update => { if (update.docChanged && !applying.current) current.current.onChange(update.state.doc.toString()); }),
      EditorView.domEventHandlers({
        scroll: (_event, editor) => { if (!syncedScroll.current) current.current.onScroll(editor.scrollDOM.scrollTop / Math.max(1, editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight)); },
        paste: event => { const files = [...(event.clipboardData?.files || [])]; if (!files.length) return false; event.preventDefault(); current.current.onFiles(files); return true; },
        drop: event => { const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return false; event.preventDefault(); current.current.onFiles(files); return true; },
      }),
    ] }) });
    view.current = editor;
    return () => { cache.current.set(props.path, editor.state); editor.destroy(); view.current = null; };
  }, [props.path]);
  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(props.readOnly)) });
  }, [props.readOnly, props.path]);
  useEffect(() => {
    const editor = view.current; if (!editor || editor.state.doc.toString() === props.content) return;
    applying.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.content } });
    applying.current = false;
  }, [props.content]);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    editor.dispatch({ effects: [theme.current.reconfigure(EditorView.theme({
      '&': { height: '100%', fontSize: `${props.settings.fontSize}px`, color: props.dark ? '#dedfe3' : '#333941', backgroundColor: 'transparent' },
      '.cm-content': { fontFamily: props.settings.editorFont, lineHeight: String(props.settings.lineHeight), padding: '28px 0 90px' },
      '.cm-line': { padding: '0 28px' }, '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: props.dark ? '#555c64' : '#c1c2c3', fontSize: '11px' },
      '.cm-gutterElement': { paddingLeft: '12px' }, '.cm-activeLine': { backgroundColor: props.dark ? '#ffffff04' : '#00000002' },
      '.cm-cursor': { borderLeftColor: '#a5815b' }, '.cm-selectionBackground': { backgroundColor: '#bda27a40 !important' },
      '.cm-scroller': { overflow: 'auto' }, '.cm-search': { fontFamily: 'Segoe UI, sans-serif', fontSize: '13px' },
    }, { dark: props.dark })), wrapping.current.reconfigure(props.settings.wrap ? EditorView.lineWrapping : [])] });
  }, [props.settings, props.dark, props.path]);
  return <div className="editor-pane" ref={element} />;
});
