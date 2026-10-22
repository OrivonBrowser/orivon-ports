//! The onion services a person publishes. Each has an id the page chose, which
//! is also Arti's nickname for it, so its key (and with it its .onion address)
//! is kept across restarts in Arti's keystore. What it serves is
//! `<data>/sites/<id>/www`, written there by the page.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use safelog::DisplayRedacted as _;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;
use tor_cell::relaycell::msg::{Connected, End, EndReason};
use tor_hsservice::config::OnionServiceConfigBuilder;
use tor_hsservice::status::{Problem, State};
use tor_hsservice::{HsNickname, RunningOnionService, StreamRequest};
use tor_proto::stream::IncomingStreamRequest;

use crate::events::Hub;
use crate::Client;

/// The one port a published service answers on.
pub const HTTP_PORT: u16 = 80;
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);

/// A service id: what the page names a site's directory and Arti names its key by.
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && id.as_bytes()[0].is_ascii_alphanumeric()
}

#[derive(Clone)]
pub struct Services(Arc<Inner>);

struct Inner {
    client: Arc<Client>,
    hub: Hub,
    data: PathBuf,
    running: Mutex<HashMap<String, Running>>,
}

struct Running {
    // Dropping the service stops it; the tasks that serve it are aborted with it.
    _service: Arc<RunningOnionService>,
    onion: Option<String>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Services {
    pub fn new(client: Arc<Client>, hub: Hub, data: PathBuf) -> Self {
        Self(Arc::new(Inner { client, hub, data, running: Mutex::new(HashMap::new()) }))
    }

    fn site_dir(&self, id: &str) -> PathBuf {
        self.0.data.join("sites").join(id)
    }

    pub fn publish(&self, id: &str) {
        if let Err(why) = self.try_publish(id) {
            self.0.hub.emit(json!({ "t": "service", "id": id, "state": "broken", "error": why }));
        }
    }

    fn try_publish(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err(format!("{id:?} is not a service id"));
        }
        let mut running = self.0.running.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = running.get(id) {
            self.0.hub.emit(json!({ "t": "service", "id": id, "state": "running", "onion": existing.onion }));
            return Ok(());
        }
        let root = self.site_dir(id).join("www");
        if !root.is_dir() {
            return Err("there is nothing to publish yet: its files are missing".into());
        }
        let listing = read_listing_setting(&self.site_dir(id));
        let nickname = HsNickname::new(id.to_owned()).map_err(|e| e.to_string())?;
        let config = OnionServiceConfigBuilder::default().nickname(nickname).build().map_err(|e| crate::report(&e))?;
        let (service, requests) = self
            .0
            .client
            .launch_onion_service(config)
            .map_err(|e| crate::report(&e))?
            .ok_or("Arti did not start the service")?;
        let onion = service.onion_address().map(|hsid| hsid.display_unredacted().to_string());
        self.0.hub.emit(json!({ "t": "service", "id": id, "state": "starting", "onion": onion }));

        let hits = Arc::new(AtomicU64::new(0));
        let tasks = vec![
            tokio::spawn(watch_status(self.0.hub.clone(), id.to_owned(), onion.clone(), service.clone())),
            tokio::spawn(serve_requests(self.0.hub.clone(), id.to_owned(), root, listing, hits, requests)),
        ];
        running.insert(id.to_owned(), Running { _service: service, onion, tasks });
        Ok(())
    }

    pub fn stop(&self, id: &str) {
        let removed = self.0.running.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        let onion = removed.as_ref().and_then(|r| r.onion.clone());
        drop(removed);
        self.0.hub.emit(json!({ "t": "service", "id": id, "state": "stopped", "onion": onion }));
    }

    /// Stops the service and deletes its key: its address is gone for good.
    pub fn forget(&self, id: &str) {
        if !valid_id(id) {
            return;
        }
        self.stop(id);
        let state = self.0.data.join("arti/state");
        for dir in [state.join("keystore/hss").join(id), state.join("hss").join(id)] {
            if dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    tracing::warn!("could not remove {}: {e}", dir.display());
                }
            }
        }
        self.0.hub.forget(&format!("service:{id}"));
        self.0.hub.forget(&format!("hits:{id}"));
        self.0.hub.emit(json!({ "t": "forgotten", "id": id }));
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.0.running.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect()
    }

    /// Reaches the service the way a visitor does, through Tor, and reports what answered.
    pub async fn check(&self, id: &str) {
        let onion = self.0.running.lock().unwrap_or_else(|p| p.into_inner()).get(id).and_then(|r| r.onion.clone());
        let Some(onion) = onion else {
            self.0.hub.emit(json!({ "t": "check", "id": id, "ok": false, "msg": "the service is not running" }));
            return;
        };
        let started = Instant::now();
        let result = tokio::time::timeout(CHECK_TIMEOUT, fetch_status_line(&self.0.client, &onion)).await;
        let ms = started.elapsed().as_millis() as u64;
        let event = match result {
            Ok(Ok(status)) => json!({ "t": "check", "id": id, "ok": status.contains(" 200 "), "status": status, "ms": ms }),
            Ok(Err(why)) => json!({ "t": "check", "id": id, "ok": false, "msg": why, "ms": ms }),
            Err(_) => json!({ "t": "check", "id": id, "ok": false, "msg": "no answer within two minutes", "ms": ms }),
        };
        self.0.hub.emit(event);
    }
}

fn read_listing_setting(site: &Path) -> bool {
    std::fs::read(site.join("site.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("listing").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

fn state_word(state: State) -> &'static str {
    match state {
        // Arti reports a service it has not begun as shut down; a stopped one is reported by `stop`.
        State::Shutdown => "starting",
        State::Bootstrapping => "publishing",
        State::DegradedReachable => "degraded",
        State::DegradedUnreachable => "unreachable",
        State::Running => "running",
        State::Recovering => "recovering",
        State::Broken => "broken",
        _ => "unknown",
    }
}

async fn watch_status(hub: Hub, id: String, onion: Option<String>, service: Arc<RunningOnionService>) {
    let mut events = service.status_events();
    while let Some(status) = events.next().await {
        let problem = status.current_problem().and_then(problem_text);
        hub.emit(json!({ "t": "service", "id": id, "state": state_word(status.state()), "onion": onion, "problem": problem }));
    }
}

fn problem_text(problem: &Problem) -> Option<String> {
    fn joined<E: std::fmt::Display>(errors: &[E]) -> Option<String> {
        (!errors.is_empty()).then(|| errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))
    }
    match problem {
        Problem::Runtime(e) => Some(e.to_string()),
        Problem::DescriptorUpload(errors) => joined(errors).map(|e| format!("publishing its descriptor: {e}")),
        Problem::Ipt(errors) => joined(errors).map(|e| format!("introduction points: {e}")),
        _ => None,
    }
}

async fn serve_requests(
    hub: Hub,
    id: String,
    root: PathBuf,
    listing: bool,
    hits: Arc<AtomicU64>,
    requests: impl futures::Stream<Item = tor_hsservice::RendRequest> + Send + 'static,
) {
    let streams = tor_hsservice::handle_rend_requests(requests);
    futures::pin_mut!(streams);
    while let Some(request) = streams.next().await {
        let root = root.clone();
        let hub = hub.clone();
        let id = id.clone();
        let hits = hits.clone();
        tokio::spawn(async move {
            if let Some(stream) = accept(request).await {
                let count = hits.fetch_add(1, Ordering::Relaxed) + 1;
                hub.emit(json!({ "t": "hits", "id": id, "count": count }));
                crate::http::serve(stream, root, listing).await;
            }
        });
    }
}

async fn accept(request: StreamRequest) -> Option<arti_client::DataStream> {
    match request.request() {
        IncomingStreamRequest::Begin(begin) if begin.port() == HTTP_PORT => request.accept(Connected::new_empty()).await.ok(),
        _ => {
            let _ = request.reject(End::new_with_reason(EndReason::DONE)).await;
            None
        }
    }
}

async fn fetch_status_line(client: &Client, onion: &str) -> Result<String, String> {
    let mut stream = client.connect((onion, HTTP_PORT)).await.map_err(|e| e.to_string())?;
    let request = format!("HEAD / HTTP/1.1\r\nHost: {onion}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;
    let mut head = vec![0u8; 512];
    let n = stream.read(&mut head).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&head[..n]);
    Ok(text.lines().next().unwrap_or("").to_owned())
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn ids_are_one_safe_label() {
        assert!(valid_id("a"));
        assert!(valid_id("site-2026-x9"));
        assert!(!valid_id(""));
        assert!(!valid_id("-a"));
        assert!(!valid_id("A"));
        assert!(!valid_id("../keys"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(&"a".repeat(33)));
    }
}
