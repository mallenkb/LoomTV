use serde_json::Value;
use std::time::Duration;

/// Retain one state and one track list. Native polling can continue without
/// making the webview allocate and render identical playback snapshots.
#[derive(Default)]
pub(crate) struct SnapshotDelivery {
    state: Option<Value>,
    tracks: Option<Value>,
}

impl SnapshotDelivery {
    pub(crate) fn acknowledge_command(&mut self) {
        self.state = None;
    }

    pub(crate) fn changed(&mut self, mut next: Value) -> Option<Value> {
        if self
            .state
            .as_ref()
            .is_some_and(|state| state["sessionId"] != next["sessionId"])
        {
            *self = Self::default();
        }
        let tracks = next
            .as_object_mut()
            .and_then(|object| object.remove("tracks"));
        let tracks_changed = tracks
            .as_ref()
            .is_some_and(|value| self.tracks.as_ref() != Some(value));
        if self.state.as_ref() == Some(&next) && !tracks_changed {
            return None;
        }
        self.state = Some(next.clone());
        if tracks_changed {
            self.tracks = tracks.clone();
            next["tracks"] = tracks.unwrap();
        }
        Some(next)
    }

    pub(crate) fn poll_interval(&self) -> Option<Duration> {
        let state = self.state.as_ref()?;
        match state["status"].as_str() {
            Some("ended" | "closed" | "error") => None,
            Some("ready") if state["paused"] == true => Some(Duration::from_millis(250)),
            _ => Some(Duration::from_millis(16)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paused() -> Value {
        json!({"sessionId":"one","status":"ready","paused":true,"position":20.0,"duration":90.0})
    }

    #[test]
    fn paused_polling_does_not_repeat_webview_messages() {
        let mut delivery = SnapshotDelivery::default();
        assert!(delivery.changed(paused()).is_some());
        for _ in 0..10_000 {
            assert!(delivery.changed(paused()).is_none());
        }
        assert_eq!(delivery.poll_interval(), Some(Duration::from_millis(250)));
    }

    #[test]
    fn seek_resume_and_terminal_transitions_are_delivered_immediately() {
        let mut delivery = SnapshotDelivery::default();
        delivery.changed(paused());
        delivery.acknowledge_command();
        assert!(
            delivery.changed(paused()).is_some(),
            "a seek to the same timestamp still needs an acknowledgement"
        );
        let mut state = paused();
        state["position"] = json!(25.0);
        assert!(delivery.changed(state.clone()).is_some());
        state["paused"] = json!(false);
        assert!(delivery.changed(state.clone()).is_some());
        assert_eq!(delivery.poll_interval(), Some(Duration::from_millis(16)));
        for status in ["ended", "closed", "error"] {
            state["status"] = json!(status);
            assert!(delivery.changed(state.clone()).is_some());
            assert_eq!(delivery.poll_interval(), None);
        }
    }

    #[test]
    fn track_changes_are_delivered_once_and_new_sessions_receive_their_tracks() {
        let mut delivery = SnapshotDelivery::default();
        let mut state = paused();
        state["tracks"] = json!([{"id":1,"selected":true}]);
        assert!(delivery
            .changed(state.clone())
            .unwrap()
            .get("tracks")
            .is_some());
        assert!(delivery.changed(state.clone()).is_none());
        state["position"] = json!(21.0);
        assert!(delivery
            .changed(state.clone())
            .unwrap()
            .get("tracks")
            .is_none());
        state["tracks"] = json!([]);
        assert_eq!(
            delivery.changed(state.clone()).unwrap()["tracks"],
            json!([])
        );
        state["sessionId"] = json!("two");
        assert!(delivery.changed(state).unwrap().get("tracks").is_some());
    }
}
