// The monitors' physical sizes (millimetres, as each monitor reports them), so the desktop ball and pet can be sized
// to the screen they're on: smaller on a laptop than on a big monitor. Windows only; elsewhere the list is empty and
// the frontend falls back to the screen's pixel size.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Screen {
    /// Position and size in physical pixels (as Tauri's monitor API reports them).
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// The visible picture's size; 0 when the monitor doesn't say (some projectors, TVs, remote sessions).
    pub width_mm: i32,
    pub height_mm: i32,
}

#[cfg(windows)]
pub fn list() -> Vec<Screen> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateDCW, DeleteDC, EnumDisplayMonitors, GetDeviceCaps, GetMonitorInfoW, HDC, HMONITOR, HORZSIZE, MONITORINFO,
        MONITORINFOEXW, VERTSIZE,
    };

    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> i32 {
        unsafe {
            let out = &mut *(data as *mut Vec<Screen>);
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) == 0 {
                return 1;
            }
            let r = info.monitorInfo.rcMonitor;
            // The monitor's own device context reports its physical size (from its EDID).
            let dc = CreateDCW(info.szDevice.as_ptr(), info.szDevice.as_ptr(), std::ptr::null(), std::ptr::null());
            let (width_mm, height_mm) = if dc.is_null() {
                (0, 0)
            } else {
                let size = (GetDeviceCaps(dc, HORZSIZE as i32), GetDeviceCaps(dc, VERTSIZE as i32));
                DeleteDC(dc);
                size
            };
            out.push(Screen { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, width_mm, height_mm });
            1
        }
    }

    let mut screens: Vec<Screen> = Vec::new();
    unsafe {
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each), &mut screens as *mut Vec<Screen> as LPARAM);
    }
    screens
}

#[cfg(not(windows))]
pub fn list() -> Vec<Screen> {
    Vec::new()
}

#[tauri::command]
pub fn screen_sizes() -> Vec<Screen> {
    list()
}
