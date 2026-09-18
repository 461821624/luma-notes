use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数 {k}"))
}

fn resolve_attachment(note_path: &str, source: &str) -> Result<String> {
    let decoded = percent_encoding::percent_decode_str(source.trim())
        .decode_utf8()
        .map_err(err)?;
    let source = decoded
        .split(['#', '?'])
        .next()
        .unwrap_or("")
        .trim_matches(['<', '>']);
    if source.is_empty() || source.starts_with("#") || source.contains(':') {
        return Err("不是本地附件链接".into());
    }
    let joined = Path::new(note_path)
        .parent()
        .unwrap_or(Path::new("."))
        .join(source);
    let mut relative = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !relative.pop() {
                    return Err("附件链接越过工作区".into());
                }
            }
            _ => return Err("无效附件链接".into()),
        }
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("无效路径")?).map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(err)?;
    Ok(())
}
pub fn validate(relative: &str) -> Result<()> {
    if relative.is_empty() || relative.contains('\\') || relative.contains(':') {
        return Err("无效相对路径".into());
    }
    for c in Path::new(relative).components() {
        let Component::Normal(s) = c else {
            return Err("路径不能越过工作区".into());
        };
        let s = s.to_str().ok_or("无效文件名")?;
        let stem = s.split('.').next().unwrap_or("").to_uppercase();
        if s.ends_with([' ', '.'])
            || s.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
            || [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ]
            .contains(&stem.as_str())
        {
            return Err("Windows 不允许此文件名".into());
        }
    }
    Ok(())
}
pub fn scoped(root: &Path, relative: &str, exists: bool) -> Result<PathBuf> {
    validate(relative)?;
    let root = root.canonicalize().map_err(err)?;
    let target = root.join(relative);
    let probe = if exists {
        target.as_path()
    } else {
        target.parent().ok_or("无效路径")?
    };
    if !probe.canonicalize().map_err(err)?.starts_with(&root) {
        return Err("路径位于工作区之外".into());
    }
    if target.exists() && !target.canonicalize().map_err(err)?.starts_with(&root) {
        return Err("链接指向工作区之外".into());
    }
    Ok(target)
}
fn stamp(t: std::io::Result<SystemTime>) -> u64 {
    t.ok()
        .and_then(|x| x.duration_since(UNIX_EPOCH).ok())
        .map(|x| x.as_millis() as u64)
        .unwrap_or(0)
}
pub fn note(root: &Path, relative: &str) -> Result<Value> {
    let path = scoped(root, relative, true)?;
    let bytes = fs::read(&path).map_err(err)?;
    let meta = fs::metadata(&path).map_err(err)?;
    Ok(
        json!({"path":relative,"name":path.file_stem().unwrap_or_default().to_string_lossy(),"content":String::from_utf8(bytes.clone()).map_err(err)?,"revision":hash(&bytes),"modified":stamp(meta.modified()),"created":stamp(meta.created())}),
    )
}
pub fn workspace(root: &Path) -> Result<Value> {
    let root = root.canonicalize().map_err(err)?;
    let mut folders = Vec::new();
    let mut notes = Vec::new();
    fn walk(
        root: &Path,
        dir: &Path,
        folders: &mut Vec<String>,
        notes: &mut Vec<Value>,
    ) -> Result<()> {
        for item in fs::read_dir(dir).map_err(err)? {
            let item = item.map_err(err)?;
            let path = item.path();
            // Do not traverse reparse points/junctions, even if their destination is inside the workspace.
            let meta = fs::symlink_metadata(&path).map_err(err)?;
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
            let relative = path
                .strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            if item.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if meta.is_dir() {
                folders.push(relative);
                walk(root, &path, folders, notes)?;
            } else if path
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .is_some_and(|x| x == "md" || x == "markdown")
            {
                notes.push(note(root, &relative)?);
            }
        }
        Ok(())
    }
    walk(&root, &root, &mut folders, &mut notes)?;
    folders.sort();
    notes.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({"root":root.to_string_lossy(),"folders":folders,"notes":notes}))
}
pub struct Store {
    pub data: PathBuf,
    pub root: Option<PathBuf>,
    pub prefs: Value,
    pub single_file: Option<String>,
    created_assets: std::collections::HashSet<String>,
}
impl Store {
    pub fn new(data: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data).map_err(err)?;
        let prefs = match fs::read(data.join("preferences.json")) {
            Ok(b) => serde_json::from_slice(&b).map_err(err)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(err(e)),
        };
        let mut root = prefs
            .get("workspaceRoot")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|x| x.is_dir());
        let single_path = prefs
            .get("singleFile")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .and_then(|p| p.canonicalize().ok());
        let single_file = single_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|p| p.to_string_lossy().to_string());
        if let Some(path) = single_path {
            root = path.parent().map(Path::to_path_buf);
        }
        Ok(Self {
            data,
            root,
            prefs,
            single_file,
            created_assets: Default::default(),
        })
    }
    pub fn root(&self) -> Result<&Path> {
        self.root.as_deref().ok_or_else(|| "请先选择工作区".into())
    }
    pub fn require_workspace(&self) -> Result<()> {
        if self.single_file.is_some() {
            Err("单文件模式不能操作其他文件；请先选择工作区".into())
        } else {
            Ok(())
        }
    }
    pub fn authorize_note(&self, path: &str) -> Result<()> {
        if let Some(single) = &self.single_file {
            if path != single {
                return Err("单文件模式只允许编辑明确打开的文件".into());
            }
        }
        Ok(())
    }
    pub fn listing(&self) -> Result<Value> {
        if let Some(single) = &self.single_file {
            let notes = if self.root()?.join(single).is_file() {
                vec![note(self.root()?, single)?]
            } else {
                vec![]
            };
            Ok(
                json!({"root":self.root()?.to_string_lossy(),"folders":[],"notes":notes,"singleFile":single}),
            )
        } else {
            workspace(self.root()?)
        }
    }
    pub fn open_single(&mut self, path: PathBuf) -> Result<Value> {
        let path = path.canonicalize().map_err(err)?;
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        {
            return Err("只能打开 Markdown 文件".into());
        }
        let root = path.parent().ok_or("无效文件路径")?.to_path_buf();
        let relative = path
            .file_name()
            .ok_or("无效文件名")?
            .to_string_lossy()
            .to_string();
        let selected = note(&root, &relative)?;
        let mut prefs = self.prefs.clone();
        if self.single_file.is_none() {
            if let Some(previous) = self.root.as_ref() {
                prefs["previousWorkspace"] = json!(previous.to_string_lossy());
            }
        }
        prefs["singleFile"] = json!(path.to_string_lossy());
        atomic(
            &self.data.join("preferences.json"),
            &serde_json::to_vec_pretty(&prefs).map_err(err)?,
        )?;
        self.prefs = prefs;
        self.root = Some(root);
        self.single_file = Some(relative);
        self.created_assets.clear();
        Ok(json!({"workspace":self.listing()?,"note":selected}))
    }
    pub fn attachment_relative(&self, note_path: &str, src: &str) -> Result<String> {
        self.authorize_note(note_path)?;
        scoped(self.root()?, note_path, true)?;
        let relative = resolve_attachment(note_path, src)?;
        self.authorize_asset(&relative)?;
        scoped(self.root()?, &relative, true)?;
        Ok(relative)
    }
    pub fn authorize_asset(&self, relative: &str) -> Result<()> {
        let Some(single) = &self.single_file else {
            return Ok(());
        };
        if self.created_assets.contains(relative) {
            return Ok(());
        }
        let content = fs::read_to_string(scoped(self.root()?, single, true)?).map_err(err)?;
        let links=regex::Regex::new(r#"\]\(\s*(?:<([^>]+)>|([^\s)]+))|(?:src|href)\s*=\s*["']([^"']+)["']|(?m)^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))"#).map_err(err)?;
        for capture in links.captures_iter(&content) {
            for index in 1..=5 {
                if let Some(link) = capture.get(index) {
                    if resolve_attachment(single, link.as_str()).ok().as_deref() == Some(relative) {
                        return Ok(());
                    }
                }
            }
        }
        Err("单文件模式只允许读取当前笔记引用的附件".into())
    }
    pub fn lock(&self) -> Result<fs::File> {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.data.join("operations.lock"))
            .map_err(err)?;
        lock.lock().map_err(err)?;
        Ok(lock)
    }
    fn trash_dir(&self) -> Result<PathBuf> {
        let dir = scoped(self.root()?, ".luma-trash", false)?;
        fs::create_dir_all(&dir).map_err(err)?;
        Ok(dir)
    }
    pub fn choose(&mut self, path: PathBuf) -> Result<Value> {
        let root = path.canonicalize().map_err(err)?;
        let result = workspace(&root)?;
        let probe = tempfile::NamedTempFile::new_in(&root).map_err(err)?;
        drop(probe);
        self.prefs["workspaceRoot"] = json!(root.to_string_lossy());
        self.prefs["singleFile"] = Value::Null;
        atomic(
            &self.data.join("preferences.json"),
            &serde_json::to_vec_pretty(&self.prefs).map_err(err)?,
        )?;
        self.root = Some(root);
        self.single_file = None;
        self.created_assets.clear();
        Ok(result)
    }
    fn history_dir(&self, path: &str) -> Result<PathBuf> {
        Ok(self.data.join("history").join(hash(
            format!("{}|{}", self.root()?.display(), path).as_bytes(),
        )))
    }
    fn copy_history(&self, old: &str, new: &str) -> Result<()> {
        let source = self.history_dir(old)?;
        if !source.exists() {
            return Ok(());
        }
        let target = self.history_dir(new)?;
        fs::create_dir_all(&target).map_err(err)?;
        for entry in fs::read_dir(source).map_err(err)? {
            let entry = entry.map_err(err)?;
            let mut destination = target.join(entry.file_name());
            if destination.exists() {
                if fs::read(&destination).map_err(err)? == fs::read(entry.path()).map_err(err)? {
                    continue;
                }
                let mut id = now();
                while target.join(format!("{id}.md")).exists() {
                    id += 1;
                }
                destination = target.join(format!("{id}.md"));
            }
            atomic(&destination, &fs::read(entry.path()).map_err(err)?)?;
        }
        Ok(())
    }
    pub fn snapshot(&self, path: &str, force: bool) -> Result<()> {
        let folder = self.history_dir(path)?;
        fs::create_dir_all(&folder).map_err(err)?;
        let latest = fs::read_dir(&folder)
            .map_err(err)?
            .filter_map(|x| x.ok())
            .filter_map(|x| {
                x.file_name()
                    .to_string_lossy()
                    .trim_end_matches(".md")
                    .parse::<u64>()
                    .ok()
            })
            .max()
            .unwrap_or(0);
        if force || now().saturating_sub(latest) >= 300_000 {
            let source = scoped(self.root()?, path, true)?;
            let id = now().max(latest + 1);
            atomic(
                &folder.join(format!("{id}.md")),
                &fs::read(source).map_err(err)?,
            )?;
        }
        Ok(())
    }
    pub fn save(&self, path: &str, content: &str, revision: &str) -> Result<Value> {
        self.authorize_note(path)?;
        let target = scoped(self.root()?, path, true)?;
        let current = fs::read(&target).map_err(err)?;
        if hash(&current) != revision {
            self.snapshot(path, true)?;
            let backups = self.data.join("conflicts");
            fs::create_dir_all(&backups).map_err(err)?;
            let backup = backups.join(format!("{}-{}.md", now(), hash(path.as_bytes())));
            atomic(&backup, content.as_bytes())?;
            return Err(format!(
                "外部修改冲突：磁盘内容未覆盖；你的编辑已备份到 {}",
                backup.display()
            ));
        }
        if current != content.as_bytes() {
            self.snapshot(path, false)?;
            atomic(&target, content.as_bytes())?;
        }
        note(self.root()?, path)
    }
    pub fn dispatch(&mut self, action: &str, p: Value) -> Result<Value> {
        if self.single_file.is_some() {
            match action {
                "read" | "save" | "history" | "history_restore" | "trash" => {
                    self.authorize_note(field(&p, "path")?)?
                }
                "attachment_save" => self.authorize_note(field(&p, "notePath")?)?,
                "attachment_read" => self.authorize_asset(field(&p, "path")?)?,
                "bootstrap" | "list" | "prefs" | "update_check" => {}
                _ => self.require_workspace()?,
            }
        }
        match action {
            "bootstrap" => Ok(
                json!({"prefs":self.prefs,"workspace":if self.root.is_some(){Some(self.listing()?)}else{None}}),
            ),
            "list" => self.listing(),
            "read" => note(self.root()?, field(&p, "path")?),
            "save" => self.save(
                field(&p, "path")?,
                field(&p, "content")?,
                field(&p, "revision")?,
            ),
            "prefs" => {
                let obj = p.as_object().ok_or("偏好必须为对象")?;
                for (k, v) in obj {
                    if k != "workspaceRoot" && k != "previousWorkspace" && k != "singleFile" {
                        self.prefs[k] = v.clone();
                    }
                }
                atomic(
                    &self.data.join("preferences.json"),
                    &serde_json::to_vec_pretty(&self.prefs).map_err(err)?,
                )?;
                Ok(self.prefs.clone())
            }
            "create_note" | "create_folder" => {
                let relative = field(&p, "path")?;
                let path = scoped(self.root()?, relative, false)?;
                if action == "create_folder" {
                    fs::create_dir(path).map_err(err)?;
                    Ok(json!({"path":relative}))
                } else {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(path)
                        .map_err(err)?;
                    file.write_all(p["content"].as_str().unwrap_or("").as_bytes())
                        .map_err(err)?;
                    file.sync_all().map_err(err)?;
                    note(self.root()?, relative)
                }
            }
            "rename" | "move" | "duplicate" => {
                let old = field(&p, "path")?;
                let new = field(&p, "newPath")?;
                let source = scoped(self.root()?, old, true)?;
                let target = scoped(self.root()?, new, false)?;
                let case_only = action != "duplicate"
                    && old != new
                    && old.eq_ignore_ascii_case(new)
                    && target.exists()
                    && source.canonicalize().map_err(err)? == target.canonicalize().map_err(err)?;
                if target.exists() && !case_only {
                    return Err("目标名称已存在".into());
                }
                if action != "duplicate" {
                    if source.is_file() {
                        self.copy_history(old, new)?;
                    } else {
                        let entries = workspace(self.root()?)?;
                        for item in entries["notes"].as_array().unwrap() {
                            let path = item["path"].as_str().unwrap();
                            if let Some(suffix) = path.strip_prefix(&format!("{old}/")) {
                                self.copy_history(path, &format!("{new}/{suffix}"))?;
                            }
                        }
                    }
                }
                if action == "duplicate" {
                    if !source.is_file() {
                        return Err("仅支持复制文件".into());
                    }
                    let mut f = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&target)
                        .map_err(err)?;
                    f.write_all(&fs::read(source).map_err(err)?).map_err(err)?;
                    f.sync_all().map_err(err)?;
                } else {
                    if case_only {
                        let temporary = source.with_file_name(format!(".luma-rename-{}", now()));
                        fs::rename(&source, &temporary).map_err(err)?;
                        if let Err(e) = fs::rename(&temporary, &target) {
                            let rollback = fs::rename(&temporary, &source);
                            return Err(format!("重命名失败：{e}；回滚：{rollback:?}"));
                        }
                    } else {
                        fs::rename(source, &target).map_err(err)?;
                    }
                }
                if target.is_file() {
                    note(self.root()?, new)
                } else {
                    Ok(json!({"path":new}))
                }
            }
            "trash" => {
                let relative = field(&p, "path")?;
                let source = scoped(self.root()?, relative, true)?;
                if relative.split('/').any(|part| part == ".luma-trash") {
                    return Err("不能回收应用回收目录".into());
                }
                let folder = self.trash_dir()?;
                let id = format!("{}-{}", now(), &hash(relative.as_bytes())[..12]);
                let dest = folder.join(&id);
                let meta = json!({"id":id,"path":relative,"root":self.root()?.to_string_lossy(),"deleted":now()});
                atomic(
                    &folder.join(format!("{id}.json")),
                    &serde_json::to_vec(&meta).map_err(err)?,
                )?;
                if let Err(e) = fs::rename(source, &dest) {
                    let _ = fs::remove_file(folder.join(format!("{id}.json")));
                    return Err(err(e));
                }
                Ok(meta)
            }
            "trash_list" => {
                let folder = self.trash_dir()?;
                let mut items = vec![];
                for item in fs::read_dir(folder).map_err(err)? {
                    let path = item.map_err(err)?.path();
                    if path.extension().is_some_and(|x| x == "json") {
                        let v: Value =
                            serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
                        if v["root"].as_str() == Some(self.root()?.to_string_lossy().as_ref()) {
                            items.push(v);
                        }
                    }
                }
                Ok(json!(items))
            }
            "trash_restore" | "trash_delete" => {
                let id = field(&p, "id")?;
                if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                    return Err("无效回收项".into());
                }
                let folder = self.trash_dir()?;
                let meta_path = folder.join(format!("{id}.json"));
                let meta: Value =
                    serde_json::from_slice(&fs::read(&meta_path).map_err(err)?).map_err(err)?;
                if meta["root"].as_str() != Some(self.root()?.to_string_lossy().as_ref()) {
                    return Err("回收项不属于此工作区".into());
                }
                if action == "trash_restore" {
                    let dest = scoped(self.root()?, field(&meta, "path")?, false)?;
                    if dest.exists() {
                        return Err("原位置已存在同名文件".into());
                    }
                    fs::rename(folder.join(id), dest).map_err(err)?;
                } else {
                    trash::delete(folder.join(id)).map_err(err)?;
                }
                fs::remove_file(meta_path).map_err(err)?;
                Ok(meta)
            }
            "history" => {
                let dir = self.history_dir(field(&p, "path")?)?;
                if !dir.exists() {
                    return Ok(json!([]));
                }
                let mut rows = vec![];
                for x in fs::read_dir(dir).map_err(err)? {
                    let path = x.map_err(err)?.path();
                    let id = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    rows.push(json!({"id":id,"modified":id.parse::<u64>().unwrap_or(0),"content":fs::read_to_string(path).map_err(err)?}));
                }
                rows.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
                Ok(json!(rows))
            }
            "history_restore" => {
                let path = field(&p, "path")?;
                let id = field(&p, "id")?;
                if !id.chars().all(|c| c.is_ascii_digit()) || id.is_empty() {
                    return Err("无效版本".into());
                }
                let content = fs::read_to_string(self.history_dir(path)?.join(format!("{id}.md")))
                    .map_err(err)?;
                self.snapshot(path, true)?;
                self.save(path, &content, field(&p, "revision")?)
            }
            "attachment_save" => {
                let note_path = field(&p, "notePath")?;
                scoped(self.root()?, note_path, true)?;
                let name = field(&p, "name")?;
                validate(name)?;
                if name.contains('/') {
                    return Err("附件名称不能包含目录".into());
                }
                let parent = Path::new(note_path).parent().unwrap_or(Path::new(""));
                let dir = parent.join(if p["image"].as_bool().unwrap_or(false) {
                    "i"
                } else {
                    "files"
                });
                let dir_s = dir.to_string_lossy().replace('\\', "/");
                let target_dir = scoped(self.root()?, &dir_s, false)?;
                fs::create_dir_all(&target_dir).map_err(err)?;
                let relative = format!("{}/{}-{name}", dir_s, now());
                let target = scoped(self.root()?, &relative, false)?;
                let bytes = STANDARD.decode(field(&p, "base64")?).map_err(err)?;
                atomic(&target, &bytes)?;
                Ok(
                    json!({"path":relative,"link":format!("{}/{}",if p["image"].as_bool().unwrap_or(false){"i"}else{"files"},target.file_name().unwrap().to_string_lossy())}),
                )
            }
            "attachment_read" => {
                let path = scoped(self.root()?, field(&p, "path")?, true)?;
                let ext = path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                let mime = match ext.as_str() {
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    "svg" => "image/svg+xml",
                    "mp4" => "video/mp4",
                    "mp3" => "audio/mpeg",
                    _ => "application/octet-stream",
                };
                Ok(
                    json!({"dataUrl":format!("data:{mime};base64,{}",STANDARD.encode(fs::read(path).map_err(err)?))}),
                )
            }
            "orphan_candidates" => {
                let ws = workspace(self.root()?)?;
                let all = ws["notes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|n| n["content"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut items = vec![];
                for dir in ws["folders"].as_array().unwrap() {
                    let relative = dir.as_str().unwrap();
                    if !["i", "files"].contains(
                        &Path::new(relative)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .as_ref(),
                    ) {
                        continue;
                    }
                    for entry in fs::read_dir(scoped(self.root()?, relative, true)?).map_err(err)? {
                        let entry = entry.map_err(err)?;
                        let name = entry.file_name().to_string_lossy().to_string();
                        if entry.file_type().map_err(err)?.is_file() && !all.contains(&name) {
                            items.push(format!("{relative}/{name}"));
                        }
                    }
                }
                Ok(json!(items))
            }
            "update_check" => Ok(
                json!({"configured":false,"version":env!("CARGO_PKG_VERSION"),"message":"尚未配置此 Windows 移植版的发布源和更新签名密钥"}),
            ),
            _ => Err(format!("未知操作：{action}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_save_lifecycle() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut store = Store::new(data.path().to_path_buf()).unwrap();
        store.choose(root.path().to_path_buf()).unwrap();
        assert!(scoped(root.path(), "../outside.md", false).is_err());
        assert!(validate("CON.md").is_err());
        assert!(validate("x/../../bad").is_err());
        let n = store
            .dispatch("create_note", json!({"path":"中文.md","content":"one"}))
            .unwrap();
        let saved = store
            .save("中文.md", "two", n["revision"].as_str().unwrap())
            .unwrap();
        assert_eq!(saved["content"], "two");
        fs::write(root.path().join("中文.md"), "external").unwrap();
        assert!(store
            .save("中文.md", "local", saved["revision"].as_str().unwrap())
            .is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("中文.md")).unwrap(),
            "external"
        );
        store
            .dispatch("rename", json!({"path":"中文.md","newPath":"renamed.md"}))
            .unwrap();
        assert!(store
            .save("中文.md", "stale", saved["revision"].as_str().unwrap())
            .is_err());
        assert!(!root.path().join("中文.md").exists());
        let n = note(root.path(), "renamed.md").unwrap();
        store
            .save("renamed.md", "new", n["revision"].as_str().unwrap())
            .unwrap();
        fs::remove_file(root.path().join("renamed.md")).unwrap();
        assert!(store.save("renamed.md", "stale", "wrong").is_err());
        assert!(!root.path().join("renamed.md").exists());
    }
    #[test]
    fn recycle_and_case_rename() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut store = Store::new(data.path().to_path_buf()).unwrap();
        store.choose(root.path().to_path_buf()).unwrap();
        store
            .dispatch("create_note", json!({"path":"Case.md","content":"keep"}))
            .unwrap();
        store
            .dispatch("rename", json!({"path":"Case.md","newPath":"case.md"}))
            .unwrap();
        let trashed = store.dispatch("trash", json!({"path":"case.md"})).unwrap();
        assert!(store.dispatch("list", json!({})).unwrap()["notes"]
            .as_array()
            .unwrap()
            .is_empty());
        store
            .dispatch("trash_restore", json!({"id":trashed["id"]}))
            .unwrap();
        assert_eq!(note(root.path(), "case.md").unwrap()["content"], "keep");
    }
    #[cfg(windows)]
    #[test]
    fn symlink_escape_rejected() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "outside").unwrap();
        std::os::windows::fs::symlink_dir(outside.path(), root.path().join("link")).unwrap();
        assert!(scoped(root.path(), "link/secret.md", true).is_err());
        assert!(scoped(root.path(), "link/new.md", false).is_err());
        assert!(workspace(root.path()).unwrap()["notes"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
