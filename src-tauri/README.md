# Windows 原生后端

主窗口通过 `invoke('request', { action, payload })` 调用；其他窗口不能调用这个命令。阻塞文件、对话框及网络操作在后台线程执行。文件操作在进程内串行，同时通过应用数据目录的文件锁协调桌面和 CLI。

## 已实现接口

| action | payload / 返回 |
| --- | --- |
| bootstrap | `{}` → `{prefs, workspace}` |
| choose_workspace / list / return_workspace | `{}` → `{root,folders,notes}`；选择取消返回 null |
| open_file / pending_external | `{}` → `{workspace,note}` 或 null；后者只消费操作系统传入的参数 |
| read | `{path}` → note |
| save | `{path,content,revision}` → note |
| create_note / create_folder | `{path,content?}` |
| rename / move / duplicate | `{path,newPath}`；复制支持笔记文件 |
| trash / trash_list | `{path}` / `{}` → 回收项 / 数组 |
| trash_restore / trash_delete | `{id}`；最终删除进入 Windows 系统回收站 |
| history / history_restore | `{path}` / `{path,id,revision}` |
| prefs | 偏好对象，浅合并；工作区授权字段不能由此修改 |
| configure_shortcut | `{shortcut}`；空字符串关闭全局快捷键 |
| attachment_save | `{notePath,name,base64,image}` → `{path,link}` |
| read_attachment | `{path:笔记路径,src:相对链接}` → data URL |
| attachment_read | `{path:附件路径}` → `{dataUrl}` |
| attachment_upload | `{path,endpoint}` → `{url,path}`；仅显式操作调用本机 PicGo HTTP 服务 |
| orphan_candidates | `{}` → 相对路径数组；用户确认后逐项 trash |
| import_files / import_folder | `{folder?}` / `{}` → 工作区或 null |
| export_file | `{name,content}` 或 `{name,bytes}` → `{path}` 或 null |
| export_pdf | `{name,html,landscape?}` → `{path}` 或 null |
| reveal / terminal / open_url | `{path?}` / `{path?}` / `{url}` |
| update_check | `{}` → `{configured:false,version,message}` |

note：`{path,name,content,revision,modified,created}`，时间为 Unix 毫秒。工作区列表包含正文，供全文检索和反向链接；所有路径都是用户选定工作区内的相对路径。

## 数据保护

- 校验 Windows 名称、目录穿越、符号链接和 junction，目录扫描不跟随 reparse point。
- 保存采用同目录临时文件、刷盘和原子替换；保存前核对 SHA-256 revision。外部修改冲突时保留磁盘内容，并备份本地编辑；已删除目标拒绝重新创建。
- 历史在约五分钟变更间隔，以及恢复/冲突前保存；重命名和移动会复制相关历史。
- 应用回收区位于工作区 `.miaoyan-trash`，同卷移动，普通列表和搜索排除；恢复不覆盖同名目标。
- 目录导入先写临时目录，全部成功后移入；不跟随导入目录中的链接。
- PicGo 只允许 HTTP loopback 地址，禁用代理和重定向；上传失败保留本地文件。实际远程图床由用户本机 PicGo 配置。

## Windows 能力

Tauri 配置包含 Markdown 文件关联和 `miaoyan://open?path=...` 协议；单实例发送 `external-open` 事件，前端完成保存后再调用 `pending_external`。窗口大小和位置由 window-state 插件持久化，默认全局唤起 Ctrl+Alt+M，可配置或禁用。

PDF 使用隐藏、无原生命令权限的 WebView2 窗口及 `ICoreWebView2_7::PrintToPdf`，等待原生完成回调并验证 `%PDF-`，再原子写入用户选定目标。前端须传入渲染完成且资源可访问的 HTML。单元测试不代表中文排版、长文、图表与字体的桌面导出验收。

`miaoyan-cli.exe [--workspace 目录] list|search|cat|new|update|open` 与桌面共享文件实现。`update 路径 内容 --revision SHA256` 强制显式版本以避免覆盖；`open` 启动同目录桌面 EXE。

在线更新没有配置专属发布源与签名密钥，明确返回未配置；安装包没有代码签名证书时不能宣称签名。图床服务、系统回收站、文件关联、协议、全局快捷键、窗口恢复和 PDF 的真实桌面验收须单列记录。

## 验证

在项目本地 Rust 环境执行 `cargo test --manifest-path src-tauri/Cargo.toml`。定向测试覆盖目录穿越、Windows 保留名称、真实 Windows 符号链接越界、原子覆盖、外部编辑冲突、删除后拒绝保存、重命名保存生命周期、仅大小写重命名、回收恢复及本机 PicGo 请求。

项目根目录的 `scripts/tauri.ps1 dev` / `build` 会设置 `work/toolchain` 中的 Rust 环境。
