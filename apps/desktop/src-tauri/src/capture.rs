// The screenshot shortcut (⌘⇧2 unless changed in the menu): macOS's own selection,
// taken by Brigade Computer Use (it holds Screen Recording, Brigade.app doesn't),
// added to a draft in ~/.brigade/captures. A small window shows the draft: the
// dashboard's /app/capture page, the web new-thread box, which reads the captures
// through the commands below and starts a thread with them. Closing the window
// keeps the draft; the menu-bar icon counts its captures until it is sent.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::ipc::{CapabilityBuilder, Response};
use tauri::menu::CheckMenuItem;
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_dialog::MessageDialogKind;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::setup::Helper;
use crate::{alert, dashboard, load_settings, runner, save_settings};

pub const WINDOW: &str = "capture";
/// The shortcuts the menu offers, as stored and as shown.
pub const SHORTCUTS: &[(&str, &str)] = &[
    ("cmd+shift+2", "⌘⇧2"),
    ("ctrl+shift+s", "⌃⇧S"),
    ("ctrl+alt+cmd+b", "⌃⌥⌘B"),
    ("off", "Off"),
];
pub const DEFAULT_SHORTCUT: &str = "cmd+shift+2";
/// Safari's: Google's sign-in turns away the bare WebKit one, as an embedded browser.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
/// How long the person may take to pick what to capture.
const SELECTING: Duration = Duration::from_secs(10 * 60);

pub struct Capture {
    /// A selection is on screen: the shortcut again does nothing.
    taking: AtomicBool,
    /// The menu's shortcut items, by stored value.
    items: Vec<(&'static str, CheckMenuItem<Wry>)>,
    /// Dashboard origins whose page may call the commands below.
    allowed: Mutex<HashSet<String>>,
    /// The secret of the window's sign-in through the browser, once started (`capture_sign_in`).
    verifier: Mutex<Option<String>>,
}

impl Capture {
    pub fn new(items: Vec<(&'static str, CheckMenuItem<Wry>)>) -> Self {
        Self {
            taking: AtomicBool::new(false),
            items,
            allowed: Mutex::new(HashSet::new()),
            verifier: Mutex::new(None),
        }
    }
}

fn dir() -> PathBuf {
    runner::home().join("captures")
}

/// A capture's file name: its time in milliseconds, so they sort as taken.
fn valid(name: &str) -> bool {
    name.strip_suffix(".png")
        .is_some_and(|stem| !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()))
}

/// The draft's captures, oldest first.
fn names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir())
        .map(|entries| {
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|name| valid(name))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|name| name.trim_end_matches(".png").parse::<u128>().unwrap_or(0));
    names
}

/// The count beside the menu-bar icon, while the draft has captures.
pub fn show_count(app: &AppHandle) {
    let count = names().len();
    if let Some(tray) = app.tray_by_id("brigade") {
        let _ = tray.set_title((count > 0).then(|| count.to_string()));
    }
}

/// The shortcut chosen in the menu, registered; an alert when another app holds it.
pub fn apply_shortcut(app: &AppHandle, value: &str) {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let capture = app.state::<Capture>();
    for (id, item) in &capture.items {
        let _ = item.set_checked(*id == value);
    }
    if value == "off" {
        return;
    }
    let registered = value
        .parse::<Shortcut>()
        .map_err(|e| e.to_string())
        .and_then(|shortcut| shortcuts.register(shortcut).map_err(|e| e.to_string()));
    if registered.is_err() {
        let label = SHORTCUTS
            .iter()
            .find(|(id, _)| *id == value)
            .map_or(value, |(_, label)| label);
        alert(
            app,
            "Screenshot shortcut unavailable",
            &format!("Another app already uses {label}. Pick another one in Brigade's menu, under Screenshot shortcut."),
            MessageDialogKind::Warning,
        );
        for (_, item) in &capture.items {
            let _ = item.set_checked(false);
        }
    }
}

/// From the menu: remembered, then registered.
pub fn choose_shortcut(app: &AppHandle, value: &str) {
    let Some((id, _)) = SHORTCUTS.iter().find(|(id, _)| *id == value) else {
        return;
    };
    let mut settings = load_settings();
    settings.capture_shortcut = Some((*id).to_owned());
    save_settings(&settings);
    apply_shortcut(app, id);
}

/// The shortcut: a selection, then the draft's window with it added. Esc during the selection adds nothing.
pub fn take(app: &AppHandle) {
    if app.state::<Capture>().taking.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let name = format!("{millis}.png");
        let path = dir().join(&name);
        // The draft's window stays above everything: out of the way of what is captured.
        let window = app.get_webview_window(WINDOW);
        let was_open = window
            .as_ref()
            .is_some_and(|w| w.is_visible().unwrap_or(false));
        if let Some(window) = &window {
            let _ = window.hide();
        }
        let result = app.state::<Helper>().call(
            "capture",
            json!({ "path": path.to_string_lossy() }),
            SELECTING,
        );
        app.state::<Capture>().taking.store(false, Ordering::SeqCst);
        match result {
            Ok(reply) if reply["cancelled"] == true => {
                if let Some(window) = window.filter(|_| was_open) {
                    bring_up(&window);
                }
            }
            Ok(_) => {
                show_count(&app);
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    show(&handle);
                    let _ = handle.emit_to(WINDOW, "capture-added", &name);
                });
            }
            Err(error) => {
                // The helper's own words are for a teammate; the person turns it on in setup.
                let message = if error.starts_with("Screen Recording is off") {
                    "Brigade Computer Use needs Screen Recording to take screenshots. Open Set up Brigade… in Brigade's menu to turn it on.".to_owned()
                } else {
                    error
                };
                alert(
                    &app,
                    "Could not take a screenshot",
                    &message,
                    MessageDialogKind::Error,
                );
            }
        }
    });
}

/// Lets the dashboard's page in the window, and only it, call the draft's commands.
fn allow(app: &AppHandle, origin: &str) {
    let capture = app.state::<Capture>();
    let mut allowed = capture.allowed.lock().unwrap();
    if allowed.contains(origin) {
        return;
    }
    let capability = CapabilityBuilder::new(format!("capture-{}", allowed.len()))
        .remote(format!("{origin}/*"))
        .window(WINDOW)
        .permission("allow-capture-list")
        .permission("allow-capture-read")
        .permission("allow-capture-remove")
        .permission("allow-capture-clear")
        .permission("allow-capture-hide")
        .permission("allow-capture-sign-in")
        // The header drags the window (`data-tauri-drag-region`): it has no title bar.
        .permission("core:window:allow-start-dragging")
        .permission("core:event:allow-listen")
        .permission("core:event:allow-unlisten");
    if app.add_capability(capability).is_ok() {
        allowed.insert(origin.to_owned());
    }
}

/// The draft's window, opened the first time and kept loaded after: closing only hides it.
pub fn show(app: &AppHandle) {
    let Ok(url) = Url::parse(&format!("{}/capture", dashboard())) else {
        return;
    };
    allow(app, &url.origin().ascii_serialization());
    if let Some(window) = app.get_webview_window(WINDOW) {
        bring_up(&window);
        let _ = window.emit("capture-shown", ());
        return;
    }
    let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title("New thread")
        .inner_size(560.0, 400.0)
        .min_inner_size(420.0, 300.0)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .user_agent(USER_AGENT)
        // Files dropped on the window go to the page (its new-thread box attaches them):
        // Tauri's own drop handler would take them first and the page would see nothing.
        .disable_drag_drop_handler()
        .center()
        .focused(true);
    // No title bar: the window buttons sit at the start of the page's "New thread for…" row
    // (about 52pt tall), which leaves room for them and drags the window.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 26.0));
    let window = builder.build();
    if let Ok(window) = window {
        let handle = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = handle.hide();
            }
        });
        bring_up(&window);
    }
}

fn bring_up(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn capture_list() -> Vec<String> {
    names()
}

#[tauri::command]
pub fn capture_read(name: String) -> Result<Response, String> {
    if !valid(&name) {
        return Err("no such capture".into());
    }
    std::fs::read(dir().join(name))
        .map(Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn capture_remove(app: AppHandle, name: String) {
    if valid(&name) {
        let _ = std::fs::remove_file(dir().join(name));
    }
    show_count(&app);
}

/// Sent: the draft starts over.
#[tauri::command]
pub fn capture_clear(app: AppHandle) {
    for name in names() {
        let _ = std::fs::remove_file(dir().join(name));
    }
    show_count(&app);
}

#[tauri::command]
pub fn capture_hide(window: WebviewWindow) {
    let _ = window.hide();
}

/// The window signs in through the browser, where the member likely is already: its WebKit
/// has cookies of its own. The browser gets the hash of a secret kept here, and sends back a
/// code (`signed_in`) that only that secret redeems (desktop-sign-in.ts in the API).
#[tauri::command]
pub fn capture_sign_in(app: AppHandle) -> Result<(), String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    *app.state::<Capture>().verifier.lock().unwrap() = Some(verifier);
    let mut url =
        Url::parse(&format!("{}/desktop-sign-in", dashboard())).map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("challenge", &challenge);
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// brigade://sign-in?code=…, from the browser: the window's sign-in page redeems the code with
/// the secret. Without a sign-in started here, the link does nothing.
pub fn signed_in(app: &AppHandle, code: &str) {
    let Some(verifier) = app.state::<Capture>().verifier.lock().unwrap().clone() else {
        return;
    };
    let Ok(mut url) = Url::parse(&dashboard()).and_then(|d| d.join("/sign-in")) else {
        return;
    };
    url.query_pairs_mut()
        .append_pair("desktop_code", code)
        .append_pair("verifier", &verifier);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        show(&handle);
        if let Some(window) = handle.get_webview_window(WINDOW) {
            let _ = window.navigate(url);
        }
    });
}
