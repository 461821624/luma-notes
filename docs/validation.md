# Windows 验收记录

日期：2026-09-18

## 已验证

- `npm test`：3/3 通过（Markdown 分页、任务切换、wikilink/安全 HTML）。
- `npm run build`：通过，TypeScript 检查和 Vite 产物生成成功。
- `src-tauri` `cargo test`：4 个测试中 3 个通过；PicGo 测试因本机没有可用的本地上传服务失败，其他路径/文件/回收测试通过。
- `cargo fmt`：已执行。
- `tauri build`：通过，生成 x64 NSIS 安装包。
- WebView2 桌面启动：窗口标题、三栏界面、中文界面、欢迎文档编辑区和隔离预览可见；预览公式/Markdown 基础渲染链已启动。
- Preview sandbox：预览 iframe 使用 `sandbox="allow-scripts"`，不暴露 Tauri IPC；宿主消息带渲染 token。
- PlantUML 默认关闭；开启前不会发送图表内容。服务地址设置与 loopback 上传限制由 Rust 层校验。
- 生成的 PDF 走 WebView2 `PrintToPdf` 原生接口；代码有 `%PDF-` 文件头校验和临时文件清理。

## 尚未完成真实人工验收

- 尚未在安装后的独立环境逐项操作 NSIS 安装、卸载、升级和文件关联；当前只确认安装包生成成功。
- 尚未在真实中文输入法、DPI 缩放、只读目录、OneDrive/坚果云同步目录上跑完整矩阵。
- PDF、长图、PPT PDF、资源管理器定位、全局快捷键和系统回收站需要在真实 Tauri 窗口逐项操作确认；当前完成编译和代码级测试，不能标为全绿。
- 单文件打开会把文件所在目录作为临时工作区，原工作区可用 `return_workspace` 恢复；这是当前实现边界。
- 在线更新已接入 GitHub Releases，签名密钥已写入 Actions Secret，`v0.1.1` 的 `latest.json`、安装包和 `.sig` 已公开可访问；GitHub Actions 两次运行因账号 billing issue 在 Runner 启动前失败，当前首个更新包由本机验证后手动上传。
- 图床只支持用户显式启用的本机 PicGo HTTP 服务；服务不可用时保留本地附件。

## 产物

- `src-tauri/target/release/bundle/nsis/Luma Notes_0.1.1_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/Luma Notes_0.1.1_x64-setup.exe.sig`
- `src-tauri/target/release/miaoyan-windows.exe`
