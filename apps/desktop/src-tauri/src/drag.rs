// The screenshot window has no title bar: the page's "New thread for…" row moves it.
// Tauri's own way (data-tauri-drag-region, then AppKit's performWindowDragWithEvent once
// the page's call arrives) does nothing on macOS 27: AppKit logs "Window move completed
// without beginning", whether the call comes 1 ms or 30 ms after the press. So the app
// moves the window itself: each press in a window is remembered here, the page says it
// fell on its row (`arm`, from capture_drag), and the window follows the mouse until
// it is released.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::sync::Once;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSWindow};
    use objc2_foundation::NSPoint;
    use tauri::WebviewWindow;

    /// A press in a window: which one, and where the mouse is from the window's corner.
    #[derive(Clone, Copy)]
    struct Press {
        window: isize,
        dx: f64,
        dy: f64,
        /// The page said the press is on its row: the mouse's moves move the window.
        armed: bool,
    }

    thread_local! {
        static PRESS: Cell<Option<Press>> = const { Cell::new(None) };
    }

    /// Watches the app's own mouse events, once; on the main thread.
    pub fn watch() {
        static WATCH: Once = Once::new();
        WATCH.call_once(|| {
            let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
                // SAFETY: AppKit hands the monitor a valid event, on the main thread.
                follow(unsafe { event.as_ref() });
                event.as_ptr()
            });
            let mask = NSEventMask::LeftMouseDown
                | NSEventMask::LeftMouseDragged
                | NSEventMask::LeftMouseUp;
            // SAFETY: called on the main thread; the monitor lives as long as the app.
            let monitor =
                unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
            std::mem::forget(monitor);
        });
    }

    fn follow(event: &NSEvent) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        match event.r#type() {
            NSEventType::LeftMouseDown => {
                let press = event.window(mtm).map(|window| {
                    // The press's own point, from the window's bottom-left corner: by now the
                    // mouse may have moved on.
                    let at = event.locationInWindow();
                    Press {
                        window: window.windowNumber(),
                        dx: at.x,
                        dy: at.y,
                        armed: false,
                    }
                });
                PRESS.set(press);
            }
            NSEventType::LeftMouseDragged => {
                let Some(press) = PRESS.get().filter(|p| p.armed) else {
                    return;
                };
                let Some(window) = event
                    .window(mtm)
                    .filter(|w| w.windowNumber() == press.window)
                else {
                    return;
                };
                let mouse = NSEvent::mouseLocation();
                window.setFrameOrigin(NSPoint::new(mouse.x - press.dx, mouse.y - press.dy));
            }
            _ => PRESS.set(None),
        }
    }

    /// The page's press was on its row: the window follows the mouse while it stays down.
    /// On the main thread (capture_drag is a command without async).
    pub fn arm(window: &WebviewWindow) {
        let Ok(ns_window) = window.ns_window() else {
            return;
        };
        // SAFETY: Tauri's window handle is an NSWindow, used on the main thread.
        let number = unsafe { &*(ns_window as *const NSWindow) }.windowNumber();
        let down = NSEvent::pressedMouseButtons() & 1 != 0;
        if let Some(press) = PRESS.get().filter(|p| p.window == number && down) {
            PRESS.set(Some(Press {
                armed: true,
                ..press
            }));
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{arm, watch};

#[cfg(not(target_os = "macos"))]
pub fn watch() {}

/// Elsewhere Tauri's own drag works.
#[cfg(not(target_os = "macos"))]
pub fn arm(window: &tauri::WebviewWindow) {
    let _ = window.start_dragging();
}
