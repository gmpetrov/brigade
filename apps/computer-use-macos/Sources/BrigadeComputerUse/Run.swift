// `run`: a shell command started by this app, so macOS credits it with this app's
// Accessibility and Screen Recording. macOS asks the app responsible for a process,
// the one that started it: commands in a teammate's own shell belong to Brigade.app,
// which holds neither, so they can't click, type in or read the person's apps. Started
// from here, they can, while the pill shows the teammate's name with Stop.
//
// When it ends, times out, or the person presses Stop, everything that carries this app's
// permissions because of it stops too: its shell (by pid), its process group, and any
// process macOS counts this app responsible for, which a process keeps when it detaches (setsid, a double fork,
// reparented to launchd). Nothing keeps these permissions once the pill is gone.
import Foundation

enum Run {
  /// The output kept: its end, where errors are.
  static let maxOutput = 100_000
  static let defaultTimeout: Double = 120
  static let maxTimeout: Double = 1800

  /// The command running now: its shell's pid, which is also its process group's id, 0 while it
  /// starts. One at a time, so that what is swept when it ends is its own.
  private static var running: pid_t?
  /// Whether that shell is yet to be reaped: until then its pid is its own, so it is signalled by
  /// pid too, wherever it went (a command can leave its group for this app's, with setpgid).
  private static var rootLive = false
  /// This app's own children that aren't commands (screencapture): never swept.
  private static var spared: Set<pid_t> = []
  private static let lock = NSLock()

  static func run(
    command: String,
    cwd: String?,
    env: [String: String],
    timeout: Double?,
    hold: @escaping () async -> Bool
  ) async throws -> [String: Any] {
    let directory = cwd ?? NSHomeDirectory()
    var isDirectory: ObjCBool = false
    guard directory.hasPrefix("/"), FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory),
      isDirectory.boolValue
    else {
      throw HelperError("invalid_argument", "cwd must be an existing absolute directory: \(directory)")
    }
    let limit = min(max(timeout ?? defaultTimeout, 1), maxTimeout)
    try claim()
    defer { release() }
    // A file rather than a pipe: something the command leaves running can't keep the reply waiting.
    let output = NSTemporaryDirectory() + "brigade-run-\(UUID().uuidString).log"
    defer { unlink(output) }

    let root = try spawn(command: command, cwd: directory, env: environment(env), output: output)
    lock.withLock {
      running = root
      rootLive = true
    }
    let started = Date()
    var status: Int32 = 0
    var ended: String?
    var signalledAt = Date.distantFuture
    var heldAt = Date.distantPast
    while true {
      let done = waitpid(root, &status, WNOHANG)
      if done == root || (done < 0 && errno != EINTR) { break }
      if ended == nil {
        if Date().timeIntervalSince(started) > limit {
          ended = "timeout"
        } else if Date().timeIntervalSince(heldAt) >= 2 {
          heldAt = Date()
          if !(await hold()) { ended = "stopped" }
        }
        if ended != nil {
          _ = send(SIGTERM, group: root, root: root)
          signalledAt = Date()
        }
      } else if Date().timeIntervalSince(signalledAt) > 3 {
        _ = send(SIGKILL, group: root, root: root)
      }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    lock.withLock { rootLive = false }
    // What it left running stops with it, before the reply: nothing is left to a timer that
    // would go if this app did.
    sweep(group: root, root: nil)

    let (text, truncated) = tail(of: output)
    if ended == "stopped" {
      throw HelperError(
        "stopped",
        "The person pressed Stop on the computer-use indicator, which stopped the command. Don't use the computer again in this turn: say so, and wait for their next message."
      )
    }
    var result: [String: Any] = [
      "output": text,
      "seconds": (Date().timeIntervalSince(started) * 10).rounded() / 10,
    ]
    // waitpid's status: the low 7 bits are the signal that ended it, else the exit code is above them.
    let signal = status & 0x7f
    if signal == 0 { result["exitCode"] = (status >> 8) & 0xff } else { result["signal"] = signal }
    if truncated { result["truncated"] = true }
    if ended == "timeout" { result["timedOut"] = true }
    return result
  }

  private static func claim() throws {
    try lock.withLock {
      if running != nil {
        throw HelperError(
          "busy", "Another command is running through Brigade Computer Use. Wait for it to end, then try again.")
      }
      running = 0
    }
  }

  private static func release() {
    lock.withLock {
      running = nil
      rootLive = false
    }
  }

  /// For this app's own children that aren't commands (screencapture): the sweep leaves them.
  static func spare(_ pid: pid_t) {
    lock.withLock { _ = spared.insert(pid) }
  }

  static func unspare(_ pid: pid_t) {
    lock.withLock { _ = spared.remove(pid) }
  }

  /// Before this app quits (an update restarts it, or it quits to pick up Screen Recording):
  /// the command running and what it left go first, rather than keep this app's permissions.
  static func shutdown() {
    let (group, live) = lock.withLock { (running ?? 0, rootLive) }
    sweep(group: group, root: live ? group : nil)
  }

  /// Stops the command: `root`, its shell while not reaped, the process group `group` (0: none)
  /// and the strays. SIGTERM first so that a recorder can finish its file, then SIGKILL for what is
  /// left 2 seconds later. Returns once nothing is left.
  static func sweep(group: pid_t, root: pid_t?) {
    guard send(SIGTERM, group: group, root: root) else { return }
    let until = Date().addingTimeInterval(2)
    while Date() < until {
      usleep(100_000)
      if !send(0, group: group, root: root) { return }
    }
    for _ in 0..<20 {
      if !send(SIGKILL, group: group, root: root) { return }
      usleep(50_000)
    }
  }

  /// Sends `sig` to the command's shell (by pid, wherever its group went), its process group and
  /// the strays; whether there was anything to send it to.
  private static func send(_ sig: Int32, group: pid_t, root: pid_t?) -> Bool {
    var left = false
    if let root, root > 0, live(root) {
      kill(root, sig)
      left = true
    }
    // Never this app's own group (kill(-0) would be).
    if group > 0, group != getpgrp(), kill(-group, sig) == 0 { left = true }
    for pid in strays() where kill(pid, sig) == 0 { left = true }
    return left
  }

  /// Running, not a zombie waiting to be reaped.
  private static func live(_ pid: pid_t) -> Bool {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size && info.pbi_status != UInt32(SZOMB)
  }

  private typealias ResponsibleFor = @convention(c) (pid_t) -> pid_t
  /// The pid macOS asks about a process's permissions (private, in libsystem since macOS 10.14).
  private static let responsibleFor: ResponsibleFor? = dlsym(
    UnsafeMutableRawPointer(bitPattern: -2),  // RTLD_DEFAULT
    "responsibility_get_pid_responsible_for_pid"
  ).map { unsafeBitCast($0, to: ResponsibleFor.self) }

  /// Whether macOS counts this app responsible for itself, and so for its commands: true when
  /// opened as an app (with `open`), false under `swift test` or started from a terminal.
  static var ownsItsCommands: Bool {
    responsibleFor.map { $0(getpid()) == getpid() } ?? false
  }

  /// The processes that hold this app's permissions besides itself and the children it spares
  /// (screencapture for Brigade.app's screenshot). None when this app isn't its own responsible
  /// process (under `swift test`, or started from a terminal): its commands then hold another
  /// app's permissions, not this one's.
  static func strays() -> [pid_t] {
    let me = getpid()
    guard ownsItsCommands, let responsibleFor else { return [] }
    let spared = lock.withLock { self.spared }
    var pids = [pid_t](repeating: 0, count: Int(max(proc_listallpids(nil, 0), 0)) * 2 + 64)
    let count = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    return pids.prefix(Int(max(count, 0))).filter { pid in
      pid > 1 && pid != me && !spared.contains(pid) && responsibleFor(pid) == me && live(pid)
    }
  }

  /// The person's basics, then what the runner passes (its PATH, LANG…).
  static func environment(_ given: [String: String]) -> [String: String] {
    var env = [
      "HOME": NSHomeDirectory(),
      "USER": NSUserName(),
      "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "LANG": "en_US.UTF-8",
    ]
    env.merge(given) { _, new in new }
    return env
  }

  /// `zsh -c command` in a new process group (its pid), with nothing of this app's open files but
  /// stdin from /dev/null and stdout and stderr to `output`.
  static func spawn(command: String, cwd: String, env: [String: String], output: String) throws -> pid_t {
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&actions, 1, output, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    posix_spawn_file_actions_adddup2(&actions, 1, 2)
    posix_spawn_file_actions_addchdir_np(&actions, cwd)

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // CLOEXEC_DEFAULT: the command doesn't inherit the runner's socket or any other descriptor.
    // SETSIGMASK and SETSIGDEF: nor this thread's blocked signals (a Dispatch thread blocks
    // SIGTERM, which would leave the command deaf to Stop and to its timeout).
    posix_spawnattr_setflags(
      &attributes,
      Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))
    posix_spawnattr_setpgroup(&attributes, 0)
    var none = sigset_t()
    sigemptyset(&none)
    posix_spawnattr_setsigmask(&attributes, &none)
    var all = sigset_t()
    sigfillset(&all)
    posix_spawnattr_setsigdefault(&attributes, &all)

    let argv = ["/bin/zsh", "-c", command].map { strdup($0) } + [nil]
    let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
      argv.forEach { free($0) }
      envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let code = posix_spawn(&pid, "/bin/zsh", &actions, &attributes, argv, envp)
    guard code == 0 else {
      throw HelperError("failed", "The command could not start: \(String(cString: strerror(code)))")
    }
    return pid
  }

  static func tail(of path: String) -> (String, Bool) {
    guard let handle = FileHandle(forReadingAtPath: path) else { return ("", false) }
    defer { try? handle.close() }
    let size = (try? handle.seekToEnd()) ?? 0
    let truncated = size > UInt64(maxOutput)
    try? handle.seek(toOffset: truncated ? size - UInt64(maxOutput) : 0)
    let data = (try? handle.readToEnd()) ?? Data()
    return (String(decoding: data, as: UTF8.self), truncated)
  }
}
