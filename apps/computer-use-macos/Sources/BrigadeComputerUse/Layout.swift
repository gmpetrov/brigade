// Which key (and Shift/Option) types each character on the current keyboard
// layout. Chromium apps (VS Code, Chrome, Slack) ignore key events that carry
// only a character; they need the real key, as a person's typing has.
import Carbon
import CoreGraphics

enum Layout {
  typealias Stroke = (code: CGKeyCode, flags: CGEventFlags)

  /// Built on the main thread, where the text input APIs belong.
  static func strokes() -> [Character: Stroke] {
    Thread.isMainThread ? build() : DispatchQueue.main.sync { build() }
  }

  private static func build() -> [Character: Stroke] {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return [:] }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    // Plain keys first, so a character reachable without modifiers keeps that key.
    let modifiers: [(UInt32, CGEventFlags)] = [
      (0, []),
      (UInt32(shiftKey >> 8) & 0xFF, .maskShift),
      (UInt32(optionKey >> 8) & 0xFF, .maskAlternate),
      (UInt32((shiftKey | optionKey) >> 8) & 0xFF, [.maskShift, .maskAlternate]),
    ]
    var strokes: [Character: Stroke] = [:]
    data.withUnsafeBytes { raw in
      guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
      for (state, flags) in modifiers {
        for code in 0..<128 {
          var dead: UInt32 = 0
          var length = 0
          var chars = [UniChar](repeating: 0, count: 4)
          let status = UCKeyTranslate(
            layout, UInt16(code), UInt16(kUCKeyActionDown), state, UInt32(LMGetKbdType()),
            OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
          guard status == noErr, length == 1,
            let character = String(utf16CodeUnits: chars, count: 1).first,
            !character.isNewline, strokes[character] == nil
          else { continue }
          strokes[character] = (CGKeyCode(code), flags)
        }
      }
    }
    return strokes
  }
}
