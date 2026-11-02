// Esc closes the screenshot window, as its red button does: it only hides, the draft stays.
// The page closes it itself (capture-draft.tsx), after a menu or the image preview open in
// it, which take Esc first. But the page hears Esc only while the webview has the keyboard;
// a window brought up by the shortcut or the menu can be in front with the keyboard
// elsewhere in it, and Esc did nothing. So the app watches its own Esc presses: one in the
// window while the webview does not have the keyboard closes the window here.

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::Once;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, NSObjectProtocol};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSView};
    use tauri::{AppHandle, Manager};

    /// Esc's key code on every Mac keyboard.
    const ESCAPE: u16 = 53;

    /// Watches the app's own key presses, once; on the main thread.
    pub fn watch(app: &AppHandle, label: &'static str) {
        static WATCH: Once = Once::new();
        let app = app.clone();
        WATCH.call_once(move || {
            let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                // SAFETY: AppKit hands the monitor a valid event, on the main thread.
                if closes(&app, label, unsafe { event.as_ref() }) {
                    // Taken: nothing else gets this Esc.
                    std::ptr::null_mut()
                } else {
                    event.as_ptr()
                }
            });
            // SAFETY: called on the main thread; the monitor lives as long as the app.
            let monitor = unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
            };
            std::mem::forget(monitor);
        });
    }

    /// An Esc alone, in the window, while its webview does not have the keyboard: the window
    /// hides. Any other press goes on as usual, to the page when it has the keyboard.
    fn closes(app: &AppHandle, label: &str, event: &NSEvent) -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        if event.keyCode() != ESCAPE {
            return false;
        }
        let held = NSEventModifierFlags::Shift
            | NSEventModifierFlags::Control
            | NSEventModifierFlags::Option
            | NSEventModifierFlags::Command;
        if event.modifierFlags().intersects(held) {
            return false;
        }
        let Some(window) = app.get_webview_window(label) else {
            return false;
        };
        let Some(ns_window) = event.window(mtm) else {
            return false;
        };
        if window.ns_window().ok() != Some(Retained::as_ptr(&ns_window) as *mut c_void) {
            return false;
        }
        if webview_has_keyboard(&ns_window) {
            return false;
        }
        let _ = window.hide();
        true
    }

    /// Whether the window's keyboard is in its web view (WKWebView, or a view inside it).
    fn webview_has_keyboard(window: &objc2_app_kit::NSWindow) -> bool {
        let Some(web) = AnyClass::get(c"WKWebView") else {
            return false;
        };
        let Some(responder) = window.firstResponder() else {
            return false;
        };
        let Ok(view) = responder.downcast::<NSView>() else {
            return false;
        };
        let mut view = Some(view);
        while let Some(v) = view {
            if v.isKindOfClass(web) {
                return true;
            }
            // SAFETY: a view of the window, read on the main thread.
            view = unsafe { v.superview() };
        }
        false
    }
}

#[cfg(target_os = "macos")]
pub use imp::watch;

/// Elsewhere the page takes Esc on its own.
#[cfg(not(target_os = "macos"))]
pub fn watch(_app: &tauri::AppHandle, _label: &'static str) {}
