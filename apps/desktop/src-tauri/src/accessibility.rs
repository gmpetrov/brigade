// Accessibility for the commands teammates run on this Mac. macOS asks the app
// "responsible" for a process: for the runner and everything it starts (a shell,
// agent-desktop, osascript with System Events…) that is Brigade.app, which starts
// the runner. So those commands can click, type and read windows only once
// Brigade itself is allowed. Brigade Computer Use holds its own permission, for
// the computer_* tools only.
//
// Brigade never asks for it on its own: a teammate asks when a command needs it
// (brigade://accessibility, which the runner opens), and the setup checklist shows it.

pub const SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::c_void;

    pub type Boolean = u8;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> Boolean;
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> Boolean;
        pub static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub static kCFBooleanTrue: *const c_void;
        // Structs whose address CFDictionaryCreate takes.
        pub static kCFTypeDictionaryKeyCallBacks: u8;
        pub static kCFTypeDictionaryValueCallBacks: u8;
        pub fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        pub fn CFRelease(cf: *const c_void);
    }
}

/// Whether Brigade, and so what it starts, has Accessibility. Checked live: macOS answers
/// for the permission as it is now, without restarting Brigade.
#[cfg(target_os = "macos")]
pub fn trusted() -> bool {
    unsafe { ffi::AXIsProcessTrusted() != 0 }
}

/// Asks macOS for it: when missing, macOS shows its own request and adds Brigade to the list in
/// Privacy & Security → Accessibility (turned off), which is what the person turns on.
#[cfg(target_os = "macos")]
fn prompt() -> bool {
    unsafe {
        let keys = [ffi::kAXTrustedCheckOptionPrompt];
        let values = [ffi::kCFBooleanTrue];
        let options = ffi::CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &ffi::kCFTypeDictionaryKeyCallBacks as *const u8 as *const _,
            &ffi::kCFTypeDictionaryValueCallBacks as *const u8 as *const _,
        );
        let trusted = ffi::AXIsProcessTrustedWithOptions(options) != 0;
        if !options.is_null() {
            ffi::CFRelease(options);
        }
        trusted
    }
}

#[cfg(not(target_os = "macos"))]
pub fn trusted() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn prompt() -> bool {
    false
}

/// What a teammate's request does: nothing when it's already allowed; otherwise macOS's request
/// and the list it's turned on in, with Brigade in it. Returns whether it's allowed.
pub fn request(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_opener::OpenerExt;
    if prompt() {
        return true;
    }
    let _ = app.opener().open_url(SETTINGS, None::<&str>);
    false
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    // Run from a shell under Brigade.app, these answer for Brigade: both agree, and asking
    // when it's already allowed shows nothing.
    #[test]
    fn check_and_request_agree() {
        assert_eq!(super::trusted(), super::prompt());
    }
}
