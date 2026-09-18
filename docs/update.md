# Luma Notes Windows 更新发布

项目使用 Tauri updater + GitHub Releases。

## 首次配置

1. 保留本机签名私钥 `C:\Users\Administrator\.tauri\luma-notes.key`，不要提交到仓库。
2. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 添加：
   - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整内容。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：本项目当前为空字符串。
3. 仓库需要允许 GitHub Actions 写入 Contents，工作流已经声明 `contents: write`。

## 发布版本

```powershell
git add .
git commit -m "chore: prepare luma notes updater"
git tag v0.1.0
git push origin main --tags
```

推送 `v*` 标签后，`.github/workflows/publish.yml` 会在 Windows runner 上构建 NSIS 安装包、生成 `.sig` 签名和 `latest.json`，并上传到 GitHub Release。

## 客户端更新

安装版在“偏好设置 → 关于 → 检查更新”调用 GitHub Releases 的 `latest.json`。发现新版本后会下载签名安装包，完成后自动重启。

版本升级时同时修改 `package.json` 和 `src-tauri/tauri.conf.json` 中的版本号，再创建新的 `vX.Y.Z` 标签。
