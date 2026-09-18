import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headings, renderMarkdown, splitSlides, toggleTask, wikiTargets } from '../src/markdown';

test('slides exclude fenced and frontmatter separators', () => {
  const md = '---\ntitle: demo\n---\n# First\n\n```md\n---\n```\n\n---\n\n# Second';
  assert.equal(splitSlides(md).length, 2);
  assert.equal(headings(md)[0].line, 3);
});
test('tasks ignore code fences and preserve other lines', () => {
  const md = '```md\n- [ ] example\n```\n- [ ] actual\n- [x] done';
  assert.equal(toggleTask(md, 0), '```md\n- [ ] example\n```\n- [x] actual\n- [x] done');
});
test('wiki targets ignore fenced content and labels render', () => {
  assert.deepEqual(wikiTargets('[[中文笔记|标签]]\n```\n[[ignore]]\n```'), ['中文笔记']);
  assert.match(renderMarkdown('[[note|label]]'), />label<\/a>/);
  assert.match(renderMarkdown('$x_1$'), /\$x_1\$/);
  assert.doesNotMatch(renderMarkdown('[bad](javascript:alert(1))'), /href="javascript:/);
});
