# Port baseline

The reference is `e5907d2be8d43309d5f3b648735e08dc584dd84b`, merged into local and remote `main` on 2026-09-06. Implementation uses `codex/tauri-react-port`. The existing `codex/tauri-port` branch was preserved.

React and TypeScript remain the UI. Electron remains the default desktop. The Node NAS, mobile, and TV applications retain their launch commands. Tauri shares Electron's `LoomTV/loomtv.sqlite` database and application settings, while its active-profile selection uses the separate `desktop-tauri` device row.

The supplied specification is design input. Its instructions to execute tests do not override the user's standing instruction to run tests only on request. No baseline tests or native playback checks have been executed. A successful build is not proof of behavior or platform parity.

The inventory records tracked paths, not completed behavior reviews. Rust dependencies and platform support require review as implementation progresses.
