// Brigade.app: a menu-bar app, no Dock icon. It installs, links and keeps
// running the Brigade runner (runner.rs), ships Brigade Computer Use.app for
// teammates to use this Mac's apps, starts at login and updates itself. Its one
// window is the setup checklist (setup.rs).
mod runner;
mod setup;

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use runner::{Status, Supervisor};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const DEFAULT_DASHBOARD: &str = "https://brigade.lol/app";
const HELPER: &str = "Brigade Computer Use.app";
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What Brigade.app keeps beside the runner's files: ~/.brigade/desktop.json.
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    dashboard_url: Option<String>,
    /// Open at login was turned on once, on the first launch; after that it is the person's choice.
    login_set: bool,
    /// Keep screen awake, off until the person turns it on.
    #[serde(default)]
    keep_awake: bool,
}

fn settings_file() -> PathBuf {
    runner::home().join("desktop.json")
}

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_settings(settings: &Settings) {
    let _ = std::fs::create_dir_all(runner::home());
    if let Ok(text) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(settings_file(), text);
    }
}

fn dashboard() -> String {
    load_settings()
        .dashboard_url
        .unwrap_or_else(|| DEFAULT_DASHBOARD.into())
}

/// The menu items that change.
struct Items {
    status: MenuItem<Wry>,
    connect: MenuItem<Wry>,
    update: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
    awake: CheckMenuItem<Wry>,
    /// An update is installed and waits for a restart.
    update_ready: Mutex<bool>,
}

fn show_status(items: &Items, status: &Status) {
    let _ = items.status.set_text(status.label());
    let _ = items.connect.set_text(match status {
        Status::NotConnected => "Connect this computer…",
        _ => "Connect to another workspace…",
    });
}

/// `caffeinate` while Keep screen awake is on: the display, and so the Mac, stay
/// awake for teammates to see and use it. -w ties it to this app, so it ends when Brigade quits.
#[derive(Default)]
struct Awake(Mutex<Option<Child>>);

fn keep_awake(app: &AppHandle, on: bool) {
    let awake = app.state::<Awake>();
    let mut slot = awake.0.lock().unwrap();
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if on {
        *slot = Command::new("caffeinate")
            .args(["-d", "-i", "-w", &std::process::id().to_string()])
            .spawn()
            .ok();
    }
}

fn alert(app: &AppHandle, title: &str, message: &str, kind: MessageDialogKind) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .show(|_| {});
}

/// brigade://link?code=…&api=…[&dashboard=…], from "Open in Brigade" in the dashboard.
fn open_link(app: &AppHandle, link: &Url) {
    if link.scheme() != "brigade" || link.host_str() != Some("link") {
        return;
    }
    let query = |key: &str| {
        link.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let (Some(code), Some(api)) = (query("code"), query("api")) else {
        return;
    };
    let Ok(api_url) = Url::parse(&api) else {
        return;
    };
    let local = matches!(api_url.host_str(), Some("localhost") | Some("127.0.0.1"));
    if api_url.scheme() != "https" && !local {
        return;
    }
    let host = api_url.host_str().unwrap_or_default().to_owned();
    let dashboard_url = query("dashboard");
    let app = app.clone();
    std::thread::spawn(move || {
        // A link alone never connects this computer: its teammates would run commands here.
        let confirmed = app
            .dialog()
            .message(format!(
                "AI teammates of the workspace at {host} will run on this computer: they read and change files, run commands and can use your apps when you allow it.\n\nOnly connect a workspace you trust."
            ))
            .title("Connect this computer to Brigade?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Connect".into(), "Cancel".into()))
            .blocking_show();
        if !confirmed {
            return;
        }
        let supervisor = app.state::<Arc<Supervisor>>().inner().clone();
        match supervisor.connect(api.trim_end_matches('/'), &code) {
            Ok(()) => {
                let mut settings = load_settings();
                if let Some(url) = dashboard_url
                    .filter(|u| u.starts_with("https://") || u.starts_with("http://localhost"))
                {
                    settings.dashboard_url = Some(url);
                }
                save_settings(&settings);
                // What's left to set up, the workspace now checked.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || setup::show(&handle));
            }
            Err(error) => alert(&app, "Could not connect", &error, MessageDialogKind::Error),
        }
    });
}

/// Checks GitHub Releases; installs a newer Brigade.app, which applies on restart.
async fn check_for_update(app: AppHandle, manual: bool) {
    let items = app.state::<Arc<Items>>();
    if *items.update_ready.lock().unwrap() {
        return;
    }
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    *items.update_ready.lock().unwrap() = true;
                    let _ = items
                        .update
                        .set_text(format!("Restart to update to {version}"));
                }
                Err(error) if manual => alert(
                    &app,
                    "Update failed",
                    &error.to_string(),
                    MessageDialogKind::Error,
                ),
                Err(_) => {}
            }
        }
        Ok(None) if manual => alert(
            &app,
            "Brigade is up to date",
            &format!("Version {}", app.package_info().version),
            MessageDialogKind::Info,
        ),
        Err(error) if manual => alert(
            &app,
            "Could not check for updates",
            &error.to_string(),
            MessageDialogKind::Error,
        ),
        _ => {}
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "connect" => {
            let _ = app
                .opener()
                .open_url(format!("{}/computers?desktop=1", dashboard()), None::<&str>);
        }
        "dashboard" => {
            let _ = app.opener().open_url(dashboard(), None::<&str>);
        }
        "setup" => setup::show(app),
        "restart-runner" => app.state::<Arc<Supervisor>>().start(),
        "awake" => {
            let on = app.state::<Arc<Items>>().awake.is_checked().unwrap_or(false);
            let mut settings = load_settings();
            settings.keep_awake = on;
            save_settings(&settings);
            keep_awake(app, on);
        }
        "login" => {
            let launch = app.autolaunch();
            let _ = if launch.is_enabled().unwrap_or(false) {
                launch.disable()
            } else {
                launch.enable()
            };
        }
        "update" => {
            if *app.state::<Arc<Items>>().update_ready.lock().unwrap() {
                app.state::<Arc<Supervisor>>().stop();
                app.restart();
            }
            tauri::async_runtime::spawn(check_for_update(app.clone(), true));
        }
        "logs" => {
            let _ = Command::new("open")
                .args(["-a", "Console"])
                .arg(runner::log_file())
                .status();
        }
        "quit" => {
            app.state::<Arc<Supervisor>>().stop();
            app.exit(0);
        }
        _ => {}
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    let launch = app.autolaunch();
    let mut settings = load_settings();
    if !settings.login_set {
        let _ = launch.enable();
        settings.login_set = true;
        save_settings(&settings);
    }

    let status = MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
    let connect = MenuItem::with_id(app, "connect", "Connect this computer…", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for updates…", true, None::<&str>)?;
    let awake = CheckMenuItem::with_id(
        app,
        "awake",
        "Keep screen awake",
        true,
        settings.keep_awake,
        None::<&str>,
    )?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Open at login",
        true,
        launch.is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let helper = app
        .path()
        .resource_dir()
        .map(|dir| dir.join(HELPER))
        .ok()
        .filter(|p| p.exists());
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "dashboard", "Open dashboard", true, None::<&str>)?,
            &connect,
            &MenuItem::with_id(app, "setup", "Set up Brigade…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &awake,
            &login,
            &update,
            &MenuItem::with_id(app, "restart-runner", "Restart runner", true, None::<&str>)?,
            &MenuItem::with_id(app, "logs", "Show logs", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Brigade", true, Some("cmd+q"))?,
        ],
    )?;
    TrayIconBuilder::with_id("brigade")
        .icon(Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?)
        .icon_as_template(true)
        .tooltip("Brigade")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .build(app)?;

    let items = Arc::new(Items {
        status,
        connect,
        update,
        login,
        awake,
        update_ready: Mutex::new(false),
    });
    app.manage(items.clone());
    let computer_use = setup::Helper::new(helper.clone());
    computer_use.restart();
    app.manage(computer_use);
    app.manage(Awake::default());
    if settings.keep_awake {
        keep_awake(app.handle(), true);
    }
    let supervisor = Supervisor::new(helper, move |status| show_status(&items, status));
    app.manage(supervisor.clone());
    supervisor.start();
    setup::show_if_needed(app.handle());

    let handle = app.handle().clone();
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open_link(&handle, &url);
        }
    }
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open_link(&handle, &url);
        }
    });

    let handle = app.handle().clone();
    std::thread::spawn(move || loop {
        tauri::async_runtime::block_on(check_for_update(handle.clone(), false));
        std::thread::sleep(UPDATE_EVERY);
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // A second launch (or a brigade:// link while running) goes to this one.
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![setup::setup_state, setup::setup_action])
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("Brigade could not start")
        .run(|app, event| match event {
            // Closing the setup checklist, its only window, isn't quitting: Brigade lives in the
            // menu bar. Quit (and an update's restart) ask with a code and still exit.
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            RunEvent::Exit => app.state::<Arc<Supervisor>>().stop(),
            _ => {}
        });
}
