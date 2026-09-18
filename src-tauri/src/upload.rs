use crate::files::{self, Result, Store};
use serde_json::{json, Value};
use std::time::Duration;

pub fn picgo(store: &Store, payload: &Value) -> Result<Value> {
    let path = files::scoped(store.root()?, files::field(payload, "path")?, true)?;
    if !path.is_file() {
        return Err("只能上传文件".into());
    }
    let mut endpoint =
        url::Url::parse(files::field(payload, "endpoint")?).map_err(|e| e.to_string())?;
    let is_loopback = match endpoint.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain("localhost")) => true,
        _ => false,
    };
    if endpoint.scheme() != "http"
        || !is_loopback
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err("PicGo 地址必须是本机 http://127.0.0.1、localhost 或 [::1] 服务".into());
    }
    if endpoint.host_str() == Some("localhost") {
        endpoint
            .set_host(Some("127.0.0.1"))
            .map_err(|e| e.to_string())?;
    }
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .max_redirects(0)
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(60)))
            .build(),
    );
    let mut response = agent
        .post(endpoint.as_str())
        .send_json(json!({"list":[path.to_string_lossy()]}))
        .map_err(|e| format!("PicGo 上传失败，本地附件仍保留：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("PicGo 返回 {}，本地附件仍保留", response.status()));
    }
    let result: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    if result["success"].as_bool() != Some(true) {
        return Err(format!(
            "PicGo 未确认上传成功，本地附件仍保留：{}",
            result["message"].as_str().unwrap_or("未知错误")
        ));
    }
    let remote = result["result"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .ok_or("PicGo 未返回图片 URL")?;
    let remote = url::Url::parse(remote).map_err(|e| e.to_string())?;
    if !["http", "https"].contains(&remote.scheme()) {
        return Err("PicGo 返回了不支持的链接协议".into());
    }
    Ok(json!({"url":remote.as_str(),"path":files::field(payload,"path")?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    #[test]
    fn local_picgo_contract_and_rejection() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("image.png"), b"image").unwrap();
        let mut store = Store::new(data.path().to_path_buf()).unwrap();
        store.choose(root.path().to_path_buf()).unwrap();
        assert!(picgo(
            &store,
            &json!({"path":"image.png","endpoint":"https://example.com/upload"})
        )
        .is_err());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0; 4096];
            let n = socket.read(&mut bytes).unwrap();
            assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("POST /upload HTTP/1.1"));
            let body = r#"{"success":true,"result":["https://images.example.test/test.png"]}"#;
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
        });
        let result = picgo(
            &store,
            &json!({"path":"image.png","endpoint":format!("http://{address}/upload")}),
        )
        .unwrap();
        assert_eq!(result["url"], "https://images.example.test/test.png");
        assert!(root.path().join("image.png").exists());
        server.join().unwrap();
    }
}
