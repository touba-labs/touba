use serde::Deserialize;
use std::ffi::CString;
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;

// Linux x86-64 UAPI; no libc dependency and no setuid/capabilities required.
unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
    fn prctl(option: i32, ...) -> i32;
    fn open(path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}
const CREATE: i64 = 444;
const ADD: i64 = 445;
const RESTRICT: i64 = 446;
const READ: u64 = (1 << 2) | (1 << 3);
const WRITE: u64 = (1 << 1)
    | (1 << 4)
    | (1 << 5)
    | (1 << 7)
    | (1 << 8)
    | (1 << 9)
    | (1 << 10)
    | (1 << 12)
    | (1 << 13)
    | (1 << 14);
const FILE_RIGHTS: u64 = 1 | (1 << 1) | (1 << 2) | (1 << 14) | (1 << 15) | (1 << 16);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    protocol: String,
    read: Vec<String>,
    write: Vec<String>,
    execute: Vec<String>,
    sockets: Vec<String>,
    network: bool,
}

#[repr(C, packed)]
struct PathRule {
    rights: u64,
    parent: i32,
}

fn abi() -> i64 {
    // SAFETY: documented version query has a null attributes pointer and size 0.
    unsafe { syscall(CREATE, std::ptr::null::<u8>(), 0_usize, 1_u32) }
}

fn add_rule(rules: &File, path: &str, rights: u64) -> Result<(), &'static str> {
    if !path.starts_with('/') {
        return Err("HandlerSandboxPathInvalid");
    }
    let name = CString::new(path).map_err(|_| "HandlerSandboxPathInvalid")?;
    // O_PATH | O_CLOEXEC. Paths are already resolved within the private root.
    let fd = unsafe { open(name.as_ptr(), 0x200000 | 0x80000) };
    if fd < 0 {
        return Err("HandlerSandboxPathInvalid");
    }
    // SAFETY: open returned a fresh owned descriptor, closed on all paths.
    let file = unsafe { File::from_raw_fd(fd) };
    let directory = file
        .metadata()
        .map_err(|_| "HandlerSandboxPathInvalid")?
        .is_dir();
    let rights = if directory {
        rights
    } else {
        rights & FILE_RIGHTS
    };
    if rights == 0 {
        return Ok(());
    }
    let rule = PathRule {
        rights,
        parent: file.as_raw_fd(),
    };
    // SAFETY: packed layout matches landlock_path_beneath_attr, valid FDs live.
    if unsafe { syscall(ADD, rules.as_raw_fd(), 1_u32, &rule, 0_u32) } != 0 {
        return Err("HandlerSandboxUnsupportedPolicy");
    }
    Ok(())
}

pub fn run() -> Result<(), &'static str> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let version = abi();
    if arguments.len() == 1 && arguments[0] == "--probe" {
        println!(
            "{}",
            serde_json::json!({"protocol":"touba-sandbox-probe-v1", "landlock_abi":version, "available":version >= 3})
        );
        return Ok(());
    }
    if version < 3 {
        return Err("HandlerSandboxUnavailable");
    }
    if arguments.len() < 2
        || arguments[0] != "--"
        || !std::path::Path::new(&arguments[1]).is_absolute()
    {
        return Err("HandlerSandboxPathInvalid");
    }
    let mut bytes = Vec::new();
    if unsafe { fcntl(5, 1) } < 0 {
        return Err("HandlerSandboxPolicyInvalid");
    }
    {
        // SAFETY: launcher protocol reserves FD 5. It is consumed and closed
        // before exec; no policy pipe is left available to the handler.
        let file = unsafe { File::from_raw_fd(5) };
        file.take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| "HandlerSandboxPolicyInvalid")?;
    }
    if bytes.len() > 1_048_576 {
        return Err("HandlerSandboxPolicyInvalid");
    }
    let policy: Policy =
        serde_json::from_slice(&bytes).map_err(|_| "HandlerSandboxPolicyInvalid")?;
    if policy.protocol != "touba-linux-sandbox-policy-v1"
        || policy.read.len() + policy.write.len() + policy.execute.len() + policy.sockets.len()
            > 8192
    {
        return Err("HandlerSandboxPolicyInvalid");
    }
    if !policy.network && !policy.sockets.is_empty() && version < 9 {
        return Err("HandlerSandboxUnsupportedPolicy");
    }
    let mut handled: u64 = (1 << 15) - 1; // ABI 3 filesystem operations.
    if version >= 5 {
        handled |= 1 << 15;
    }
    if version >= 9 && !policy.network {
        handled |= 1 << 16;
    }
    // SAFETY: ABI 1-compatible prefix is sufficient for filesystem rules.
    let fd = unsafe { syscall(CREATE, &handled, 8_usize, 0_u32) };
    if fd < 0 {
        return Err("HandlerSandboxUnavailable");
    }
    let rules = unsafe { File::from_raw_fd(fd as i32) };
    for path in &policy.read {
        add_rule(&rules, path, READ)?;
    }
    for path in &policy.write {
        add_rule(&rules, path, WRITE)?;
    }
    for path in &policy.execute {
        add_rule(&rules, path, 1)?;
    }
    if !policy.network {
        for path in &policy.sockets {
            add_rule(&rules, path, 1 << 16)?;
        }
    }
    // Unprivileged, irreversible for this process and its descendants.
    if unsafe { prctl(38, 1_i64, 0_i64, 0_i64, 0_i64) } != 0
        || unsafe { syscall(RESTRICT, rules.as_raw_fd(), 0_u32) } != 0
    {
        return Err("HandlerSandboxUnavailable");
    }
    drop(rules);
    let _error = Command::new(&arguments[1]).args(&arguments[2..]).exec();
    Err("HandlerSandboxExecutionFailed")
}
