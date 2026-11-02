// `run`: a shell command started by this app, so macOS credits it with this app's
// Accessibility and Screen Recording. macOS asks the app responsible for a process,
// the one that started it: commands in a teammate's own shell belong to Brigade.app,
// which holds neither, so they can't click, type in or read the person's apps. Started
// from here, they can, while the pill shows the teammate's name with Stop.
//
// The command runs in its own process group, stopped as a whole when it ends, times out,
// or the person presses Stop: nothing keeps these permissions once the pill is gone.
import Foundation

enum Run {
  /// The output kept: its end, where errors are.
  static let maxOutput = 100_000
  static let defaultTimeout: Double = 120
  static let maxTimeout: Double = 1800

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
    // A file rather than a pipe: something the command leaves running can't keep the reply waiting.
    let output = NSTemporaryDirectory() + "brigade-run-\(UUID().uuidString).log"
    defer { unlink(output) }

    let group = try spawn(command: command, cwd: directory, env: environment(env), output: output)
    let started = Date()
    var status: Int32 = 0
    var ended: String?
    var signalledAt = Date.distantFuture
    var heldAt = Date.distantPast
    while true {
      let done = waitpid(group, &status, WNOHANG)
      if done == group || (done < 0 && errno != EINTR) { break }
      if ended == nil {
        if Date().timeIntervalSince(started) > limit {
          ended = "timeout"
        } else if Date().timeIntervalSince(heldAt) >= 2 {
          heldAt = Date()
          if !(await hold()) { ended = "stopped" }
        }
        if ended != nil {
          kill(-group, SIGTERM)
          signalledAt = Date()
        }
      } else if Date().timeIntervalSince(signalledAt) > 3 {
        kill(-group, SIGKILL)
      }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    // What it left running in the background stops with it.
    kill(-group, SIGTERM)
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) { kill(-group, SIGKILL) }

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
