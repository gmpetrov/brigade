// Screenshots with ScreenCaptureKit, in screen points: a point in the image is
// the point on screen at `origin` plus its position, the coordinates the input
// actions take. This app's own windows (the indicator) are left out.
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Permissions {
  static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }
  static var accessibility: Bool { AXIsProcessTrusted() }

  private static var askedScreen = false
  private static var askedAccessibility = false

  /// Throws with what the person has to turn on; asks macOS to prompt them once per launch.
  static func requireScreenRecording() throws {
    if screenRecording { return }
    if !askedScreen {
      askedScreen = true
      CGRequestScreenCaptureAccess()
    }
    throw HelperError(
      "permission_missing",
      "Screen Recording is off for Brigade Computer Use. Ask the person to turn it on in System Settings → Privacy & Security → Screen Recording (macOS may ask them to quit and reopen the app), then try again."
    )
  }

  static func requireAccessibility() throws {
    if accessibility { return }
    if !askedAccessibility {
      askedAccessibility = true
      let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
      _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
    }
    throw HelperError(
      "permission_missing",
      "Accessibility is off for Brigade Computer Use. Ask the person to turn it on in System Settings → Privacy & Security → Accessibility, then try again."
    )
  }
}

enum Screen {
  /// Displays with the main one first, as numbered in `display`.
  private static func displays() async throws -> (SCShareableContent, [SCDisplay]) {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let sorted = content.displays.sorted { a, _ in CGDisplayIsMain(a.displayID) != 0 }
    return (content, sorted)
  }

  static func screenshot(display index: Int, to path: String) async throws -> [String: Any] {
    try Permissions.requireScreenRecording()
    let (content, displays) = try await displays()
    guard index >= 0, index < displays.count else {
      throw HelperError("invalid_argument", "display \(index) does not exist; there are \(displays.count)")
    }
    let display = displays[index]
    let mine = content.applications.filter { $0.processID == getpid() }
    let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
    let config = SCStreamConfiguration()
    // In points, not pixels: smaller for the model, and the same units as clicks.
    config.width = display.width
    config.height = display.height
    config.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    try writePNG(image, to: path)
    let bounds = CGDisplayBounds(display.displayID)
    return [
      "path": path,
      "width": image.width,
      "height": image.height,
      "origin": ["x": bounds.origin.x, "y": bounds.origin.y],
      "display": index,
      "displays": displays.count,
    ]
  }

  private static func writePNG(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard
      let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw HelperError("failed", "cannot write \(path)") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw HelperError("failed", "cannot write \(path)") }
  }
}
