// Hides the desktop usage ball and the desktop pet while another application is full screen (a game, a video, a
// presentation, a browser in F11) or in a borderless window covering its whole monitor, and shows them again after.
// Checked about once a second: the foreground window belongs to another process and covers its monitor (taskbar
// included) without being an ordinary maximised window, or Windows reports a full-screen app (D3D, presentation mode).
// Only the windows this hid are shown again, so a ball or pet switched off meanwhile stays off.
// The same loop reports the foreground app ("foreground-app" event: its exe and whether it's a web browser), which the
// pet uses to play with the ball while you browse.

use tauri::{AppHandle, Emitter, Manager};

/// The app in front: exe name (lower case) and whether it's a web browser.
#[derive(Clone, serde::Serialize, PartialEq)]
pub struct Foreground {
    exe: String,
    browser: bool,
}

const BROWSERS: [&str; 20] = [
    "msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe", "chromium.exe",
    "iexplore.exe", "whale.exe", "browser.exe", "360se.exe", "360chrome.exe", "qqbrowser.exe", "sogouexplorer.exe",
    "2345explorer.exe", "liebao.exe", "maxthon.exe", "floorp.exe", "librewolf.exe",
];

/// For the pet on start-up (afterwards it follows the event).
pub fn foreground() -> Foreground {
    let exe = foreground_exe().unwrap_or_default();
    Foreground { browser: BROWSERS.contains(&exe.as_str()), exe }
}

const WINDOWS: [&str; 2] = ["ball", "pet"];

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut hidden: Vec<&'static str> = Vec::new();
        let mut was_full = false;
        let mut last_fg: Option<Foreground> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));
            let fg = foreground();
            if last_fg.as_ref() != Some(&fg) {
                let _ = app.emit("foreground-app", fg.clone());
                last_fg = Some(fg);
            }
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

/// The foreground window's program, e.g. "msedge.exe" (our own windows report as our exe).
#[cfg(windows)]
fn foreground_exe() -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(|s| s.to_lowercase())
    }
}

#[cfg(not(windows))]
fn foreground_exe() -> Option<String> {
    None
}
