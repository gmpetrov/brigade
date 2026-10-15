// The pill at the top of the screen while a teammate uses the computer:
// "● Riley is using your computer  [Stop]". It is left out of screenshots and
// hides itself a few seconds after the last action. There is no Esc shortcut:
// Brigade never lets Esc interrupt a teammate (too easy to press by accident).
import AppKit

@MainActor
final class Indicator {
  private var panel: NSPanel?
  private let label = NSTextField(labelWithString: "")
  private var hideTimer: Timer?
  private let onStop: () -> Void

  init(onStop: @escaping () -> Void) {
    self.onStop = onStop
  }

  func show(_ text: String) {
    let panel = self.panel ?? build()
    label.stringValue = text
    panel.layoutIfNeeded()
    let size = panel.contentView?.fittingSize ?? NSSize(width: 320, height: 36)
    if let screen = NSScreen.main {
      let frame = screen.visibleFrame
      panel.setFrame(
        NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 8, width: size.width, height: size.height),
        display: true)
    }
    panel.orderFrontRegardless()
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
      Task { @MainActor in self?.hide() }
    }
  }

  func hide() {
    hideTimer?.invalidate()
    panel?.orderOut(nil)
  }

  private func build() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 320, height: 36),
      styleMask: [.nonactivatingPanel, .borderless],
      backing: .buffered,
      defer: false)
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false

    let background = NSVisualEffectView()
    background.material = .hudWindow
    background.state = .active
    background.wantsLayer = true
    background.layer?.cornerRadius = 18
    background.layer?.masksToBounds = true

    // Brigade's violet for the status dot.
    let dot = NSView()
    dot.wantsLayer = true
    dot.layer?.backgroundColor = NSColor(red: 0.49, green: 0.36, blue: 0.96, alpha: 1).cgColor
    dot.layer?.cornerRadius = 4
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
    dot.heightAnchor.constraint(equalToConstant: 8).isActive = true

    label.font = .systemFont(ofSize: 13, weight: .medium)
    label.textColor = .labelColor

    let stop = NSButton(title: "Stop", target: self, action: #selector(stopClicked))
    stop.bezelStyle = .rounded
    stop.controlSize = .small

    let row = NSStackView(views: [dot, label, stop])
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 10
    row.edgeInsets = NSEdgeInsets(top: 6, left: 14, bottom: 6, right: 8)
    row.translatesAutoresizingMaskIntoConstraints = false

    background.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: background.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: background.trailingAnchor),
      row.topAnchor.constraint(equalTo: background.topAnchor),
      row.bottomAnchor.constraint(equalTo: background.bottomAnchor),
    ])
    panel.contentView = background
    self.panel = panel
    return panel
  }

  @objc private func stopClicked() {
    hide()
    onStop()
  }
}
