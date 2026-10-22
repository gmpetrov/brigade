fn main() {
    // The app's commands get permissions (allow-setup-state, …): the capture window's page is
    // the dashboard, a remote origin, which reaches only the commands a capability grants it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "setup_state",
            "setup_action",
            "capture_list",
            "capture_read",
            "capture_remove",
            "capture_clear",
            "capture_hide",
            "capture_sign_in",
        ]),
    ))
    .expect("failed to run tauri-build");
}
