//! torsocksd: Arti's Tor client as a SOCKS5 proxy on this computer, and the
//! host of the onion services a person publishes from TorSocks' page.
//!
//! It runs as a WASI 0.2 command inside Orivon (the page spawns it), so every
//! socket and file goes through the app's own grants. The page talks to it on
//! a loopback control port (`control.rs`), which a reloaded page or a second
//! tab reaches again; stdout carries the same events for the page that spawned
//! it. `../README.md` is the protocol and the design notes.

mod args;
mod control;
mod events;
mod http;
mod listing;
mod logs;
mod onion;
mod socks;
mod sqlite_vfs;

use std::sync::Arc;
use std::time::Duration;

use arti_client::config::TorClientConfigBuilder;
use arti_client::{BootstrapBehavior, TorClient};
use futures::StreamExt;
use serde_json::json;
use tor_rtcompat::tokio::TokioRustlsRuntime;

use crate::events::Hub;

pub type Client = TorClient<TokioRustlsRuntime>;

/// The Arti release the daemon is built on; `build.mjs` checks it against the recipe's pin.
pub const ARTI_CLIENT_VERSION: &str = "0.47.0";

fn main() {
    let args = match args::Args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(why) => {
            eprintln!("torsocksd: {why}\n{}", args::USAGE);
            std::process::exit(2);
        }
    };
    sqlite_vfs::prefer_unlocked_vfs();
    // Arti leaves the TLS provider to the application; ring builds for WASI.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a current-thread tokio runtime");
    let code = runtime.block_on(run(args));
    std::process::exit(code);
}

async fn run(args: args::Args) -> i32 {
    let hub = Hub::new();
    logs::install(hub.clone(), logs::level_in(&args.data));
    hub.emit(json!({ "t": "hello", "version": env!("CARGO_PKG_VERSION"), "arti": ARTI_CLIENT_VERSION }));

    let key = match control::read_key(&args.data) {
        Ok(key) => key,
        Err(why) => return fatal(&hub, "control-key", &why),
    };
    // The control port is bound first: a second daemon of the same app fails
    // here, before it touches the state directory the first one is using.
    let control_listener = match tokio::net::TcpListener::bind(("127.0.0.1", args.control_port)).await {
        Ok(listener) => listener,
        Err(e) => return fatal(&hub, "control-port-busy", &format!("port {}: {e}", args.control_port)),
    };

    let client = match make_client(&args) {
        Ok(client) => client,
        Err(why) => return fatal(&hub, "tor-client", &why),
    };
    let services = onion::Services::new(client.clone(), hub.clone(), args.data.clone());

    tokio::spawn(bootstrap(client.clone(), hub.clone()));
    tokio::spawn(socks::serve(client.clone(), hub.clone(), args.socks_ports.clone()));
    for id in &args.publish {
        services.publish(id);
    }
    hub.emit(json!({ "t": "control", "port": args.control_port }));
    control::serve(control_listener, key, hub.clone(), services).await;
    0
}

fn make_client(args: &args::Args) -> Result<Arc<Client>, String> {
    let runtime = TokioRustlsRuntime::current().map_err(|e| format!("runtime: {e}"))?;
    let mut builder = TorClientConfigBuilder::from_directories(args.data.join("arti/state"), args.data.join("arti/cache"));
    // The app's files have no owners or modes to check (orivon.fs keeps none).
    builder.storage().permissions().dangerously_trust_everyone();
    builder.address_filter().allow_onion_addrs(true);
    let config = builder.build().map_err(|e| format!("config: {e}"))?;
    TorClient::with_runtime(runtime)
        .config(config)
        .bootstrap_behavior(BootstrapBehavior::OnDemand)
        .create_unbootstrapped()
        .map_err(|e| report(&e))
}

/// Reports bootstrap progress, and starts again after a failure until Tor is reached.
async fn bootstrap(client: Arc<Client>, hub: Hub) {
    let mut events = client.bootstrap_events();
    let watcher_hub = hub.clone();
    tokio::spawn(async move {
        while let Some(status) = events.next().await {
            watcher_hub.emit(json!({
                "t": "bootstrap",
                "frac": status.as_frac(),
                "ready": status.ready_for_traffic(),
                "blocked": status.blocked().map(|b| b.to_string()),
                "msg": status.to_string()
            }));
        }
    });
    let mut wait = Duration::from_secs(5);
    while let Err(e) = client.bootstrap().await {
        hub.emit(json!({ "t": "bootstrap-error", "msg": report(&e), "retryInSec": wait.as_secs() }));
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(120));
    }
}

/// An error with every cause under it, as Arti's own reports read: "a: b: c".
pub fn report(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(inner) = cause {
        let more = inner.to_string();
        if !text.ends_with(&more) {
            text.push_str(": ");
            text.push_str(&more);
        }
        cause = inner.source();
    }
    text
}

fn fatal(hub: &Hub, code: &str, why: &str) -> i32 {
    hub.emit(json!({ "t": "fatal", "code": code, "msg": why }));
    1
}
