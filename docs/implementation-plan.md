# MiaoYan Windows Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User has approved full design and E: workspace. No commits or branches without request.

**Goal:** Deliver the Windows Tauri + React port against Windows复刻设计.md, with honest per-feature validation.
**Architecture:** Rust owns scoped disk operations and OS integration. React/CodeMirror own editing; an isolated HTML preview owns rich rendering. Plain Markdown remains the source of truth.
**Tech Stack:** Tauri 2, Rust, React, TypeScript, Vite, CodeMirror 6, markdown-it, upstream preview assets.

## 1. Environment and application
- [ ] Inspect MSVC C++ component and WebView2, install a project-local Rust toolchain under work/toolchain if missing. Keep download and build caches on E:.
- [ ] Create package.json, tsconfig.json, vite.config.ts, index.html; src-tauri/Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, src/main.rs.
- [ ] Run npm install, npm run build, cargo check. Pin actual resolved dependencies in lockfiles.
- [ ] Before broad UI work, prototype WebView2 PDF and full-image export; acceptance is opening a generated multi-page PDF and a tall PNG with final paragraph present. Verify sandbox cannot invoke native commands and Windows replacement preserves old data on error.

## 2. Disk model (src-tauri/src/storage.rs)
- [ ] Implement canonical workspace boundaries and Windows filename validation. Add temp-directory Rust tests for traversal, names, create/rename/save/delete/restore.
- [ ] Commands: select workspace, list tree/notes, read, save with expected revision, create, duplicate, move, trash, restore, import, read/write attachment, history, preferences.
- [ ] Save uses document identity, serial mutation lock and atomic replacement; check disk content revision, preserve conflict copy, fail on missing target. In-app trash preserves paths, actual final removal uses system recycle bin.
- [ ] Flush before move/rename; deletion retires document identity and invalidates queued saves. Test these lifecycle races explicitly.
- [ ] Store metadata/history outside note content, persist settings atomically, avoid symlink traversal. Add disk change polling/watch event with generation checks.
- [ ] Run cargo test; manually test read-only and externally modified note.

## 3. Editor and workbench (src/App.tsx, src/Editor.tsx, src/styles.css, src/api.ts)
- [ ] Match three-column visual structure, adjustable panels, dark/light/system, Chinese UI and persistent preferences.
- [ ] Connect real disk commands. Serialized save queue bound to note path; flush before navigation and native close. Error state retains buffer.
- [ ] Implement CodeMirror Markdown, shortcuts, snippets, format, replace, drop/paste, font settings, word counts.
- [ ] Implement search/sort/pin, folders, single file, multi-select, context actions, history and settings dialogs.
- [ ] Test pure editor helpers with Node tests; verify npm run build.

## 4. Rich preview (src/markdown.ts, src/Preview.tsx, public/preview/)
- [ ] Copy licensed preview styles/libs, retain notices. Implement GFM, footnotes, math, Mermaid, Markmap, PlantUML, wikilinks/backlinks, frontmatter, safe HTML and task toggles.
- [ ] Sandbox preview without native bridge; whitelist postMessage with source and per-render token, sanitize HTML and URLs, scoped media resolution.
- [ ] Implement TOC and bidirectional scrolling, image zoom, preview search, source/preview/split/focus modes.
- [ ] PlantUML defaults disabled with zero outgoing requests until user opts in, with configurable endpoint and clear disclosure of graph content transmission.
- [ ] Implement Reveal PPT with fence-aware slide splitting and inline configuration.
- [ ] Run Markdown regression cases incl script injection, fenced separators, task positions and links.

## 5. Advanced workflows (src-tauri/src/system.rs, src/export.ts, src/settings.ts)
- [ ] Export HTML, PDF, PPT PDF and full images after asset readiness; validate actual files, not only dialog opening.
- [ ] Add PicGo local service upload with fallback; orphan cleanup previews candidates before trash.
- [ ] Register file/deep-link open, single instance, global shortcut, explorer/terminal actions, window state.
- [ ] Add CLI open/new/search/list/cat/update; update requires own configured endpoint and signature key, otherwise show unconfigured status.
- [ ] Add upstream languages and translated Windows labels; every visible action must be wired or explicitly marked unavailable with reason.

## 6. Validation and deliverables
- [ ] npm run build; cargo test/check; npm run tauri build. No unrequested git commits.
- [ ] Test real Tauri workflow for persistence, fast note switching, external conflict, delete-save race, Chinese IME, exports and installation.
- [ ] Record each design matrix item as passed/failed/unverified in docs/validation.md. Never label full parity until all accepted criteria pass.
- [ ] Deliver built installer plus setup instructions; report any externally blocked signing/update service or unavailable hardware verification explicitly.
