//! The control port on 127.0.0.1: JSON lines both ways. A connection's first
//! line must be `{"op":"hello","key":...}` with the key the page wrote to
//! `<data>/control.key` before it spawned the daemon, so only a page of the
//! app (which alone can read its own files) gives orders. Any other program on
//! this computer can reach the port and is closed on after its first line.
//! A connection then gets the kept state and every event, and may send:
//! publish, stop, forget, check (by `id`), status, and quit.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast::error::RecvError;

use crate::events::Hub;
use crate::onion::Services;

const LINE_LIMIT: u64 = 16 * 1024;
const HELLO_WITHIN: Duration = Duration::from_secs(10);
const MIN_KEY_LENGTH: usize = 32;

pub fn read_key(data: &Path) -> Result<String, String> {
    let path = data.join("control.key");
    let key = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let key = key.trim().to_owned();
    if key.len() < MIN_KEY_LENGTH {
        return Err(format!("{} holds fewer than {MIN_KEY_LENGTH} characters", path.display()));
    }
    Ok(key)
}

#[derive(Deserialize)]
struct Command {
    op: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    key: String,
}

pub async fn serve(listener: TcpListener, key: String, hub: Hub, services: Services) {
    let key: Arc<str> = Arc::from(key);
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(session(stream, key.clone(), hub.clone(), services.clone()));
            }
            Err(e) => {
                tracing::warn!("control accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

async fn session(stream: TcpStream, key: Arc<str>, hub: Hub, services: Services) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let hello = match tokio::time::timeout(HELLO_WITHIN, read_line(&mut reader)).await {
        Ok(Some(line)) => serde_json::from_str::<Command>(&line).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|h| h.op == "hello" && same(h.key.as_bytes(), key.as_bytes())) else {
        let _ = write.write_all(b"{\"t\":\"refused\"}\n").await;
        return;
    };
    drop(hello);

    // Subscribed before the snapshot is taken, so nothing falls between the two.
    let mut events = hub.subscribe();
    let welcome = json!({ "t": "welcome", "running": services.running_ids() }).to_string();
    let mut first = format!("{welcome}\n");
    for line in hub.snapshot() {
        first.push_str(&line);
        first.push('\n');
    }
    if write.write_all(first.as_bytes()).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            line = read_line(&mut reader) => match line {
                Some(line) => obey(&line, &hub, &services),
                None => return,
            },
            event = events.recv() => match event {
                Ok(line) => {
                    let mut text = line.to_string();
                    text.push('\n');
                    if write.write_all(text.as_bytes()).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return,
            },
        }
    }
}

fn obey(line: &str, hub: &Hub, services: &Services) {
    let Ok(command) = serde_json::from_str::<Command>(line) else {
        hub.emit(json!({ "t": "error", "msg": "a control line was not a command" }));
        return;
    };
    match command.op.as_str() {
        "publish" => services.publish(&command.id),
        "stop" => services.stop(&command.id),
        "forget" => services.forget(&command.id),
        "check" => {
            let services = services.clone();
            tokio::spawn(async move { services.check(&command.id).await });
        }
        "status" => {
            for line in hub.snapshot() {
                if let Ok(value) = serde_json::from_str(&line) {
                    hub.emit(value);
                }
            }
        }
        "quit" => {
            hub.emit(json!({ "t": "exit" }));
            std::process::exit(0);
        }
        other => hub.emit(json!({ "t": "error", "msg": format!("unknown command {other:?}") })),
    }
}

/// One line without its newline, or `None` at the end of the stream or past the length limit.
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Option<String> {
    let mut bytes = Vec::new();
    let n = reader.take(LINE_LIMIT).read_until(b'\n', &mut bytes).await.ok()?;
    if n == 0 || bytes.last() != Some(&b'\n') {
        return None;
    }
    bytes.pop();
    String::from_utf8(bytes).ok()
}

/// Compares in time that depends only on the length, not on where the keys differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_compare_exactly() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"abcd"));
    }

    #[tokio::test]
    async fn lines_end_at_the_newline_or_not_at_all() {
        let mut input: &[u8] = b"{\"op\":\"status\"}\nrest";
        assert_eq!(read_line(&mut input).await.as_deref(), Some("{\"op\":\"status\"}"));
        assert_eq!(read_line(&mut input).await, None);
        let long = vec![b'a'; LINE_LIMIT as usize + 10];
        let mut input: &[u8] = &long;
        assert_eq!(read_line(&mut input).await, None);
    }
}
