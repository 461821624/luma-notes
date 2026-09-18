import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';

export const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false })
  .use(footnote).use(taskLists, { enabled: true, label: true }).use(emoji);
markdown.core.ruler.after('github-task-lists', 'task-source-lines', state => {
  for (let i = 2; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type !== 'inline' || !token.map || !state.tokens[i - 2].attrGet('class')?.includes('task-list-item')) continue;
    const checkbox = token.children?.find(child => child.type === 'html_inline' && child.content.startsWith('<input class="task-list-item-checkbox"'));
    if (checkbox) checkbox.content = checkbox.content.replace('<input ', `<input data-task-line="${token.map[0]}" `);
  }
});

const originalOpen = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const line = tokens[idx].map?.[0] ?? idx;
  tokens[idx].attrSet('id', `heading-${line}`);
  tokens[idx].attrSet('data-source-line', String(line));
  return originalOpen ? originalOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};
for (const rule of ['paragraph_open', 'bullet_list_open', 'ordered_list_open', 'blockquote_open']) {
  markdown.renderer.rules[rule] = (tokens, idx, _options, _env, self) => {
    if (tokens[idx].map) tokens[idx].attrSet('data-source-line', String(tokens[idx].map![0]));
    return self.renderToken(tokens, idx, _options);
  };
}
markdown.inline.ruler.before('link', 'wikilink', (state, silent) => {
  if (state.src.slice(state.pos, state.pos + 2) !== '[[') return false;
  const end = state.src.indexOf(']]', state.pos + 2);
  if (end < 0) return false;
  const value = state.src.slice(state.pos + 2, end);
  if (!value || value.includes('\n')) return false;
  if (!silent) {
    const [target, label] = value.split('|');
    const token = state.push('link_open', 'a', 1);
    token.attrSet('href', `#wiki:${encodeURIComponent(target.trim())}`);
    const text = state.push('text', '', 0); text.content = label || target;
    state.push('link_close', 'a', -1);
  }
  state.pos = end + 2; return true;
});
// Keep TeX delimiters intact for KaTeX. Markdown escaping would otherwise consume them.
markdown.inline.ruler.before('escape', 'math', (state, silent) => {
  const rest = state.src.slice(state.pos);
  const match = /^(\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/.exec(rest);
  if (!match) return false;
  if (!silent) { const token = state.push('text', '', 0); token.content = match[0]; }
  state.pos += match[0].length; return true;
});

export function withoutFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, block => '\n'.repeat(block.split('\n').length - 1));
}
export function renderMarkdown(source: string): string { return markdown.render(withoutFrontmatter(source)); }
export function headings(source: string): { title: string; line: number; level: number }[] {
  const tokens = markdown.parse(withoutFrontmatter(source), {});
  return tokens.flatMap((token, i) => token.type === 'heading_open'
    ? [{ title: tokens[i + 1].content, line: token.map![0], level: Number(token.tag.slice(1)) }] : []);
}
export function wikiTargets(source: string): string[] {
  const tokens = markdown.parse(withoutFrontmatter(source), {});
  return tokens.flatMap(t => t.children || []).filter(t => t.type === 'link_open')
    .map(t => t.attrGet('href') || '').filter(href => href.startsWith('#wiki:'))
    .map(href => decodeURIComponent(href.slice(6)));
}
export function splitSlides(source: string): string[] {
  const tokens = markdown.parse(withoutFrontmatter(source), {});
  const lines = source.split('\n');
  const breaks = tokens.filter(t => t.type === 'hr' && t.level === 0).map(t => t.map![0]);
  const slides: string[] = []; let start = 0;
  for (const line of breaks) { slides.push(lines.slice(start, line).join('\n')); start = line + 1; }
  slides.push(lines.slice(start).join('\n'));
  return slides;
}
export function toggleTask(source: string, taskIndex: number): string {
  let index = 0;
  const tokens = markdown.parse(source, {});
  const lines = source.split('\n');
  const fenced = new Set<number>();
  for (const token of tokens) if (['fence', 'code_block'].includes(token.type) && token.map)
    for (let i = token.map[0]; i < token.map[1]; i++) fenced.add(i);
  return lines.map((line, i) => {
    if (fenced.has(i) || !/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s/.test(line)) return line;
    if (index++ !== taskIndex) return line;
    return line.replace(/\[([ xX])\]/, (_, value) => value === ' ' ? '[x]' : '[ ]');
  }).join('\n');
}
export function toggleTaskLine(source: string, line: number): string {
  const tokens = markdown.parse(withoutFrontmatter(source), {});
  const valid = tokens.some(token => token.children?.some(child => child.content.includes(`data-task-line="${line}"`)));
  if (!valid) return source;
  const lines = source.split('\n');
  lines[line] = lines[line].replace(/\[([ xX])\]/, (_, value) => value === ' ' ? '[x]' : '[ ]');
  return lines.join('\n');
}
export const snippets: Record<string, string> = {
  table: '| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |',
  img: '![图片说明](i/image.png)', video: '<video controls src="files/video.mp4"></video>',
  mermaid: '```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```',
  plantuml: '```plantuml\n@startuml\nAlice -> Bob: Hello\n@enduml\n```',
  markmap: '```markmap\n# 思维导图\n## 灵感\n## 行动\n```',
  fold: '<details>\n<summary>展开阅读</summary>\n\n内容\n\n</details>', task: '- [ ] 待办事项\n- [x] 已完成',
};
