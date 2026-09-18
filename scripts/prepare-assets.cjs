const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const katex = path.join(root, 'node_modules/katex/dist');
const target = path.join(root, 'public/preview');
let css = fs.readFileSync(path.join(katex, 'katex.min.css'), 'utf8');
css = css.replace(/url\(([^)]+)\)/g, (_, resource) => {
  const file = resource.replace(/["']/g, '');
  const extension = path.extname(file).slice(1);
  return `url(data:font/${extension};base64,${fs.readFileSync(path.join(katex, file)).toString('base64')})`;
});
fs.writeFileSync(path.join(target, 'css/katex.min.css'), css);
fs.copyFileSync(path.join(katex, 'katex.min.js'), path.join(target, 'js/katex.min.js'));
fs.copyFileSync(path.join(katex, 'contrib/auto-render.min.js'), path.join(target, 'js/auto-render.min.js'));
fs.copyFileSync(path.join(root, 'node_modules/katex/LICENSE'), path.join(target, 'KATEX-LICENSE.txt'));
console.log('KaTeX scripts and fully embedded fonts prepared.');
