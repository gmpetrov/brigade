// Brigade Computer Use: a menu-bar-less helper app that holds Screen Recording
// and Accessibility for Brigade, so the grants belong to it rather than to the
// terminal that started the runner. The runner launches it with `open` (macOS
// then treats it as its own app) and talks to it over a Unix socket in
// ~/.brigade/computer-use, authenticated with the token written beside it.
import AppKit
import Foundation

let version = "2"

/// Who is using the computer: one teammate turn at a time, which the person can stop.
@MainActor
final class Sessions {
  private struct Active {
    let id: String
    let label: String
    var last: Date
  }

  private var active: Active?
  private var stopped: Set<String> = []
  /// Turns the runner ended (the person interrupted the teammate): their command stops.
  private var cancelled: Set<String> = []
  private lazy var indicator = Indicator { [weak self] in self?.stop() }

  /// Before each action: refuses a stopped turn, or another turn while one is acting.
  func begin(_ session: [String: Any]?) throws {
    guard let id = session?["id"] as? String, !id.isEmpty else {
      throw HelperError("invalid_request", "session.id is required")
    }
    let label = (session?["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "A Brigade teammate"
    if stopped.contains(id) {
      throw HelperError(
        "stopped",
        "The person pressed Stop on the computer-use indicator. Don't use the computer again in this turn: say so, and wait for their next message.")
    }
    if let current = active, current.id != id, Date().timeIntervalSince(current.last) < 15 {
      throw HelperError("busy", "\(current.label) is using this computer right now. Try again in a moment.")
    }
    active = Active(id: id, label: label, last: Date())
    indicator.show("\(label) is using your computer")
  }

  /// While a command runs (`run`): keeps its turn the one using the computer, and the pill up.
  /// False once the person pressed Stop or the runner cancelled the turn: the command stops.
  func hold(_ id: String) -> Bool {
    guard let current = active, current.id == id, !stopped.contains(id), !cancelled.contains(id) else {
      return false
    }
    active?.last = Date()
    indicator.show("\(current.label) is using your computer")
    return true
  }

  /// The runner ended this turn: its command stops, and the pill goes.
  func cancel(_ id: String) {
    cancelled.insert(id)
    if active?.id == id {
      active = nil
      indicator.hide()
    }
  }

  func stop() {
    if let current = active { stopped.insert(current.id) }
    active = nil
    indicator.hide()
  }
}

func number(_ value: Any?) -> Double? {
  (value as? NSNumber)?.doubleValue
}

func point(_ params: [String: Any], _ x: String = "x", _ y: String = "y") throws -> CGPoint {
  guard let px = number(params[x]), let py = number(params[y]) else {
    throw HelperError("invalid_argument", "\(x) and \(y) are required")
  }
  return CGPoint(x: px, y: py)
}

@MainActor
func makeHandler(_ sessions: Sessions) -> Handler {
  return { method, params in
    if method == "status" {
      let screenRecording = await Permissions.hasScreenRecording()
      return await MainActor.run {
        [
          "version": version,
          "screenRecording": screenRecording,
          "accessibility": Permissions.accessibility,
        ] as [String: Any]
      }
    }
    // The person's own screenshot, from Brigade.app: no teammate turn behind it.
    if method == "capture" {
      guard let path = params["path"] as? String, path.hasPrefix("/") else {
        throw HelperError("invalid_argument", "an absolute path is required")
      }
      return try await Capture.interactive(to: path)
    }
    if method == "cancel" {
      guard let id = (params["session"] as? [String: Any])?["id"] as? String else {
        throw HelperError("invalid_request", "session.id is required")
      }
      await MainActor.run { sessions.cancel(id) }
      return ["ok": true]
    }
    try await MainActor.run { try sessions.begin(params["session"] as? [String: Any]) }
    switch method {
    case "screenshot":
      guard let path = params["path"] as? String, path.hasPrefix("/") else {
        throw HelperError("invalid_argument", "an absolute path is required")
      }
      return try await Screen.screenshot(display: Int(number(params["display"]) ?? 0), to: path)
    case "move":
      try Input.move(to: try point(params))
      return ["ok": true]
    case "click":
      try Input.click(
        at: try point(params),
        button: params["button"] as? String ?? "left",
        count: Int(number(params["count"]) ?? 1),
        modifiers: params["modifiers"] as? [String] ?? [])
      return ["ok": true]
    case "drag":
      try Input.drag(from: try point(params, "fromX", "fromY"), to: try point(params, "toX", "toY"))
      return ["ok": true]
    case "scroll":
      try Input.scroll(
        at: try point(params),
        direction: params["direction"] as? String ?? "down",
        amount: Int(number(params["amount"]) ?? 5))
      return ["ok": true]
    case "type":
      guard let text = params["text"] as? String else { throw HelperError("invalid_argument", "text is required") }
      try Input.type(text)
      return ["ok": true]
    case "key":
      guard let key = params["key"] as? String else { throw HelperError("invalid_argument", "key is required") }
      try Input.key(key)
      return ["ok": true]
    case "apps":
      return await MainActor.run { ["apps": Apps.list()] }
    case "open_app":
      guard let app = params["app"] as? String, !app.isEmpty else {
        throw HelperError("invalid_argument", "app is required")
      }
      return try await Apps.open(app)
    case "ui_tree":
      return try await MainActor.run {
        try Accessibility.tree(
          app: params["app"] as? String,
          maxDepth: Int(number(params["maxDepth"]) ?? 12),
          maxNodes: Int(number(params["maxNodes"]) ?? 400),
          menus: params["menus"] as? Bool ?? false)
      }
    case "run":
      guard let command = params["command"] as? String, !command.isEmpty else {
        throw HelperError("invalid_argument", "command is required")
      }
      // What the command is run here for; without it, it would fail further on with less to go by.
      try Permissions.requireAccessibility()
      let id = (params["session"] as? [String: Any])?["id"] as? String ?? ""
      return try await Run.run(
        command: command,
        cwd: params["cwd"] as? String,
        env: params["env"] as? [String: String] ?? [:],
        timeout: number(params["timeout"]),
        hold: { await MainActor.run { sessions.hold(id) } })
    default:
      throw HelperError("unknown_method", "unknown method \(method)")
    }
  }
}

/// ~/.brigade/computer-use, readable by this user only.
func prepareDirectory() throws -> URL {
  let directory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".brigade/computer-use", isDirectory: true)
  try FileManager.default.createDirectory(
    at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  chmod(directory.path, 0o700)
  return directory
}

func writeToken(in directory: URL) throws -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    throw HelperError("token", "no random bytes")
  }
  let token = bytes.map { String(format: "%02x", $0) }.joined()
  let file = directory.appendingPathComponent("token")
  FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
  try token.write(to: file, atomically: false, encoding: .utf8)
  chmod(file.path, 0o600)
  return token
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Writing a reply to a runner that went away is an error to ignore, not a reason to quit.
signal(SIGPIPE, SIG_IGN)
// Quit with SIGTERM (Brigade.app restarts this app after an update): a command running goes first.
signal(SIGTERM, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
terminate.setEventHandler {
  Run.shutdown()
  exit(0)
}
terminate.resume()
MainActor.assumeIsolated {
  do {
    let directory = try prepareDirectory()
    let token = try writeToken(in: directory)
    let server = SocketServer(
      path: directory.appendingPathComponent("sock").path, token: token, handle: makeHandler(Sessions()))
    try server.start()
    // Ask for both permissions on the first launch, so the person grants them once, up front.
    _ = Permissions.screenRecording || CGRequestScreenCaptureAccess()
    if !Permissions.accessibility { try? Permissions.requireAccessibility() }
  } catch {
    FileHandle.standardError.write("brigade-computer-use: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
}
app.run()
