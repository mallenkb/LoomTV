use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    time::Duration,
};

use mdns_sd::{DaemonEvent, ResolvedService, ServiceDaemon, ServiceEvent};
use serde::Serialize;
use serde_json::Value;

use crate::{Error, Result};

const SERVICE_TYPE: &str = "_loomtv._tcp.local.";
const PROTOCOL_VERSION: &str = "2";
const MIN_TIMEOUT_MS: u64 = 500;
const MAX_TIMEOUT_MS: u64 = 30_000;
const MONITOR_POLL_MS: u64 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNetworkPeer {
    pub device_id: String,
    pub device_name: String,
    pub host: String,
    pub port: u16,
    pub addresses: Vec<String>,
    pub app_version: String,
    pub cert_fingerprint: String,
}

struct DiscoverySession {
    daemon: ServiceDaemon,
    active: bool,
    browsing: bool,
}

impl DiscoverySession {
    fn start() -> Result<(
        Self,
        mdns_sd::Receiver<ServiceEvent>,
        mdns_sd::Receiver<DaemonEvent>,
    )> {
        let daemon = ServiceDaemon::new().map_err(discovery_error)?;
        let mut session = Self {
            daemon,
            active: true,
            browsing: false,
        };
        let monitor = match session.daemon.monitor() {
            Ok(monitor) => monitor,
            Err(error) => {
                let _ = session.close();
                return Err(discovery_error(error));
            }
        };
        let events = match session.daemon.browse(SERVICE_TYPE) {
            Ok(events) => events,
            Err(error) => {
                let _ = session.close();
                return Err(discovery_error(error));
            }
        };
        session.browsing = true;
        Ok((session, events, monitor))
    }

    fn close(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        let stop_result = if self.browsing {
            self.daemon.stop_browse(SERVICE_TYPE)
        } else {
            Ok(())
        };
        let shutdown_result = self.daemon.shutdown();
        if shutdown_result.is_ok() {
            self.active = false;
            self.browsing = false;
        }
        stop_result.map_err(discovery_error)?;
        shutdown_result.map_err(discovery_error)?;
        Ok(())
    }
}

impl Drop for DiscoverySession {
    fn drop(&mut self) {
        if self.active {
            if self.browsing {
                let _ = self.daemon.stop_browse(SERVICE_TYPE);
            }
            let _ = self.daemon.shutdown();
            self.active = false;
            self.browsing = false;
        }
    }
}

pub async fn discover(timeout_ms: u64) -> Result<Value> {
    let peers = discover_peers(timeout_ms).await?;
    serde_json::to_value(peers).map_err(Into::into)
}

pub async fn discover_peers(timeout_ms: u64) -> Result<Vec<LocalNetworkPeer>> {
    let timeout = Duration::from_millis(timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
    let deadline = tokio::time::Instant::now() + timeout;
    let (mut session, events, monitor) = DiscoverySession::start()?;
    let mut peers = HashMap::<String, LocalNetworkPeer>::new();
    let mut conflicted_ids = HashSet::<String>::new();

    let scan_result = loop {
        if let Some(error) = daemon_error(&monitor) {
            break Err(error);
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break daemon_error(&monitor).map_or(Ok(()), Err);
        }

        let wait = remaining.min(Duration::from_millis(MONITOR_POLL_MS));
        match tokio::time::timeout(wait, events.recv_async()).await {
            Ok(Ok(ServiceEvent::ServiceResolved(service))) => {
                let Some(peer) = peer_from_service(&service) else {
                    continue;
                };
                merge_peer(&mut peers, &mut conflicted_ids, peer);
            }
            Ok(Ok(ServiceEvent::SearchStopped(_))) => {
                break Err(Error::new(
                    "lan_discovery_failed",
                    "Local network discovery stopped before the requested timeout.",
                ));
            }
            Ok(Ok(_)) | Err(_) => {}
            Ok(Err(_)) => {
                break Err(Error::new(
                    "lan_discovery_failed",
                    "Local network discovery ended before the requested timeout.",
                ));
            }
        }
    };

    let cleanup_result = session.close();
    scan_result?;
    cleanup_result?;

    let mut peers: Vec<_> = peers.into_values().collect();
    peers.sort_by(|left, right| {
        left.device_name
            .to_lowercase()
            .cmp(&right.device_name.to_lowercase())
            .then_with(|| left.device_name.cmp(&right.device_name))
            .then_with(|| left.device_id.cmp(&right.device_id))
    });
    Ok(peers)
}

fn daemon_error(monitor: &mdns_sd::Receiver<DaemonEvent>) -> Option<Error> {
    while let Ok(event) = monitor.try_recv() {
        if let DaemonEvent::Error(error) = event {
            return Some(discovery_error(error));
        }
    }
    None
}

fn discovery_error(error: mdns_sd::Error) -> Error {
    Error {
        code: "lan_discovery_unavailable".into(),
        message: format!("Local network discovery is unavailable: {error}"),
        retryable: true,
    }
}

fn peer_from_service(service: &ResolvedService) -> Option<LocalNetworkPeer> {
    if !service.ty_domain.eq_ignore_ascii_case(SERVICE_TYPE)
        || !valid_mdns_hostname(service.get_hostname())
    {
        return None;
    }

    let device_name = instance_name(service.get_fullname())?;
    let properties = service.get_properties();
    if properties.len() != 4
        || properties.iter().any(|property| {
            !matches!(
                property.key().to_ascii_lowercase().as_str(),
                "protocolversion" | "instanceid" | "port" | "certfingerprint"
            )
        })
    {
        return None;
    }

    let protocol_version = txt_value(service, "protocolVersion")?;
    let device_id = txt_value(service, "instanceId")?;
    let txt_port = txt_value(service, "port")?;
    let fingerprint = txt_value(service, "certFingerprint")?;
    if protocol_version != PROTOCOL_VERSION
        || !valid_device_id(device_id)
        || !valid_fingerprint(fingerprint)
    {
        return None;
    }

    let port = service.get_port();
    if port == 0 || txt_port != port.to_string() {
        return None;
    }

    let mut addresses: Vec<Ipv4Addr> = service
        .get_addresses_v4()
        .into_iter()
        .filter(valid_peer_address)
        .collect();
    addresses.sort_unstable();
    addresses.dedup();
    let host = addresses.first()?.to_string();

    Some(LocalNetworkPeer {
        device_id: device_id.into(),
        device_name: device_name.into(),
        host,
        port,
        addresses: addresses
            .into_iter()
            .map(|address| address.to_string())
            .collect(),
        app_version: "protocol-v2".into(),
        cert_fingerprint: fingerprint.to_ascii_lowercase(),
    })
}

fn txt_value<'a>(service: &'a ResolvedService, key: &str) -> Option<&'a str> {
    let value = service.get_property(key)?.val()?;
    std::str::from_utf8(value).ok()
}

fn instance_name(fullname: &str) -> Option<&str> {
    let suffix = format!(".{SERVICE_TYPE}");
    let suffix_start = fullname.len().checked_sub(suffix.len())?;
    let received_suffix = fullname.get(suffix_start..)?;
    if suffix_start == 0 || !received_suffix.eq_ignore_ascii_case(&suffix) {
        return None;
    }

    let name = fullname.get(..suffix_start)?;
    if name.is_empty()
        || name.chars().count() > 80
        || name.contains('.')
        || name.chars().any(char::is_control)
        || name.trim() != name
    {
        return None;
    }
    Some(name)
}

fn valid_mdns_hostname(hostname: &str) -> bool {
    if hostname.len() > 255 || !hostname.is_ascii() {
        return false;
    }
    let Some(prefix) = hostname
        .to_ascii_lowercase()
        .strip_suffix(".local.")
        .map(str::to_owned)
    else {
        return false;
    };
    !prefix.is_empty()
        && prefix.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn valid_device_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.is_ascii()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'-' | b'_' | b'.' | b':'))
        })
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_peer_address(address: &Ipv4Addr) -> bool {
    !address.is_unspecified()
        && !address.is_loopback()
        && !address.is_multicast()
        && !address.is_broadcast()
}

fn merge_peer(
    peers: &mut HashMap<String, LocalNetworkPeer>,
    conflicted_ids: &mut HashSet<String>,
    peer: LocalNetworkPeer,
) {
    if conflicted_ids.contains(&peer.device_id) {
        return;
    }

    let Some(existing) = peers.get_mut(&peer.device_id) else {
        peers.insert(peer.device_id.clone(), peer);
        return;
    };

    if existing.device_name != peer.device_name
        || existing.port != peer.port
        || existing.cert_fingerprint != peer.cert_fingerprint
    {
        conflicted_ids.insert(peer.device_id.clone());
        peers.remove(&peer.device_id);
        return;
    }

    existing.addresses.extend(peer.addresses);
    existing
        .addresses
        .sort_by_key(|address| address.parse::<Ipv4Addr>().ok());
    existing.addresses.dedup();
    if let Some(host) = existing.addresses.first() {
        existing.host.clone_from(host);
    }
}
