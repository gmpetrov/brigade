// The Brigade runner, as the API's install script sets it up in ~/.brigade:
// Node.js, the runner bundle and its wrapper, bin/brigade-runner, which starts
// the new runner when it updates itself (exit code 75). Brigade.app installs it
// with that same script, links it with a code from the dashboard, and keeps
// `brigade-runner start` running. The runner keeps updating itself as before.
use std::fs::{self, File, OpenOptions};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// No runner installed yet, or installed but not linked to a workspace.
    NotConnected,
    Installing,
    Running {
        workspace: String,
    },
    /// A runner started elsewhere (a terminal) is running: two would fight over the same computer.
    Elsewhere,
    /// The runner stopped and will start again shortly.
    Restarting {
        reason: String,
    },
    Stopped,
}

impl Status {
    pub fn label(&self) -> String {
        match self {
            Status::NotConnected => "Not connected to a workspace".into(),
            Status::Installing => "Setting up…".into(),
            Status::Running { workspace } => format!("● Running for {workspace}"),
            Status::Elsewhere => "Runner already running in a terminal".into(),
            Status::Restarting { reason } => format!("Restarting: {reason}"),
            Status::Stopped => "Stopped".into(),
        }
    }
}

/// ~/.brigade, or $BRIGADE_HOME.
pub fn home() -> PathBuf {
    std::env::var_os("BRIGADE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".brigade")
        })
}

fn wrapper() -> PathBuf {
    home().join("bin/brigade-runner")
}

pub fn log_file() -> PathBuf {
    home().join("logs/runner.log")
}

/// The workspace this computer is linked to, from the runner's own config.
pub fn workspace() -> Option<String> {
    let text = fs::read_to_string(home().join("runner.json")).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    config.get("workspaceName")?.as_str().map(str::to_owned)
}

/// The log, appended to; started over once it passes 5 MB.
fn log() -> std::io::Result<File> {
    let path = log_file();
    fs::create_dir_all(path.parent().unwrap())?;
    if fs::metadata(&path)
        .map(|m| m.len() > 5_000_000)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Commands the runner starts (git, the harness CLIs) are found where a person's shell finds them.
fn path_env() -> String {
    let base = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    match std::env::var("PATH") {
        Ok(path) if !path.is_empty() => format!("{base}:{path}"),
        _ => base.into(),
    }
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> std::io::Result<Command> {
    let mut command = Command::new(program);
    let out = log()?;
    command
        .env("PATH", path_env())
        .stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(out);
    Ok(command)
}

/// Exit code of a runner that found another one running from the same home.
const ALREADY_RUNNING: i32 = 3;

/// A runner this app did not start, e.g. in a terminal: the one holding runner.pid
/// (newer runners), or one `pgrep` finds by its entry point (older ones).
fn running_elsewhere() -> bool {
    let holder = fs::read_to_string(home().join("runner.pid"))
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    let mut pids: Vec<u32> = holder.into_iter().collect();
    if let Ok(output) = Command::new("pgrep")
        .args(["-f", "runner/dist/index.js start"])
        .output()
    {
        pids.extend(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok()),
        );
    }
    pids.into_iter().any(|pid| {
        Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .map(|o| {
                let command = String::from_utf8_lossy(&o.stdout);
                command.contains("node") || command.contains("tsx")
            })
            .unwrap_or(false)
    })
}

/// The process group of the runner this app started, kept until it exits: a
/// runner left behind when the app was killed is the app's to stop, not "elsewhere".
fn group_file() -> PathBuf {
    home().join("desktop-runner.pgid")
}

fn alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .stderr(Stdio::null())
        .status()
        .map_or(false, |s| s.success())
}

/// Stops a runner group an earlier run of this app left behind.
fn stop_orphan() {
    let Ok(group) = fs::read_to_string(group_file()) else {
        return;
    };
    let group = group.trim().to_owned();
    let ours = Command::new("ps")
        .args(["-o", "command=", "-p", &group])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("brigade-runner"))
        .unwrap_or(false);
    if ours {
        let target = format!("-{group}");
        let _ = Command::new("kill").args(["-TERM", "--", &target]).status();
        let until = Instant::now() + Duration::from_secs(60);
        while alive(&group) && Instant::now() < until {
            thread::sleep(Duration::from_millis(200));
        }
        let _ = Command::new("kill")
            .args(["-KILL", "--", &target])
            .stderr(Stdio::null())
            .status();
        // Its node process removes runner.pid as it exits.
        thread::sleep(Duration::from_millis(500));
    }
    let _ = fs::remove_file(group_file());
}

/// SIGTERM to the whole group (the wrapper and node): the runner freezes a turn
/// in progress and carries on with it after the next start.
fn terminate(child: &mut Child) {
    let group = format!("-{}", child.id());
    let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
    let until = Instant::now() + Duration::from_secs(60);
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
    let _ = child.wait();
}

pub struct Supervisor {
    status: Mutex<Status>,
    child: Mutex<Option<Child>>,
    wanted: AtomicBool,
    /// Increments on each start, so an old loop stops when a new one begins.
    generation: Mutex<u64>,
    helper: Option<PathBuf>,
    on_change: Box<dyn Fn(&Status) + Send + Sync>,
}

impl Supervisor {
    pub fn new(
        helper: Option<PathBuf>,
        on_change: impl Fn(&Status) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(Status::Stopped),
            child: Mutex::new(None),
            wanted: AtomicBool::new(false),
            generation: Mutex::new(0),
            helper,
            on_change: Box::new(on_change),
        })
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, status: Status) {
        *self.status.lock().unwrap() = status.clone();
        (self.on_change)(&status);
    }

    /// Keeps `brigade-runner start` running until stop(), restarting it when it exits.
    pub fn start(self: &Arc<Self>) {
        self.stop();
        self.wanted.store(true, Ordering::SeqCst);
        let generation = {
            let mut g = self.generation.lock().unwrap();
            *g += 1;
            *g
        };
        let this = Arc::clone(self);
        thread::spawn(move || this.supervise(generation));
    }

    fn current(&self, generation: u64) -> bool {
        self.wanted.load(Ordering::SeqCst) && *self.generation.lock().unwrap() == generation
    }

    fn supervise(&self, generation: u64) {
        let mut backoff = Duration::from_secs(2);
        while self.current(generation) {
            let Some(workspace) = workspace().filter(|_| wrapper().exists()) else {
                self.set(Status::NotConnected);
                return;
            };
            stop_orphan();
            if running_elsewhere() {
                self.set(Status::Elsewhere);
                return;
            }
            let spawned = command(wrapper()).and_then(|mut command| {
                if let Some(helper) = &self.helper {
                    command.env("BRIGADE_COMPUTER_USE_APP", helper);
                }
                // Its own process group, so stop() reaches node behind the wrapper.
                command.arg("start").process_group(0).spawn()
            });
            let child = match spawned {
                Ok(child) => child,
                Err(error) => {
                    self.set(Status::Restarting {
                        reason: error.to_string(),
                    });
                    thread::sleep(backoff);
                    continue;
                }
            };
            let started = Instant::now();
            let _ = fs::write(group_file(), child.id().to_string());
            *self.child.lock().unwrap() = Some(child);
            self.set(Status::Running { workspace });
            let code = loop {
                thread::sleep(Duration::from_millis(500));
                let mut slot = self.child.lock().unwrap();
                let Some(child) = slot.as_mut() else { return };
                if let Ok(Some(status)) = child.try_wait() {
                    *slot = None;
                    let _ = fs::remove_file(group_file());
                    break status.code();
                }
            };
            if !self.current(generation) {
                return;
            }
            if code == Some(ALREADY_RUNNING) {
                self.set(Status::Elsewhere);
                return;
            }
            // A runner that ran for a while gets a quick restart; one that keeps failing waits longer.
            backoff = if started.elapsed() > Duration::from_secs(60) {
                Duration::from_secs(2)
            } else {
                (backoff * 2).min(Duration::from_secs(60))
            };
            let reason = code.map_or("stopped".into(), |c| format!("exited with code {c}"));
            self.set(Status::Restarting { reason });
            thread::sleep(backoff);
        }
    }

    pub fn stop(&self) {
        self.wanted.store(false, Ordering::SeqCst);
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            terminate(&mut child);
            let _ = fs::remove_file(group_file());
        }
        if !matches!(self.status(), Status::NotConnected | Status::Elsewhere) {
            self.set(Status::Stopped);
        }
    }

    /// Installs the runner with the API's script (Node.js too when needed), links
    /// it with a dashboard code, then runs it. Blocking: call from a thread.
    pub fn connect(self: &Arc<Self>, api: &str, code: &str) -> Result<(), String> {
        self.stop();
        self.set(Status::Installing);
        let result = (|| {
            let installed = command("sh")
                .and_then(|mut c| {
                    c.args(["-c", "curl -fsSL \"$1/runner/install.sh\" | sh", "sh", api])
                        .status()
                })
                .map_err(|e| e.to_string())?;
            if !installed.success() {
                return Err("The runner could not be installed. See the logs.".to_string());
            }
            let linked = command(wrapper())
                .and_then(|mut c| c.args(["link", code, "--api", api]).status())
                .map_err(|e| e.to_string())?;
            if !linked.success() {
                return Err("This link code did not work: it may have expired. Get a new one in the dashboard.".to_string());
            }
            Ok(())
        })();
        // Linked: run it. Failed: back to whatever this computer was before.
        self.start();
        result
    }
}
