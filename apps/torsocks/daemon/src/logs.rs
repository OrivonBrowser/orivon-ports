//! Arti's own log, as `log` events. Arti logs through `tracing` with its
//! sensitive values (addresses, onion names) already redacted by `safelog`.

use std::fmt::Write as _;

use serde_json::json;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

use crate::events::Hub;

/// How much of Arti's log is reported: `<data>/log-level` holds `debug` or `trace` for more than the default `info`.
pub fn level_in(data: &std::path::Path) -> Level {
    match std::fs::read_to_string(data.join("log-level")).unwrap_or_default().trim() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        _ => Level::INFO,
    }
}

pub fn install(hub: Hub, level: Level) {
    let filter = Targets::new()
        .with_default(Level::WARN)
        .with_target("arti_client", level)
        .with_target("tor_", level)
        .with_target("torsocksd", level);
    let _ = tracing_subscriber::registry().with(HubLayer(hub).with_filter(filter)).try_init();
}

struct HubLayer(Hub);

impl<S: Subscriber> Layer<S> for HubLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut text = Text::default();
        event.record(&mut text);
        let meta = event.metadata();
        self.0.emit(json!({
            "t": "log",
            "level": meta.level().as_str(),
            "target": meta.target(),
            "msg": text.0
        }));
    }
}

/// The event's message, then its other fields as `name=value`.
#[derive(Default)]
struct Text(String);

impl Visit for Text {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let rest = std::mem::take(&mut self.0);
            let _ = write!(self.0, "{value:?}");
            self.0.push_str(&rest);
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.insert_str(0, value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}
