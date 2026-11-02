// scripts/test-sweep.sh builds this into a small app and opens it, so that, like Brigade Computer
// Use, it is its own responsible process: then Run's sweep reaches what a command detached.
import Foundation

let directory = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/brigade-sweep-test"
var failures: [String] = []
func check(_ name: String, _ ok: Bool) {
  print(ok ? "PASS" : "FAIL", name)
  if !ok { failures.append(name) }
}

let done = DispatchSemaphore(value: 0)
Task {
  defer { done.signal() }
  check("opened as its own responsible process", Run.ownsItsCommands)
  // A direct child of the app, as screencapture is for Brigade.app's screenshot: spared.
  let direct = Process()
  direct.executableURL = URL(fileURLWithPath: "/bin/sleep")
  direct.arguments = ["300"]
  try? direct.run()
  Run.spare(direct.processIdentifier)
  // A daemon that double-forks, calls setsid, is reparented to launchd and ignores SIGTERM.
  let pidFile = "\(directory)/daemon.pid"
  let daemon = """
    /usr/bin/python3 -c '
    import os, signal, time
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            open("\(pidFile)", "w").write(str(os.getpid()))
            time.sleep(300)
        os._exit(0)
    '; sleep 0.5; echo launched
    """
  do {
    let result = try await Run.run(command: daemon, cwd: nil, env: [:], timeout: 30, hold: { true })
    check("the command ran", (result["output"] as? String) == "launched\n")
  } catch {
    check("the command ran: \(error)", false)
  }
  if let text = try? String(contentsOfFile: pidFile, encoding: .utf8), let pid = pid_t(text) {
    check("the detached daemon is gone when run replies", kill(pid, 0) != 0)
    kill(pid, SIGKILL)
  } else {
    check("the daemon started", false)
  }
  check("the app's own direct child is spared", kill(direct.processIdentifier, 0) == 0)
  // A command whose shell leaves its group for the app's: stopped by pid at its timeout.
  let rootFile = "\(directory)/root.pid"
  let started = Date()
  let moved = try? await Run.run(
    command: """
      exec /usr/bin/python3 -c 'import os, time; open("\(rootFile)", "w").write(str(os.getpid())); \
      os.setpgid(0, os.getpgid(os.getppid())); time.sleep(60)'
      """,
    cwd: nil, env: [:], timeout: 1, hold: { true })
  check("a command that left its group times out", moved?["timedOut"] as? Bool == true && Date().timeIntervalSince(started) < 6)
  if let text = try? String(contentsOfFile: rootFile, encoding: .utf8), let pid = pid_t(text) {
    check("and is gone", kill(pid, 0) != 0)
    kill(pid, SIGKILL)
  }
  direct.terminate()
}
done.wait()
try? (failures.isEmpty ? "ok" : failures.joined(separator: "\n")).write(
  toFile: "\(directory)/result", atomically: true, encoding: .utf8)
