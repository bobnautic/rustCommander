//! Event bus: every event goes to all attached front ends (desktop webview, web clients).

use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub name: String,
    pub payload: serde_json::Value,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
}

impl Default for EventBus {
    fn default() -> Self {
        EventBus::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(4096);
        EventBus { tx }
    }

    pub fn emit<T: Serialize>(&self, name: &str, payload: T) {
        let payload = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        let _ = self.tx.send(Event { name: name.to_string(), payload });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}
