mod acl;
mod lease;
mod process;
mod security;

use crate::windows_policy::{MAX_POLICY_BYTES, Policy, Result};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use windows_sys::Win32::Foundation::*;

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn check(value: i32, code: &'static str) -> Result<()> {
    if value == 0 {
        #[cfg(debug_assertions)]
        eprintln!("{code}:win32={}", unsafe { GetLastError() });
        Err(code)
    } else {
        Ok(())
    }
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub fn run() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--probe-child") {
        // The supervising process inspects this child's actual token before
        // resuming it. This is not a version/help availability shortcut.
        println!("{{\"available\":true,\"mechanism\":\"windows-lpac-job\",\"version\":\"1\"}}");
        return Ok(());
    }
    // FD 4 belongs only to the trusted supervisor. Handler stderr and exit
    // codes cannot forge an admission or cleanup result on this channel.
    let control = process::duplicate(process::inherited(4)?, false)?;
    let mut control_file = unsafe { std::fs::File::from_raw_handle(control.0) };
    std::mem::forget(control);
    let result = supervise();
    let message = match result {
        Ok(code) => {
            serde_json::json!({"protocol":"touba-windows-sandbox-result-v1", "ok":true, "exit_code":code})
        }
        Err(code) => {
            serde_json::json!({"protocol":"touba-windows-sandbox-result-v1", "ok":false, "code":code})
        }
    };
    control_file
        .write_all(message.to_string().as_bytes())
        .map_err(|_| "HandlerSandboxResultWriteFailed")?;
    drop(control_file);
    let code = result?;
    if code != 0 {
        std::process::exit(code as i32);
    }
    Ok(())
}

fn supervise() -> Result<u32> {
    let inherited = process::duplicate(process::inherited(5)?, false)?;
    let file = unsafe { std::fs::File::from_raw_handle(inherited.0) };
    std::mem::forget(inherited);
    let mut bytes = Vec::new();
    file.take(MAX_POLICY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "HandlerSandboxPolicyReadFailed")?;
    let policy = Policy::parse(&bytes)?;
    let mut lease = lease::Lease::create(&policy)?;
    let result = process::execute(&policy, &lease);
    // A result cannot be reported successful if cleanup failed.
    lease.cleanup()?;
    result
}
