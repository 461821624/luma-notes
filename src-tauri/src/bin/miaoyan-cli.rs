use miaoyan_lib::files::{self, Store};
use serde_json::json;
use std::path::PathBuf;

fn execute() -> Result<(), String> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA 未设置")?;
    let mut store = Store::new(PathBuf::from(appdata).join("app.miaoyan.windows.unofficial"))?;
    let _file_lock = store.lock()?;
    if args.first().map(String::as_str) == Some("--workspace") {
        if args.len() < 3 {
            return Err("--workspace 后需要目录和命令".into());
        }
        let root = PathBuf::from(args.remove(1))
            .canonicalize()
            .map_err(|e| e.to_string())?;
        args.remove(0);
        store.root = Some(root);
    }
    let Some(command) = args.first().map(String::as_str) else {
        return Err("用法: miaoyan-cli [--workspace 目录] list | search 关键词 | cat 路径 | new 路径 内容 | update 路径 内容 --revision SHA256 | open [路径]".into());
    };
    let arg = |i: usize| {
        args.get(i)
            .map(String::as_str)
            .ok_or_else(|| "参数不足".to_string())
    };
    match command {
        "list" => println!("{}", files::workspace(store.root()?)?),
        "search" => {
            let query = arg(1)?.to_lowercase();
            let workspace = files::workspace(store.root()?)?;
            let notes = workspace["notes"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|n| {
                    n["path"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
                        || n["content"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                })
                .collect::<Vec<_>>();
            println!("{}", json!(notes));
        }
        "cat" => print!(
            "{}",
            files::note(store.root()?, arg(1)?)?["content"]
                .as_str()
                .unwrap_or("")
        ),
        "new" => println!(
            "{}",
            store.dispatch("create_note", json!({"path":arg(1)?,"content":arg(2)?}))?
        ),
        "update" => {
            if arg(3)? != "--revision" {
                return Err("更新必须传入 --revision，防止覆盖外部修改".into());
            }
            println!("{}", store.save(arg(1)?, arg(2)?, arg(4)?)?);
        }
        "open" => {
            let mut exe = std::env::current_exe().map_err(|e| e.to_string())?;
            exe.set_file_name("miaoyan-windows.exe");
            let mut process = std::process::Command::new(exe);
            if let Some(path) = args.get(1) {
                process.arg(files::scoped(store.root()?, path, true)?);
            }
            process.spawn().map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("未知命令 {command}")),
    }
    Ok(())
}
fn main() {
    if let Err(e) = execute() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
