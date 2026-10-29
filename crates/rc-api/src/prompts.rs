//! Routes [`PromptRequest`]s from the core to whichever front end answers first.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::oneshot;

use rc_core::prompt::{PromptRequest, PromptResponse, Prompter};

use crate::events::EventBus;

#[derive(Debug, Clone, Serialize)]
pub struct PendingPrompt {
    pub id: String,
    pub request: PromptRequest,
}

struct Pending {
    request: PromptRequest,
    tx: oneshot::Sender<Option<PromptResponse>>,
}

pub struct PromptBroker {
    events: EventBus,
    pending: Mutex<HashMap<String, Pending>>,
    order: Mutex<Vec<String>>,
}

impl PromptBroker {
    pub fn new(events: EventBus) -> Arc<Self> {
        Arc::new(PromptBroker { events, pending: Mutex::new(HashMap::new()), order: Mutex::new(Vec::new()) })
    }

    pub fn pending(&self) -> Vec<PendingPrompt> {
        let pending = self.pending.lock();
        self.order
            .lock()
            .iter()
            .filter_map(|id| pending.get(id).map(|p| PendingPrompt { id: id.clone(), request: p.request.clone() }))
            .collect()
    }

    /// Answer a prompt (`None` = cancel). Unknown ids are ignored (already answered).
    pub fn respond(&self, id: &str, response: Option<PromptResponse>) {
        let p = self.pending.lock().remove(id);
        self.order.lock().retain(|x| x != id);
        if let Some(p) = p {
            let _ = p.tx.send(response);
            self.events.emit("prompt.closed", serde_json::json!({ "id": id }));
        }
    }

    /// Cancel everything (e.g. on shutdown).
    pub fn cancel_all(&self) {
        let ids: Vec<String> = self.pending.lock().keys().cloned().collect();
        for id in ids {
            self.respond(&id, None);
        }
    }
}

#[async_trait]
impl Prompter for PromptBroker {
    async fn prompt(&self, request: PromptRequest) -> Option<PromptResponse> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), Pending { request: request.clone(), tx });
        self.order.lock().push(id.clone());
        self.events.emit("prompt.request", PendingPrompt { id: id.clone(), request });
        let r = tokio::time::timeout(Duration::from_secs(600), rx).await;
        // On timeout make sure the UI closes the dialog.
        if r.is_err() {
            self.respond(&id, None);
        }
        r.ok().and_then(|x| x.ok()).flatten()
    }
}

/// Wraps the broker for one connection attempt: remembers passwords for saved sites.
pub struct SessionPrompter {
    pub broker: Arc<PromptBroker>,
    pub on_password: Box<dyn Fn(&str) + Send + Sync>,
}

#[async_trait]
impl Prompter for SessionPrompter {
    async fn prompt(&self, request: PromptRequest) -> Option<PromptResponse> {
        let is_password = matches!(request, PromptRequest::Password { .. });
        let r = self.broker.prompt(request).await;
        if let Some(resp) = &r {
            if is_password && resp.accepted && resp.remember {
                if let Some(pw) = resp.value(0) {
                    (self.on_password)(pw);
                }
            }
        }
        r
    }
}
