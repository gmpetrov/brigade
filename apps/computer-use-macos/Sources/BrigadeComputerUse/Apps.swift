// Running apps, opening one, and reading an app's interface through the
// Accessibility API (roles, titles, values and frames in screen points).
import AppKit
import ApplicationServices

enum Apps {
  @MainActor
  static func list() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .map { app in
        [
          "name": app.localizedName ?? "",
          "bundleId": app.bundleIdentifier ?? "",
          "pid": Int(app.processIdentifier),
          "active": app.isActive,
          "hidden": app.isHidden,
        ]
      }
  }

  /// A running app by name, bundle id or pid; the frontmost one when none is given.
  @MainActor
  static func find(_ query: String?) throws -> NSRunningApplication {
    let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    guard let query, !query.isEmpty else {
      if let front = NSWorkspace.shared.frontmostApplication { return front }
      throw HelperError("app_not_found", "no app is in front")
    }
    if let pid = Int32(query), let app = running.first(where: { $0.processIdentifier == pid }) { return app }
    let lower = query.lowercased()
    if let app = running.first(where: {
      $0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower
    }) {
      return app
    }
    throw HelperError("app_not_found", "\(query) is not running; open it with open_app first")
  }

  @MainActor
  static func open(_ query: String) async throws -> [String: Any] {
    guard let url = applicationURL(query) else {
      throw HelperError("app_not_found", "no app named \(query) in /Applications, /System/Applications or ~/Applications")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    return ["name": app.localizedName ?? query, "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier)]
  }

  private static func applicationURL(_ query: String) -> URL? {
    if query.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) {
      return url
    }
    let name = query.hasSuffix(".app") ? query : "\(query).app"
    let folders = [
      "/Applications", "/System/Applications", "/System/Applications/Utilities",
      "/Applications/Utilities", "\(NSHomeDirectory())/Applications",
    ]
    for folder in folders {
      let path = "\(folder)/\(name)"
      if FileManager.default.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
    }
    // Case-insensitive match, e.g. "vscode" won't match but "visual studio code" will.
    for folder in folders {
      guard let entries = try? FileManager.default.contentsOfDirectory(atPath: folder) else { continue }
      if let entry = entries.first(where: { $0.lowercased() == name.lowercased() }) {
        return URL(fileURLWithPath: "\(folder)/\(entry)")
      }
    }
    return nil
  }
}

enum Accessibility {
  /// The app's windows (and menu bar when asked) as indented text lines.
  @MainActor
  static func tree(app query: String?, maxDepth: Int, maxNodes: Int, menus: Bool) throws -> [String: Any] {
    try Permissions.requireAccessibility()
    let app = try Apps.find(query)
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1.0)
    var lines: [String] = []
    var count = 0
    var truncated = false

    func visit(_ element: AXUIElement, depth: Int) {
      if count >= maxNodes {
        truncated = true
        return
      }
      count += 1
      lines.append(String(repeating: "  ", count: depth) + describe(element))
      guard depth < maxDepth else { return }
      for child in children(of: element) { visit(child, depth: depth + 1) }
    }

    var tops = elements(root, kAXWindowsAttribute)
    if menus, let bar = attribute(root, kAXMenuBarAttribute) { tops.insert(bar as! AXUIElement, at: 0) }
    for top in tops { visit(top, depth: 0) }
    return [
      "app": app.localizedName ?? "",
      "pid": Int(app.processIdentifier),
      "tree": lines.joined(separator: "\n"),
      "nodes": count,
      "truncated": truncated,
    ]
  }

  private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
  }

  private static func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    (attribute(element, name) as? [AXUIElement]) ?? []
  }

  private static func children(of element: AXUIElement) -> [AXUIElement] {
    elements(element, kAXChildrenAttribute)
  }

  private static func text(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    let string: String
    if let s = value as? String {
      string = s
    } else if let n = value as? NSNumber {
      string = n.stringValue
    } else {
      return nil
    }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    return trimmed.count > 120 ? String(trimmed.prefix(120)) + "…" : trimmed
  }

  private static func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute)
    else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
      AXValueGetValue(size as! AXValue, .cgSize, &extent)
    else { return nil }
    return CGRect(origin: point, size: extent)
  }

  /// `AXButton "Save" value="…" [x,y w×h]` with the parts it has.
  private static func describe(_ element: AXUIElement) -> String {
    var parts = [text(element, kAXRoleAttribute) ?? "?"]
    if let title = text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute) {
      parts.append("\"\(title)\"")
    }
    if let value = text(element, kAXValueAttribute) { parts.append("value=\"\(value)\"") }
    if let enabled = attribute(element, kAXEnabledAttribute) as? Bool, !enabled { parts.append("disabled") }
    if let focused = attribute(element, kAXFocusedAttribute) as? Bool, focused { parts.append("focused") }
    if let frame = frame(element) {
      parts.append("[\(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))×\(Int(frame.height))]")
    }
    return parts.joined(separator: " ")
  }
}
