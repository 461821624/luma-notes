import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, syntaxTree } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { snippets } from './markdown';
import type { Settings } from './api';

export type EditorHandle = { insert: (text: string) => void; format: (before: string, after?: string) => void;
  scroll: (ratio: number) => void; focus: () => void; search: () => void; heading: (line: number) => void };
type Props = { path: string; content: string; settings: Settings; dark: boolean; readOnly: boolean; onChange: (text: string) => void;
  onScroll: (ratio: number) => void; onFiles: (files: File[]) => void; wysiwyg: boolean };

const wysiwygMark = Decoration.mark({ class: 'cm-wysiwyg-mark' });
const wysiwygStrong = Decoration.mark({ class: 'cm-wysiwyg-strong' });
const wysiwygEmphasis = Decoration.mark({ class: 'cm-wysiwyg-emphasis' });
const wysiwygCode = Decoration.mark({ class: 'cm-wysiwyg-code' });
const wysiwygLink = Decoration.mark({ class: 'cm-wysiwyg-link' });
const wysiwygBlockCode = Decoration.mark({ class: 'cm-wysiwyg-block-code' });
const headingLevels: [number, string][] = [[1, 'cm-wysiwyg-h1'], [2, 'cm-wysiwyg-h2'], [3, 'cm-wysiwyg-h3'], [4, 'cm-wysiwyg-h4'], [5, 'cm-wysiwyg-h5'], [6, 'cm-wysiwyg-h6']];
const headingDecorations = new Map<number, Decoration>(headingLevels
  .map(([level, className]) => [level, Decoration.line({ class: className })] as [number, Decoration]));
const wysiwygExtension = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = buildWysiwygDecorations(view); }
  update(update: { view: EditorView; docChanged: boolean }) { if (update.docChanged) this.decorations = buildWysiwygDecorations(update.view); }
}, { decorations: value => value.decorations });

function buildWysiwygDecorations(view: EditorView) {
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];
  syntaxTree(view.state).iterate({ enter(node) {
    const name = node.name;
    if (name.endsWith('Mark') || name === 'URL' || name === 'LinkTitle') ranges.push({ from: node.from, to: node.to, decoration: wysiwygMark });
    if (name === 'StrongEmphasis') ranges.push({ from: node.from, to: node.to, decoration: wysiwygStrong });
    if (name === 'Emphasis' || name === 'Strikethrough') ranges.push({ from: node.from, to: node.to, decoration: wysiwygEmphasis });
    if (name === 'InlineCode') ranges.push({ from: node.from, to: node.to, decoration: wysiwygCode });
    if (name === 'Link') ranges.push({ from: node.from, to: node.to, decoration: wysiwygLink });
    if (name === 'FencedCode' || name === 'IndentedCode') ranges.push({ from: node.from, to: node.to, decoration: wysiwygBlockCode });
    const heading = /(?:ATX|Setext)Heading([1-6])$/.exec(name);
    if (heading) {
      const line = view.state.doc.lineAt(node.from);
      ranges.push({ from: line.from, to: line.from, decoration: headingDecorations.get(Number(heading[1]))! });
    }
  }});
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props); current.current = props;
  const theme = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const wysiwyg = useRef(new Compartment());
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
      wysiwyg.current.of(props.wysiwyg ? wysiwygExtension : []),
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
    view.current?.dispatch({ effects: wysiwyg.current.reconfigure(props.wysiwyg ? wysiwygExtension : []) });
  }, [props.wysiwyg]);
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
      '.cm-wysiwyg-mark': { color: 'transparent', fontSize: '0', display: 'inline-block', width: '0', overflow: 'hidden' },
      '.cm-wysiwyg-h1': { fontSize: '1.9em', fontWeight: '700' }, '.cm-wysiwyg-h2': { fontSize: '1.55em', fontWeight: '700' },
      '.cm-wysiwyg-h3': { fontSize: '1.3em', fontWeight: '700' }, '.cm-wysiwyg-h4': { fontSize: '1.15em', fontWeight: '700' },
      '.cm-wysiwyg-h5': { fontSize: '1.05em', fontWeight: '700' }, '.cm-wysiwyg-h6': { fontSize: '1em', fontWeight: '700' },
      '.cm-wysiwyg-strong': { fontWeight: '700' }, '.cm-wysiwyg-emphasis': { fontStyle: 'italic' },
      '.cm-wysiwyg-code': { fontFamily: 'Consolas, monospace', color: props.dark ? '#f5bd8d' : '#8a5533' },
      '.cm-wysiwyg-link': { color: props.dark ? '#8ed2c1' : '#80623f', textDecoration: 'underline' },
      '.cm-wysiwyg-block-code': { fontFamily: 'Consolas, monospace', backgroundColor: props.dark ? '#ffffff0b' : '#00000006' },
      '.cm-cursor': { borderLeftColor: '#a5815b' }, '.cm-selectionBackground': { backgroundColor: '#bda27a40 !important' },
      '.cm-scroller': { overflow: 'auto' }, '.cm-search': { fontFamily: 'Segoe UI, sans-serif', fontSize: '13px' },
    }, { dark: props.dark })), wrapping.current.reconfigure(props.settings.wrap ? EditorView.lineWrapping : [])] });
  }, [props.settings, props.dark, props.path]);
  return <div className="editor-pane" ref={element} />;
});
