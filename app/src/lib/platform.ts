// Which device the app runs on. The phone app (Android) has one window and no desktop extras: no usage ball, no
// desktop pet, no capture of what the computer plays (online meetings), and no "Save audio…" (Android saves files
// through its own picker, not a file path).
export const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
export const isDesktop = !isMobile;

// Lets CSS adapt to phones (status bar and gesture bar insets): <html class="mobile">.
if (isMobile) document.documentElement.classList.add("mobile");
