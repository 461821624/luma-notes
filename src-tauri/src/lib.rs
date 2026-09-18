pub mod files;
#[cfg(windows)]
mod pdf;
mod upload;
use files::{field, Result, Store};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct AppState(Arc<Mutex<Store>>);
struct PendingExternal(Mutex<Vec<String>>);
fn ioerr(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn import_tree(source: &Path, dest: &Path) -> Result<()> {
    for item in fs::read_dir(source).map_err(ioerr)? {
        let item = item.map_err(ioerr)?;
        let meta = fs::symlink_metadata(item.path()).map_err(ioerr)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        if meta.file_type().is_symlink() {
            continue;
        }
        let target = dest.join(item.file_name());
        if target.exists() {
            return Err(format!("目标已存在：{}", target.display()));
        }
        if meta.is_dir() {
            fs::create_dir(&target).map_err(ioerr)?;
            import_tree(&item.path(), &target)?;
        } else {
            let mut out = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(ioerr)?;
            let mut input = fs::File::open(item.path()).map_err(ioerr)?;
            std::io::copy(&mut input, &mut out).map_err(ioerr)?;
        }
    }
    Ok(())
}
fn native(store: &mut Store, action: &str, p: Value) -> Result<Value> {
    match action {
        "attachment_upload" => upload::picgo(store, &p),
        "read_attachment" => {
            let note = field(&p, "path")?;
            files::scoped(store.root()?, note, true)?;
            let src = percent_encoding::percent_decode_str(field(&p, "src")?)
                .decode_utf8()
                .map_err(ioerr)?;
            if src.contains([':', '\\']) || src.starts_with('/') {
                return Err("附件必须使用工作区相对链接".into());
            }
            let joined = Path::new(note)
                .parent()
                .unwrap_or(Path::new(""))
                .join(src.as_ref());
            let mut normalized = std::path::PathBuf::new();
            for component in joined.components() {
                match component {
                    std::path::Component::Normal(part) => normalized.push(part),
                    std::path::Component::CurDir => {}
                    std::path::Component::ParentDir => {
                        if !normalized.pop() {
                            return Err("附件链接越过工作区".into());
                        }
                    }
                    _ => return Err("无效附件链接".into()),
                }
            }
            let relative = normalized.to_string_lossy().replace('\\', "/");
            let result = store.dispatch("attachment_read", json!({"path":relative}))?;
            Ok(result["dataUrl"].clone())
        }
        "open_url" => {
            let url = url::Url::parse(field(&p, "url")?).map_err(ioerr)?;
            if !["https", "http", "mailto"].contains(&url.scheme()) {
                return Err("不允许此链接协议".into());
            }
            open::that(url.as_str()).map_err(ioerr)?;
            Ok(json!(true))
        }
        "choose_workspace" => match rfd::FileDialog::new()
            .set_title("选择 Markdown 工作区")
            .pick_folder()
        {
            Some(path) => store.choose(path),
            None => Ok(Value::Null),
        },
        "return_workspace" => {
            let previous = store.prefs["previousWorkspace"]
                .as_str()
                .ok_or("没有先前的工作区")?
                .to_string();
            store.choose(previous.into())
        }
        "open_file" => match rfd::FileDialog::new()
            .add_filter("Markdown", &["md", "markdown"])
            .pick_file()
        {
            Some(path) => {
                let path = path.canonicalize().map_err(ioerr)?;
                if let Some(root) = store.root.as_ref() {
                    store.prefs["previousWorkspace"] = json!(root.to_string_lossy());
                }
                store.choose(path.parent().ok_or("无效路径")?.to_path_buf())?;
                let name = path.file_name().unwrap().to_string_lossy();
                Ok(
                    json!({"workspace":files::workspace(store.root()?)?,"note":files::note(store.root()?,&name)?}),
                )
            }
            None => Ok(Value::Null),
        },
        "import_files" => {
            let Some(paths) = rfd::FileDialog::new()
                .add_filter("Markdown", &["md", "markdown"])
                .pick_files()
            else {
                return Ok(Value::Null);
            };
            let folder = p["folder"].as_str().unwrap_or("");
            for path in paths {
                let name = path.file_name().unwrap().to_string_lossy();
                let relative = if folder.is_empty() {
                    name.to_string()
                } else {
                    format!("{folder}/{name}")
                };
                store.dispatch(
                    "create_note",
                    json!({"path":relative,"content":fs::read_to_string(&path).map_err(ioerr)?}),
                )?;
            }
            files::workspace(store.root()?)
        }
        "import_folder" => {
            let Some(source) = rfd::FileDialog::new().pick_folder() else {
                return Ok(Value::Null);
            };
            let source = source.canonicalize().map_err(ioerr)?;
            let name = source
                .file_name()
                .ok_or("不能导入磁盘根目录")?
                .to_string_lossy();
            let dest = files::scoped(store.root()?, &name, false)?;
            if dest.exists() {
                return Err("同名目录已存在".into());
            }
            if dest.starts_with(&source) {
                return Err("不能导入工作区的父目录".into());
            }
            let staging = tempfile::Builder::new()
                .prefix(".miaoyan-import-")
                .tempdir_in(store.root()?)
                .map_err(ioerr)?;
            import_tree(&source, staging.path())?;
            fs::rename(staging.path(), &dest).map_err(ioerr)?;
            files::workspace(store.root()?)
        }
        "export_file" => {
            let name = field(&p, "name")?;
            let Some(path) = rfd::FileDialog::new().set_file_name(name).save_file() else {
                return Ok(Value::Null);
            };
            let bytes = if let Some(content) = p["content"].as_str() {
                content.as_bytes().to_vec()
            } else {
                p["bytes"]
                    .as_array()
                    .ok_or("缺少导出内容")?
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .filter(|n| *n <= 255)
                            .map(|n| n as u8)
                            .ok_or("无效字节".to_string())
                    })
                    .collect::<Result<Vec<_>>>()?
            };
            files::atomic(&path, &bytes)?;
            Ok(json!({"path":path.to_string_lossy()}))
        }
        "reveal" | "terminal" => {
            let path = if let Some(relative) = p["path"].as_str() {
                files::scoped(store.root()?, relative, true)?
            } else {
                store.root()?.to_path_buf()
            };
            let mut command = if action == "reveal" {
                let mut cmd = std::process::Command::new("explorer.exe");
                if path.is_file() {
                    cmd.arg(format!("/select,{}", path.display()));
                } else {
                    cmd.arg(&path);
                }
                cmd
            } else {
                let mut cmd = std::process::Command::new("powershell.exe");
                cmd.current_dir(if path.is_dir() {
                    path.as_path()
                } else {
                    path.parent().unwrap()
                });
                cmd
            };
            command.spawn().map_err(ioerr)?;
            Ok(json!(true))
        }
        _ => store.dispatch(action, p),
    }
}
#[tauri::command]
async fn request(
    action: String,
    payload: Value,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value> {
    if window.label() != "main" {
        return Err("此窗口不能调用文件和系统操作".into());
    }
    #[cfg(windows)]
    if action == "export_pdf" {
        return tauri::async_runtime::spawn_blocking(move || pdf::export(app, payload))
            .await
            .map_err(ioerr)?;
    }
    let state = state.0.clone();
    if action == "configure_shortcut" {
        let shortcut = field(&payload, "shortcut")?.trim().to_string();
        if !shortcut.is_empty() {
            shortcut
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .map_err(ioerr)?;
        }
        let mut store = state.lock().map_err(|_| "文件操作锁异常")?;
        let old = store.prefs["globalShortcut"]
            .as_str()
            .unwrap_or("Ctrl+Alt+M")
            .to_string();
        if old != shortcut {
            if !shortcut.is_empty() {
                app.global_shortcut()
                    .register(shortcut.as_str())
                    .map_err(ioerr)?;
            }
            if !old.is_empty() {
                if let Err(e) = app.global_shortcut().unregister(old.as_str()) {
                    if !shortcut.is_empty() {
                        let _ = app.global_shortcut().unregister(shortcut.as_str());
                    }
                    return Err(ioerr(e));
                }
            }
            if let Err(e) = store.dispatch("prefs", json!({"globalShortcut":shortcut})) {
                if !shortcut.is_empty() {
                    let _ = app.global_shortcut().unregister(shortcut.as_str());
                }
                if !old.is_empty() {
                    let _ = app.global_shortcut().register(old.as_str());
                }
                return Err(e);
            }
        }
        return Ok(json!({"shortcut":shortcut}));
    }
    if action == "pending_external" {
        let pending = app
            .state::<PendingExternal>()
            .0
            .lock()
            .map_err(|_| "外部参数锁异常")?
            .drain(..)
            .collect::<Vec<_>>();
        return tauri::async_runtime::spawn_blocking(move||{let mut store=state.lock().map_err(|_|"文件操作锁异常")?;
            for value in pending.iter().skip(1){let path=if value.starts_with("miaoyan:"){let url=url::Url::parse(value).map_err(ioerr)?;if url.host_str()!=Some("open"){continue;}let Some((_,path))=url.query_pairs().find(|(k,_)|k=="path")else{continue};std::path::PathBuf::from(path.as_ref())}else{std::path::PathBuf::from(value)};
                if !path.is_file()||!path.extension().is_some_and(|e|e.eq_ignore_ascii_case("md")||e.eq_ignore_ascii_case("markdown")){continue;}
                let path=path.canonicalize().map_err(ioerr)?;if let Some(root)=store.root.as_ref(){store.prefs["previousWorkspace"]=json!(root.to_string_lossy());}
                store.choose(path.parent().ok_or("无效外部路径")?.to_path_buf())?;
                return Ok(json!({"workspace":files::workspace(store.root()?)?,"note":files::note(store.root()?,&path.file_name().unwrap().to_string_lossy())?}));
            } Ok(Value::Null)
        }).await.map_err(ioerr)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = state.lock().map_err(|_| "文件操作锁异常")?;
        let _file_lock = store.lock()?;
        native(&mut store, &action, payload)
    })
    .await
    .map_err(ioerr)?
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Ok(mut pending) = app.state::<PendingExternal>().0.lock() {
                pending.extend(args.clone());
            }
            let _ = app.emit("external-open", args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let store = Store::new(data).map_err(std::io::Error::other)?;
            let shortcut = store.prefs["globalShortcut"]
                .as_str()
                .unwrap_or("Ctrl+Alt+M")
                .to_string();
            if let Some(window) = app.get_webview_window("main") {
                window.set_always_on_top(store.prefs["alwaysOnTop"].as_bool().unwrap_or(false))?;
            }
            app.manage(AppState(Arc::new(Mutex::new(store))));
            app.manage(PendingExternal(Mutex::new(std::env::args().collect())));
            if !shortcut.is_empty() {
                if let Err(e) = app.global_shortcut().register(shortcut.as_str()) {
                    eprintln!("全局快捷键注册失败：{e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![request])
        .run(tauri::generate_context!())
        .expect("无法启动妙言 Windows");
}
