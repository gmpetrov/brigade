// The setup checklist: a small window listing what this Mac needs for Brigade,
// each step checked live (page/setup.js asks every second or so) with the one
// action that fixes it. It opens on launch when a step is missing, unless the
// person closed it with those same steps missing, and from the menu.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt;

use crate::runner::{self, Status, Supervisor};
use crate::{dashboard, load_settings, save_settings, Items};

const WINDOW: &str = "setup";
const SCREEN_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const ACCESSIBILITY_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// The helper's permissions, as it reports them; None while it can't be asked.
#[derive(Clone, Copy)]
struct Permissions {
    screen: bool,
    accessibility: bool,
}

/// Brigade Computer Use.app, asked over its socket (the runner's protocol,
/// apps/runner/src/computer-use.ts) and started in the background when it isn't running.
pub struct Helper {
    app: Option<PathBuf>,
    last_launch: Mutex<Option<Instant>>,
}

impl Helper {
    pub fn new(app: Option<PathBuf>) -> Self {
        Self {
            app,
            last_launch: Mutex::new(None),
        }
    }

    /// Quits a helper still running from before this launch, e.g. from the copy an update or a
    /// reinstall replaced, so the next request starts the one inside this Brigade.app with a fresh
    /// view of its permissions. It holds no state worth keeping; the runner starts it on demand.
    pub fn restart(&self) {
        let _ = Command::new("pkill")
            .args(["-x", "brigade-computer-use"])
            .stderr(Stdio::null())
            .status();
    }

    fn ask(&self) -> Option<Value> {
        let dir = PathBuf::from(std::env::var_os("HOME")?).join(".brigade/computer-use");
        let token = std::fs::read_to_string(dir.join("token")).ok()?;
        let mut socket = UnixStream::connect(dir.join("sock")).ok()?;
        socket.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
        let request = json!({ "id": 1, "token": token.trim(), "method": "status", "params": {} });
        writeln!(socket, "{request}").ok()?;
        let mut line = String::new();
        BufReader::new(socket).read_line(&mut line).ok()?;
        let reply: Value = serde_json::from_str(&line).ok()?;
        (reply["ok"] == true).then(|| reply["result"].clone())
    }

    fn launch(&self) {
        let Some(app) = &self.app else { return };
        // -g: in the background. Opening it also makes macOS ask for what is missing.
        let _ = Command::new("open").arg("-g").arg("-a").arg(app).status();
    }

    /// Starts it at most every 15 seconds, so a helper that won't start isn't opened on every check.
    fn permissions(&self) -> Option<Permissions> {
        self.app.as_ref()?;
        let result = self.ask().or_else(|| {
            let mut last = self.last_launch.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < Duration::from_secs(15)) {
                return None;
            }
            *last = Some(Instant::now());
            drop(last);
            self.launch();
            let until = Instant::now() + Duration::from_secs(5);
            loop {
                std::thread::sleep(Duration::from_millis(250));
                if let Some(result) = self.ask() {
                    return Some(result);
                }
                if Instant::now() > until {
                    return None;
                }
            }
        })?;
        Some(Permissions {
            screen: result["screenRecording"] == true,
            accessibility: result["accessibility"] == true,
        })
    }
}

/// Where this Brigade.app runs from: a copy outside Applications (the disk image,
/// Downloads, or macOS's translocated copy of either) doesn't update itself.
fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.ancestors().nth(3)?.to_path_buf();
    (bundle.extension()? == "app").then_some(bundle)
}

fn in_applications(bundle: &Path) -> bool {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    bundle.starts_with("/Applications") || bundle.starts_with(home.join("Applications"))
}

/// One row: done is None while it is on its way (installing, restarting).
fn step(id: &str, title: &str, detail: String, done: Option<bool>, action: Option<(&str, &str)>) -> Value {
    json!({
        "id": id,
        "title": title,
        "detail": detail,
        "done": done,
        "action": action.map(|(id, label)| json!({ "id": id, "label": label })),
    })
}

fn steps(app: &AppHandle) -> Vec<Value> {
    let mut steps = Vec::new();

    // A development build runs from target/: nothing to move.
    if let Some(bundle) = bundle() {
        let ok = in_applications(&bundle);
        steps.push(step(
            "applications",
            "Brigade is in Applications",
            if ok {
                "It updates itself from there.".into()
            } else {
                "It runs from the disk image or Downloads, where it can't update itself.".into()
            },
            Some(ok),
            (!ok).then_some(("move", "Move to Applications")),
        ));
    }

    let workspace = runner::workspace();
    steps.push(step(
        "workspace",
        "Connected to a workspace",
        match &workspace {
            Some(name) => format!("This computer runs {name}'s teammates."),
            None => "In the dashboard, add this computer and open the link in Brigade.".into(),
        },
        Some(workspace.is_some()),
        workspace.is_none().then_some(("connect", "Connect…")),
    ));

    let status = app.state::<Arc<Supervisor>>().status();
    let (detail, done, action) = match &status {
        Status::Running { .. } => ("Teammates can start work here.".to_string(), Some(true), None),
        Status::Elsewhere => (
            "A runner started in a terminal runs here instead.".into(),
            Some(true),
            None,
        ),
        Status::Installing => ("Setting up…".into(), None, None),
        Status::Restarting { reason } => (
            format!("It stopped ({reason}) and starts again shortly."),
            None,
            Some(("logs", "Show logs")),
        ),
        Status::NotConnected => ("It starts once this computer is connected.".into(), Some(false), None),
        Status::Stopped => ("It is stopped.".into(), Some(false), Some(("restart", "Start"))),
    };
    steps.push(step("runner", "The runner is running", detail, done, action));

    let helper = app.state::<Helper>();
    let permissions = helper.permissions();
    let unknown = if helper.app.is_some() {
        "Checking Brigade Computer Use…"
    } else {
        "This build of Brigade has no Brigade Computer Use."
    };
    steps.push(step(
        "screen",
        "Screen Recording",
        match permissions {
            Some(p) if p.screen => "Teammates can see your screen when you ask them to use your apps.".into(),
            Some(_) => "Turn on Brigade Computer Use in the list that opens.".into(),
            None => unknown.into(),
        },
        permissions.map(|p| p.screen),
        matches!(permissions, Some(p) if !p.screen).then_some(("screen", "Allow…")),
    ));
    steps.push(step(
        "accessibility",
        "Accessibility",
        match permissions {
            Some(p) if p.accessibility => "Teammates can click and type in your apps when you ask them to.".into(),
            Some(_) => "Turn on Brigade Computer Use in the list that opens.".into(),
            None => unknown.into(),
        },
        permissions.map(|p| p.accessibility),
        matches!(permissions, Some(p) if !p.accessibility).then_some(("accessibility", "Allow…")),
    ));

    let login = app.autolaunch().is_enabled().unwrap_or(false);
    steps.push(step(
        "login",
        "Opens at login",
        if login {
            "Teammates can work here after a restart.".into()
        } else {
            "After a restart, teammates can't work here until you open Brigade.".into()
        },
        Some(login),
        (!login).then_some(("login", "Turn on")),
    ));
    steps
}

/// The ids of the steps not done (in progress counts as not done).
fn missing(steps: &[Value]) -> Vec<String> {
    steps
        .iter()
        .filter(|s| s["done"] != true)
        .filter_map(|s| s["id"].as_str().map(str::to_owned))
        .collect()
}

/// Last checked, so closing the window can remember what was missing without checking again.
#[derive(Default)]
pub struct Last(Mutex<Vec<String>>);

#[tauri::command(async)]
pub fn setup_state(app: AppHandle) -> Value {
    let steps = steps(&app);
    let missing = missing(&steps);
    *app.state::<Last>().0.lock().unwrap() = missing.clone();
    json!({ "steps": steps, "done": missing.is_empty() })
}

#[tauri::command(async)]
pub fn setup_action(app: AppHandle, id: String) -> Result<(), String> {
    let open = |url: &str| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
    match id.as_str() {
        "move" => move_to_applications(&app),
        "connect" => open(&format!("{}/computers?desktop=1", dashboard())),
        "restart" => {
            app.state::<Arc<Supervisor>>().start();
            Ok(())
        }
        "logs" => Command::new("open")
            .args(["-a", "Console"])
            .arg(runner::log_file())
            .status()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        "screen" | "accessibility" => {
            // The helper asks macOS for its permissions when it starts; the list is where they're turned on.
            app.state::<Helper>().launch();
            open(if id == "screen" { SCREEN_SETTINGS } else { ACCESSIBILITY_SETTINGS })
        }
        "login" => {
            app.autolaunch().enable().map_err(|e| e.to_string())?;
            let _ = app.state::<Arc<Items>>().login.set_checked(true);
            Ok(())
        }
        "close" => {
            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.close();
            }
            Ok(())
        }
        _ => Err(format!("unknown action {id}")),
    }
}

/// Copies this Brigade.app to /Applications and starts that one, then quits.
fn move_to_applications(app: &AppHandle) -> Result<(), String> {
    let from = bundle().ok_or("Brigade isn't running from an app bundle.")?;
    let to = PathBuf::from("/Applications/Brigade.app");
    let staged = PathBuf::from("/Applications/.Brigade.app.new");
    let _ = std::fs::remove_dir_all(&staged);
    let copied = Command::new("ditto")
        .arg(&from)
        .arg(&staged)
        .status()
        .map_err(|e| e.to_string())?;
    if !copied.success() {
        let _ = std::fs::remove_dir_all(&staged);
        return Err("Brigade could not be copied to Applications: drag it there from the disk image.".into());
    }
    let _ = std::fs::remove_dir_all(&to);
    std::fs::rename(&staged, &to).map_err(|e| e.to_string())?;
    // The copy starts once this one has quit: a second Brigade would hand over to this one and stop.
    Command::new("sh")
        .args(["-c", "sleep 2; open \"$1\"", "sh"])
        .arg(&to)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    app.state::<Arc<Supervisor>>().stop();
    app.exit(0);
    Ok(())
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("setup.html".into()))
        .title("Set up Brigade")
        .inner_size(480.0, 640.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        .focused(true)
        .build();
    let Ok(window) = window else { return };
    let _ = window.set_focus();
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            // Closed with steps missing: don't open on its own again until something else is missing.
            let mut settings = load_settings();
            settings.setup_dismissed = app.state::<Last>().0.lock().unwrap().clone();
            save_settings(&settings);
        }
    });
}

/// On launch: opens the checklist when a step is missing that the person hasn't already seen missing.
pub fn show_if_needed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Let the runner start before judging it.
        std::thread::sleep(Duration::from_secs(3));
        let missing = missing(&steps(&app));
        let dismissed = load_settings().setup_dismissed;
        if missing.iter().any(|id| !dismissed.contains(id)) {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show(&handle));
        }
    });
}
