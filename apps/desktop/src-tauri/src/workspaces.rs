// The workspaces this Mac is linked to, one runner home each, and the one it runs for.
//
// A runner keeps a workspace's own state in its home: runner.json (its link), the library
// mirror, the outbox of events not yet sent, thread folders. So each workspace gets a home of
// its own and switching never mixes them: the first one linked keeps ~/.brigade itself (as
// before this list existed), the others live in ~/.brigade/workspaces/<key>. They share the
// runner install (bin/, node/, runner/) in ~/.brigade, and one runner runs at a time, for the
// workspace named in ~/.brigade/active-workspace.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runner;

/// The key of ~/.brigade itself.
pub const BASE: &str = "";

#[derive(Clone, Debug)]
pub struct Linked {
    /// BASE, or its folder's name in ~/.brigade/workspaces.
    pub key: String,
    pub name: String,
    pub id: Option<String>,
    pub api: String,
}

fn homes_dir(base: &Path) -> PathBuf {
    base.join("workspaces")
}

fn active_file(base: &Path) -> PathBuf {
    base.join("active-workspace")
}

/// A key names a folder of workspaces/, nothing else: no path, no dots.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn home_in(base: &Path, key: &str) -> PathBuf {
    if key == BASE {
        base.to_path_buf()
    } else {
        homes_dir(base).join(key)
    }
}

/// The workspace a home is linked to, from its runner's config.
fn read_link(base: &Path, key: &str) -> Option<Linked> {
    let text = fs::read_to_string(home_in(base, key).join("runner.json")).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = config.get("workspaceName")?.as_str()?.to_owned();
    let api = config
        .get("apiUrl")?
        .as_str()?
        .trim_end_matches('/')
        .to_owned();
    // Older runners linked without it; their token starts with it (`<workspaceId>.<secret>`).
    let id = config
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .or_else(|| {
            let token = config.get("token")?.as_str()?;
            let (id, _) = token.split_once('.')?;
            (!id.is_empty()).then(|| id.to_owned())
        });
    Some(Linked {
        key: key.to_owned(),
        name,
        id,
        api,
    })
}

fn all_in(base: &Path) -> Vec<Linked> {
    let mut linked: Vec<Linked> = read_link(base, BASE).into_iter().collect();
    let mut others: Vec<Linked> = fs::read_dir(homes_dir(base))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let key = entry.file_name().to_str()?.to_owned();
            valid_key(&key).then_some(())?;
            read_link(base, &key)
        })
        .collect();
    others.sort_by_key(|w| w.name.to_lowercase());
    linked.extend(others);
    linked
}

fn active_in(base: &Path) -> String {
    let key = fs::read_to_string(active_file(base))
        .map(|text| text.trim().to_owned())
        .unwrap_or_default();
    // A home since removed by hand: back to ~/.brigade.
    if valid_key(&key) && homes_dir(base).join(&key).is_dir() {
        key
    } else {
        BASE.to_owned()
    }
}

fn set_active_in(base: &Path, key: &str) {
    let _ = fs::create_dir_all(base);
    let _ = fs::write(active_file(base), key);
}

/// Where a link to the workspace `id` (when the link names it) on `api` goes, and whether
/// that home is new: the workspace's own home when it is linked here already, so linking it
/// again keeps its computer; without an id (a link from an older API), the active home, as
/// Brigade.app did before; ~/.brigade while that is linked to nothing; else a new home.
fn home_for_link_in(base: &Path, id: Option<&str>, api: &str) -> (String, bool) {
    let api = api.trim_end_matches('/');
    let linked = all_in(base);
    if let Some(id) = id {
        if let Some(w) = linked
            .iter()
            .find(|w| w.id.as_deref() == Some(id) && w.api == api)
        {
            return (w.key.clone(), false);
        }
    }
    if id.is_none() {
        return (active_in(base), false);
    }
    if read_link(base, BASE).is_none() {
        return (BASE.to_owned(), false);
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut n = 0;
    loop {
        let key = if n == 0 {
            format!("w{stamp}")
        } else {
            format!("w{stamp}-{n}")
        };
        if !homes_dir(base).join(&key).exists() {
            return (key, true);
        }
        n += 1;
    }
}

pub fn all() -> Vec<Linked> {
    all_in(&runner::home())
}

/// The key of the workspace the runner runs for.
pub fn active() -> String {
    active_in(&runner::home())
}

pub fn set_active(key: &str) {
    set_active_in(&runner::home(), key)
}

/// The runner home of a workspace.
pub fn home(key: &str) -> PathBuf {
    home_in(&runner::home(), key)
}

pub fn home_for_link(id: Option<&str>, api: &str) -> (String, bool) {
    home_for_link_in(&runner::home(), id, api)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "brigade-workspaces-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn link(home: &Path, name: &str, config: serde_json::Value) {
        fs::create_dir_all(home).unwrap();
        let mut config = config;
        config["workspaceName"] = name.into();
        fs::write(home.join("runner.json"), config.to_string()).unwrap();
    }

    #[test]
    fn first_link_goes_to_the_base_home() {
        let base = temp();
        assert_eq!(
            home_for_link_in(&base, Some("ws_a"), "https://api.test"),
            (BASE.to_owned(), false)
        );
    }

    #[test]
    fn the_same_workspace_keeps_its_home() {
        let base = temp();
        link(
            &base,
            "Acme",
            serde_json::json!({ "apiUrl": "https://api.test", "workspaceId": "ws_a", "token": "ws_a.x" }),
        );
        link(
            &homes_dir(&base).join("w1"),
            "Beta",
            serde_json::json!({ "apiUrl": "https://api.test/", "token": "ws_b.secret" }),
        );
        assert_eq!(
            home_for_link_in(&base, Some("ws_a"), "https://api.test/"),
            (BASE.to_owned(), false)
        );
        // Its id from the token, for a runner linked before runner.json kept it.
        assert_eq!(
            home_for_link_in(&base, Some("ws_b"), "https://api.test"),
            ("w1".to_owned(), false)
        );
    }

    #[test]
    fn another_workspace_gets_a_new_home() {
        let base = temp();
        link(
            &base,
            "Acme",
            serde_json::json!({ "apiUrl": "https://api.test", "workspaceId": "ws_a" }),
        );
        let (key, new) = home_for_link_in(&base, Some("ws_c"), "https://api.test");
        assert!(new && valid_key(&key));
        // The same workspace on another API is another workspace.
        let (_, new) = home_for_link_in(&base, Some("ws_a"), "https://other.test");
        assert!(new);
    }

    #[test]
    fn a_link_without_an_id_relinks_the_active_home() {
        let base = temp();
        link(
            &base,
            "Acme",
            serde_json::json!({ "apiUrl": "https://api.test" }),
        );
        link(
            &homes_dir(&base).join("w1"),
            "Beta",
            serde_json::json!({ "apiUrl": "https://api.test" }),
        );
        set_active_in(&base, "w1");
        assert_eq!(
            home_for_link_in(&base, None, "https://api.test"),
            ("w1".to_owned(), false)
        );
    }

    #[test]
    fn lists_and_activates_workspaces() {
        let base = temp();
        link(
            &base,
            "Zeta",
            serde_json::json!({ "apiUrl": "https://api.test" }),
        );
        link(
            &homes_dir(&base).join("w2"),
            "beta",
            serde_json::json!({ "apiUrl": "https://api.test" }),
        );
        link(
            &homes_dir(&base).join("w1"),
            "Alpha",
            serde_json::json!({ "apiUrl": "https://api.test" }),
        );
        // A folder that was never linked is no workspace.
        fs::create_dir_all(homes_dir(&base).join("w3")).unwrap();
        let names: Vec<_> = all_in(&base).into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["Zeta", "Alpha", "beta"]);

        assert_eq!(active_in(&base), BASE);
        set_active_in(&base, "w2");
        assert_eq!(active_in(&base), "w2");
        // Nothing outside workspaces/, and a home removed falls back to ~/.brigade.
        set_active_in(&base, "../elsewhere");
        assert_eq!(active_in(&base), BASE);
        set_active_in(&base, "w9");
        assert_eq!(active_in(&base), BASE);
    }
}
