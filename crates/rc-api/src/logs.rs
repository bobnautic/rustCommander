//! Captures `tracing` events for the UI's log panel.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    /// Unix milliseconds.
    pub ts: i64,
    pub level: &'static str,
    pub session: Option<String>,
    pub message: String,
}

const CAPACITY: usize = 2000;

struct Sink {
    ring: Mutex<VecDeque<LogEntry>>,
    tx: broadcast::Sender<LogEntry>,
}

static SINK: OnceLock<Sink> = OnceLock::new();

fn sink() -> &'static Sink {
    SINK.get_or_init(|| Sink { ring: Mutex::new(VecDeque::with_capacity(CAPACITY)), tx: broadcast::channel(1024).0 })
}

pub fn recent() -> Vec<LogEntry> {
    sink().ring.lock().iter().cloned().collect()
}

pub fn subscribe() -> broadcast::Receiver<LogEntry> {
    sink().tx.subscribe()
}

/// `tracing` layer feeding the log panel: info+ from Rust Commander crates, warn+ else.
pub struct UiLogLayer;

#[derive(Default)]
struct Visitor {
    message: String,
    session: Option<String>,
    extra: String,
}

impl Visit for Visitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" => {
                let _ = write!(self.message, "{value:?}");
            }
            "session" => self.session = Some(format!("{value:?}").trim_matches('"').to_string()),
            name => {
                let _ = write!(self.extra, " {name}={value:?}");
            }
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => self.message.push_str(value),
            "session" => self.session = Some(value.to_string()),
            name => {
                let _ = write!(self.extra, " {name}={value}");
            }
        }
    }
}

impl<S: Subscriber> Layer<S> for UiLogLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let ours = meta.target().starts_with("rc_")
            || meta.target().starts_with("rust_commander")
            || meta.target().starts_with("rcmd");
        let level = *meta.level();
        if !(ours && level <= Level::INFO || level <= Level::WARN) {
            return;
        }
        let mut v = Visitor::default();
        event.record(&mut v);
        let session = v.session.filter(|s| !s.is_empty());
        let entry = LogEntry {
            ts: chrono::Utc::now().timestamp_millis(),
            level: match level {
                Level::ERROR => "error",
                Level::WARN => "warn",
                Level::INFO => "info",
                _ => "debug",
            },
            session,
            message: format!("{}{}", v.message, v.extra),
        };
        let s = sink();
        {
            let mut ring = s.ring.lock();
            if ring.len() >= CAPACITY {
                ring.pop_front();
            }
            ring.push_back(entry.clone());
        }
        let _ = s.tx.send(entry);
    }
}

/// Install a default subscriber: stderr output (filtered by `RUST_LOG`) + UI log layer.
pub fn init_tracing(default_filter: &str) {
    use tracing_subscriber::prelude::*;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_filter));
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_filter(filter))
        .with(UiLogLayer)
        .try_init();
}
