//! Every event the daemon reports, one JSON object per line, sent to each
//! control connection. The latest event of each kind (and each service's) is
//! kept, with the recent log lines, so a page that connects later sees the
//! state at once rather than waiting for the next change. Only what a page
//! needs before the control port answers is printed on stdout too: a spawned
//! program's every write waits for the page to take it.

use std::collections::{BTreeMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::broadcast;

const LOG_LINES_KEPT: usize = 400;
const CHANNEL_DEPTH: usize = 1024;

#[derive(Clone)]
pub struct Hub(Arc<Inner>);

struct Inner {
    tx: broadcast::Sender<Arc<str>>,
    kept: Mutex<Kept>,
}

#[derive(Default)]
struct Kept {
    latest: BTreeMap<String, Arc<str>>,
    logs: VecDeque<Arc<str>>,
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_DEPTH);
        Self(Arc::new(Inner { tx, kept: Mutex::new(Kept::default()) }))
    }

    pub fn emit(&self, event: Value) {
        let line: Arc<str> = Arc::from(event.to_string());
        {
            let mut kept = self.0.kept.lock().unwrap_or_else(|p| p.into_inner());
            match keep_key(&event) {
                Some(key) if key == "log" => {
                    if kept.logs.len() == LOG_LINES_KEPT {
                        kept.logs.pop_front();
                    }
                    kept.logs.push_back(line.clone());
                }
                Some(key) => {
                    kept.latest.insert(key, line.clone());
                }
                None => {}
            }
        }
        if on_stdout(&event) {
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(stdout, "{line}");
            let _ = stdout.flush();
        }
        let _ = self.0.tx.send(line);
    }

    /// Forgets the kept event of one service, once it is removed.
    pub fn forget(&self, key: &str) {
        self.0.kept.lock().unwrap_or_else(|p| p.into_inner()).latest.remove(key);
    }

    /// What a new listener is sent first: the kept state, then the recent log.
    pub fn snapshot(&self) -> Vec<Arc<str>> {
        let kept = self.0.kept.lock().unwrap_or_else(|p| p.into_inner());
        kept.latest.values().chain(kept.logs.iter()).cloned().collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.0.tx.subscribe()
    }
}

fn on_stdout(event: &Value) -> bool {
    matches!(event.get("t").and_then(Value::as_str), Some("hello" | "control" | "fatal" | "exit"))
}

/// Which kept slot an event replaces, if any: a service's events are kept per service.
fn keep_key(event: &Value) -> Option<String> {
    let kind = event.get("t")?.as_str()?;
    match kind {
        "log" => Some("log".into()),
        "service" | "hits" => Some(format!("{kind}:{}", event.get("id")?.as_str()?)),
        "hello" | "bootstrap" | "bootstrap-error" | "socks" | "traffic" | "control" | "fatal" => Some(kind.into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_the_latest_state_and_the_log_in_order() {
        let hub = Hub::new();
        hub.emit(json!({ "t": "bootstrap", "frac": 0.1 }));
        hub.emit(json!({ "t": "log", "msg": "one" }));
        hub.emit(json!({ "t": "bootstrap", "frac": 0.9 }));
        hub.emit(json!({ "t": "service", "id": "a", "state": "running" }));
        hub.emit(json!({ "t": "check", "id": "a" }));
        let lines: Vec<String> = hub.snapshot().iter().map(|l| l.to_string()).collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("0.9"));
        assert!(lines[1].contains("running"));
        assert!(lines[2].contains("one"));
        hub.forget("service:a");
        assert_eq!(hub.snapshot().len(), 2);
    }
}
