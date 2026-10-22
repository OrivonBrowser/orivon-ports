//! The SOCKS5 (and 4a) proxy on 127.0.0.1. The handshake is Arti's own
//! `tor-socksproto`; each user name and password pair gets circuits of its
//! own, as Tor's `IsolateSOCKSAuth` does, which is how Orivon keeps the sites
//! and apps it sends here apart (it signs in with a name per site or app).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use arti_client::isolation::IsolationHelper;
use arti_client::{ErrorKind, HasKind, IntoTorAddr as _, StreamPrefs};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tor_socksproto::{Handshake as _, NextStep, SocksAuth, SocksCmd, SocksRequest, SocksStatus};

use crate::events::Hub;
use crate::Client;

/// Connections counted for the page: open now, and opened since the start.
#[derive(Default)]
struct Counts {
    open: AtomicU64,
    total: AtomicU64,
}

pub async fn serve(client: Arc<Client>, hub: Hub, ports: Vec<u16>) {
    let mut listener = None;
    let mut last_error = String::new();
    for port in &ports {
        match TcpListener::bind(("127.0.0.1", *port)).await {
            Ok(l) => {
                listener = Some((l, *port));
                break;
            }
            Err(e) => last_error = format!("127.0.0.1:{port}: {e}"),
        }
    }
    let Some((listener, port)) = listener else {
        hub.emit(json!({ "t": "socks", "state": "failed", "msg": last_error }));
        return;
    };
    hub.emit(json!({ "t": "socks", "state": "listening", "host": "127.0.0.1", "port": port }));

    let counts = Arc::new(Counts::default());
    tokio::spawn(report_counts(hub.clone(), counts.clone()));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                tracing::warn!("SOCKS accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let client = client.clone();
        let counts = counts.clone();
        counts.open.fetch_add(1, Ordering::Relaxed);
        counts.total.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(async move {
            if let Err(e) = handle(client, stream).await {
                tracing::debug!("SOCKS connection ended: {e}");
            }
            counts.open.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

async fn report_counts(hub: Hub, counts: Arc<Counts>) {
    let mut last = (u64::MAX, u64::MAX);
    loop {
        let now = (counts.open.load(Ordering::Relaxed), counts.total.load(Ordering::Relaxed));
        if now != last {
            hub.emit(json!({ "t": "traffic", "open": now.0, "total": now.1 }));
            last = now;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Circuits are shared only by connections that signed in with the same name and password.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SocksIsolation(Option<(Vec<u8>, Vec<u8>)>);

impl IsolationHelper for SocksIsolation {
    fn compatible_same_type(&self, other: &Self) -> bool {
        self == other
    }

    fn join_same_type(&self, other: &Self) -> Option<Self> {
        (self == other).then(|| self.clone())
    }
}

async fn handle(client: Arc<Client>, mut stream: TcpStream) -> Result<(), String> {
    let request = handshake(&mut stream).await?;
    let addr = request.addr().to_string();
    let port = request.port();
    let mut prefs = StreamPrefs::new();
    prefs.ipv4_preferred();
    prefs.set_isolation(SocksIsolation(match request.auth() {
        SocksAuth::Username(user, pass) => Some((user.clone(), pass.clone())),
        _ => None,
    }));

    match request.command() {
        SocksCmd::CONNECT => {
            let target = (addr.as_str(), port).into_tor_addr().map_err(|e| e.to_string());
            let tor_stream = match target {
                Ok(target) => client.connect_with_prefs(target, &prefs).await.map_err(|e| e.kind()),
                Err(_) => Err(ErrorKind::InvalidStreamTarget),
            };
            let mut tor_stream = match tor_stream {
                Ok(s) => s,
                Err(kind) => return reply_error(&mut stream, &request, kind).await,
            };
            let reply = request.reply(SocksStatus::SUCCEEDED, None).map_err(|e| e.to_string())?;
            stream.write_all(&reply).await.map_err(|e| e.to_string())?;
            tokio::io::copy_bidirectional(&mut stream, &mut tor_stream).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        SocksCmd::RESOLVE => {
            let resolved = match addr.parse() {
                Ok(ip) => Ok(ip),
                Err(_) => client
                    .resolve_with_prefs(&addr, &prefs)
                    .await
                    .map_err(|e| e.kind())
                    .and_then(|ips| ips.first().copied().ok_or(ErrorKind::Other)),
            };
            match resolved {
                Ok(ip) => {
                    let reply = request
                        .reply(SocksStatus::SUCCEEDED, Some(&tor_socksproto::SocksAddr::Ip(ip)))
                        .map_err(|e| e.to_string())?;
                    stream.write_all(&reply).await.map_err(|e| e.to_string())
                }
                Err(kind) => reply_error(&mut stream, &request, kind).await,
            }
        }
        _ => {
            let reply = request.reply(SocksStatus::COMMAND_NOT_SUPPORTED, None).map_err(|e| e.to_string())?;
            let _ = stream.write_all(&reply).await;
            Err(format!("unsupported SOCKS command {}", request.command()))
        }
    }
}

async fn handshake(stream: &mut TcpStream) -> Result<SocksRequest, String> {
    let mut handshake = tor_socksproto::SocksProxyHandshake::new();
    let mut buffer = tor_socksproto::Buffer::new();
    loop {
        match handshake.step(&mut buffer).map_err(|e| e.to_string())? {
            NextStep::Recv(mut recv) => {
                let n = stream.read(recv.buf()).await.map_err(|e| e.to_string())?;
                recv.note_received(n).map_err(|e| e.to_string())?;
            }
            NextStep::Send(data) => {
                stream.write_all(&data).await.map_err(|e| e.to_string())?;
            }
            NextStep::Finished(done) => {
                // An HTTP request sent here by mistake is answered in words, not dropped.
                return done.into_output_forbid_pipelining().map_err(|e| e.to_string());
            }
        }
    }
}

async fn reply_error(stream: &mut TcpStream, request: &SocksRequest, kind: ErrorKind) -> Result<(), String> {
    use ErrorKind as EK;
    let status = match kind {
        EK::RemoteNetworkFailed => SocksStatus::TTL_EXPIRED,
        EK::OnionServiceNotFound => SocksStatus::HS_DESC_NOT_FOUND,
        EK::OnionServiceAddressInvalid => SocksStatus::HS_BAD_ADDRESS,
        EK::OnionServiceMissingClientAuth => SocksStatus::HS_MISSING_CLIENT_AUTH,
        EK::OnionServiceWrongClientAuth => SocksStatus::HS_WRONG_CLIENT_AUTH,
        EK::OnionServiceNotRunning | EK::OnionServiceConnectionFailed | EK::OnionServiceProtocolViolation => {
            SocksStatus::HS_INTRO_FAILED
        }
        _ => SocksStatus::GENERAL_FAILURE,
    };
    if let Ok(reply) = request.reply(status, None) {
        let _ = stream.write_all(&reply).await;
    }
    // The reason, never the address: the log is shown in the page and may be copied into a report.
    tracing::info!("a SOCKS request could not be carried: {kind}");
    Err(format!("{kind}"))
}
