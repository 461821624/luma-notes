use crate::files::{self, Result};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub fn export(app: tauri::AppHandle, p: Value) -> Result<Value> {
    let Some(destination) = rfd::FileDialog::new()
        .add_filter("PDF", &["pdf"])
        .set_file_name(files::field(&p, "name")?)
        .save_file()
    else {
        return Ok(Value::Null);
    };
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let html = temp.path().join("document.html");
    fs::write(&html, files::field(&p, "html")?).map_err(|e| e.to_string())?;
    let pdf = temp.path().join("document.pdf");
    let print_path = pdf.clone();
    let landscape = p["landscape"].as_bool().unwrap_or(false);
    let (tx, rx) = mpsc::channel::<Result<()>>();
    let started = Arc::new(AtomicBool::new(false));
    let window = WebviewWindowBuilder::new(
        &app,
        format!("pdf-{}", files::now()),
        WebviewUrl::External(url::Url::from_file_path(&html).map_err(|_| "无效导出路径")?),
    )
    .title("PDF 导出")
    .visible(false)
    .inner_size(1100.0, 850.0)
    .on_navigation(|url| url.scheme() == "file" || url.scheme() == "about")
    .on_page_load(move |window, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished
            || started.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let path = print_path.clone();
        let failure = tx.clone();
        let completed = tx.clone();
        let result = window.with_webview(move |view| {
            use webview2_com::{
                Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2Environment6, ICoreWebView2_7,
                    COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
                },
                PrintToPdfCompletedHandler,
            };
            use windows::core::{Interface, HSTRING};
            let done = completed.clone();
            let outcome = (|| -> windows::core::Result<()> {
                unsafe {
                    let webview: ICoreWebView2_7 = view.controller().CoreWebView2()?.cast()?;
                    let environment: ICoreWebView2Environment6 = view.environment().cast()?;
                    let settings = environment.CreatePrintSettings()?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    if landscape {
                        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE)?;
                    }
                    let handler =
                        PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                            let result = match status {
                                Err(e) => Err(e.to_string()),
                                Ok(()) if !success => Err("WebView2 PDF 导出失败".into()),
                                Ok(()) => Ok(()),
                            };
                            let _ = done.send(result);
                            Ok(())
                        }));
                    webview.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler)
                }
            })();
            if let Err(e) = outcome {
                let _ = completed.send(Err(e.to_string()));
            }
        });
        if let Err(e) = result {
            let _ = failure.send(Err(e.to_string()));
        }
    })
    .build()
    .map_err(|e| e.to_string())?;
    let result = rx
        .recv_timeout(Duration::from_secs(90))
        .map_err(|e| format!("PDF 导出超时或中断：{e}"));
    let _ = window.close();
    result??;
    let bytes = fs::read(&pdf).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("WebView2 未产生有效 PDF".into());
    }
    files::atomic(&destination, &bytes)?;
    Ok(json!({"path":destination.to_string_lossy()}))
}
