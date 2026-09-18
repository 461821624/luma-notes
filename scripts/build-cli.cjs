const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const windows = process.platform === 'win32';
const extension = windows ? '.exe' : '';
const target = process.env.TAURI_ENV_TARGET_TRIPLE || (windows ? 'x86_64-pc-windows-msvc' : `${process.arch}-unknown-linux-gnu`);
const destination = path.join(root, 'src-tauri', 'binaries', `luma-cli-${target}${extension}`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
if (!fs.existsSync(destination)) fs.writeFileSync(destination, '');
const result = spawnSync('cargo', ['build', '--release', '--bin', 'luma-cli', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml')], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);

const binary = path.join(root, 'src-tauri', 'target', 'release', `luma-cli${extension}`);
if (!fs.existsSync(binary)) throw new Error(`CLI 构建产物不存在：${binary}`);
fs.copyFileSync(binary, destination);
console.log(`CLI sidecar ready: ${path.relative(root, destination)}`);
