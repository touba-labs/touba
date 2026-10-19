//! Trusted, non-privileged launcher. The policy comes from the host over FD 5,
//! never from a model or a handler. No shell, environment expansion or fallback.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod windows_policy;

fn main() {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let result = linux::run();
    #[cfg(windows)]
    let result = windows::run();
    #[cfg(not(any(windows, all(target_os = "linux", target_arch = "x86_64"))))]
    let result: Result<(), &str> = Err("HandlerSandboxUnsupportedPlatform");
    if let Err(code) = result {
        // Stable class only: paths, environment and OS messages stay private.
        eprintln!("{code}");
        std::process::exit(125);
    }
}
