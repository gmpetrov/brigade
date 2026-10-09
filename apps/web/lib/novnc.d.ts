// The part of noVNC's RFB client the desktop view uses. The package ships no types.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: { password?: string }; shared?: boolean; wsProtocols?: string[] },
    )
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    focusOnClick: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(options?: FocusOptions): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    clipboardPasteFrom(text: string): void
  }
}
