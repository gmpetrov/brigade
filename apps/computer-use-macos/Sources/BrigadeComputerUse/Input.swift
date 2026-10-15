// Mouse and keyboard through CGEvent, in global screen points (top-left origin).
import CoreGraphics
import Foundation

enum Input {
  private static let source = CGEventSource(stateID: .hidSystemState)

  private static func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
  }

  private static func pause(_ seconds: Double = 0.02) {
    Thread.sleep(forTimeInterval: seconds)
  }

  static func move(to point: CGPoint) throws {
    try Permissions.requireAccessibility()
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    pause()
  }

  static func click(at point: CGPoint, button: String, count: Int, modifiers: [String]) throws {
    try Permissions.requireAccessibility()
    let (down, up, mouseButton): (CGEventType, CGEventType, CGMouseButton) =
      switch button {
      case "right": (.rightMouseDown, .rightMouseUp, .right)
      case "middle": (.otherMouseDown, .otherMouseUp, .center)
      case "left": (.leftMouseDown, .leftMouseUp, .left)
      default: throw HelperError("invalid_argument", "unsupported mouse button \(button)")
      }
    let flags = try Keys.flags(modifiers)
    try move(to: point)
    for click in 1...max(1, min(count, 3)) {
      for type in [down, up] {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: mouseButton)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        event?.flags = flags
        post(event)
        pause(0.01)
      }
      pause(0.05)
    }
  }

  static func drag(from start: CGPoint, to end: CGPoint) throws {
    try Permissions.requireAccessibility()
    try move(to: start)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
    pause(0.05)
    let steps = 12
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left))
      pause(0.015)
    }
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left))
    pause()
  }

  static func scroll(at point: CGPoint, direction: String, amount: Int) throws {
    try Permissions.requireAccessibility()
    try move(to: point)
    let lines = Int32(max(1, min(amount, 50)))
    let (vertical, horizontal): (Int32, Int32) =
      switch direction {
      case "up": (lines, 0)
      case "down": (-lines, 0)
      case "left": (0, lines)
      case "right": (0, -lines)
      default: throw HelperError("invalid_argument", "unsupported scroll direction \(direction)")
      }
    post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0))
    pause()
  }

  /// Types text as Unicode, whatever the keyboard layout; a newline presses Return.
  /// One key per character, on the key the current layout types it with (see Layout).
  static func type(_ text: String) throws {
    try Permissions.requireAccessibility()
    let strokes = Layout.strokes()
    let lines = text.components(separatedBy: "\n")
    for (index, line) in lines.enumerated() {
      if index > 0 { try key("return") }
      for character in line {
        // The character's own key when the layout has one; else the character alone.
        let stroke = strokes[character]
        let units = Array(String(character).utf16)
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: stroke?.code ?? 0, keyDown: down)
          event?.flags = stroke?.flags ?? []
          event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
          post(event)
        }
        pause(0.008)
      }
    }
  }

  /// A key or combination: "return", "cmd+n", "cmd+shift+t".
  static func key(_ combination: String) throws {
    try Permissions.requireAccessibility()
    let parts = combination.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let name = parts.last, !name.isEmpty else {
      throw HelperError("invalid_argument", "key is required")
    }
    guard let code = Keys.codes[name] else {
      throw HelperError("invalid_argument", "unsupported key \(name)")
    }
    let flags = try Keys.flags(Array(parts.dropLast()))
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      event?.flags = flags
      post(event)
      pause(0.01)
    }
    pause()
  }
}

enum Keys {
  static func flags(_ modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
      switch modifier.lowercased() {
      case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "alt", "option", "opt": flags.insert(.maskAlternate)
      case "ctrl", "control": flags.insert(.maskControl)
      case "fn": flags.insert(.maskSecondaryFn)
      default: throw HelperError("invalid_argument", "unsupported modifier \(modifier)")
      }
    }
    return flags
  }

  /// Virtual key codes (ANSI layout positions).
  static let codes: [String: CGKeyCode] = {
    var codes: [String: CGKeyCode] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
      "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
      "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
      "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
      "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
      "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
      "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119,
      "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    ]
    let functionKeys: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
    for (index, code) in functionKeys.enumerated() { codes["f\(index + 1)"] = code }
    return codes
  }()
}
