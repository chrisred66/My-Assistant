// Hides the desktop usage ball and the desktop pet while another application is full screen (a game, a video, a
// presentation, a browser in F11) or in a borderless window covering its whole monitor, and shows them again after.
// Checked about once a second: the foreground window belongs to another process and covers its monitor (taskbar
// included) without being an ordinary maximised window, or Windows reports a full-screen app (D3D, presentation mode).
// Only the windows this hid are shown again, so a ball or pet switched off meanwhile stays off.

use tauri::{AppHandle, Manager};

const WINDOWS: [&str; 2] = ["ball", "pet"];

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut hidden: Vec<&'static str> = Vec::new();
        let mut was_full = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));
            let full = other_app_full_screen();
            if full == was_full {
                continue;
            }
            was_full = full;
            for label in WINDOWS {
                let Some(w) = app.get_webview_window(label) else { continue };
                if full {
                    if w.is_visible().unwrap_or(false) && w.hide().is_ok() {
                        hidden.push(label);
                    }
                } else if hidden.contains(&label) {
                    let _ = w.show();
                }
            }
            if !full {
                hidden.clear();
            }
        }
    });
}

#[cfg(windows)]
fn other_app_full_screen() -> bool {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsZoomed, GWL_STYLE, WS_CAPTION,
    };

    unsafe {
        // Exclusive full screen and presentation mode, as Windows reports them.
        let mut state = 0;
        if SHQueryUserNotificationState(&mut state) == 0
            && (state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE)
        {
            return true;
        }

        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == GetCurrentProcessId() {
            return false; // our own windows
        }
        // The desktop and the shell aren't "applications".
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return false;
        }

        let mut rect = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return false;
        }
        let m = info.rcMonitor;
        let covers = rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom;
        // A maximised window with a title bar (e.g. with an auto-hiding taskbar) isn't full screen.
        let captioned = (GetWindowLongW(hwnd, GWL_STYLE) as u32) & WS_CAPTION == WS_CAPTION;
        covers && !(captioned && IsZoomed(hwnd) != 0)
    }
}

#[cfg(not(windows))]
fn other_app_full_screen() -> bool {
    false
}
