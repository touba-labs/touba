use super::lease::Lease;
use super::{Handle, Result, check, security, wide};
use crate::windows_policy::{Policy, command_line};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::WindowsProgramming::*;

pub struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(count: u32) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            return Err("HandlerSandboxAttributesInvalid");
        }
        let mut value = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        unsafe {
            check(
                InitializeProcThreadAttributeList(value.ptr(), count, 0, &mut bytes),
                "HandlerSandboxAttributesFailed",
            )?;
        }
        value.initialized = true;
        Ok(value)
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set<T>(&mut self, key: u32, values: &[T]) -> Result<()> {
        unsafe {
            check(
                UpdateProcThreadAttribute(
                    self.ptr(),
                    0,
                    key as usize,
                    values.as_ptr().cast(),
                    size_of_val(values),
                    null_mut(),
                    null(),
                ),
                "HandlerSandboxAttributesFailed",
            )
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr());
            }
        }
    }
}

/// libuv/CRT inherited-descriptor table. Do not call _get_osfhandle for an
/// unchecked descriptor: the CRT invalid-parameter handler can abort first.
pub fn inherited(fd: usize) -> Result<HANDLE> {
    let mut info: STARTUPINFOW = unsafe { zeroed() };
    unsafe {
        GetStartupInfoW(&mut info);
    }
    if info.cbReserved2 < 4 || info.lpReserved2.is_null() {
        return Err("HandlerSandboxProtocolDescriptorMissing");
    }
    let bytes = unsafe { std::slice::from_raw_parts(info.lpReserved2, info.cbReserved2 as usize) };
    let count = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
    if count > 256
        || fd >= count
        || bytes.len() < 4 + count * (1 + size_of::<HANDLE>())
        || bytes[4 + fd] & 1 == 0
    {
        return Err("HandlerSandboxProtocolDescriptorMissing");
    }
    let handle = unsafe {
        std::ptr::read_unaligned(
            bytes
                .as_ptr()
                .add(4 + count + fd * size_of::<HANDLE>())
                .cast::<HANDLE>(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err("HandlerSandboxProtocolDescriptorMissing");
    }
    Ok(handle)
}

pub fn duplicate(handle: HANDLE, inherit: bool) -> Result<Handle> {
    let mut value = null_mut();
    unsafe {
        check(
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                GetCurrentProcess(),
                &mut value,
                0,
                i32::from(inherit),
                DUPLICATE_SAME_ACCESS,
            ),
            "HandlerSandboxProtocolDuplicateFailed",
        )?;
    }
    Ok(Handle(value))
}

fn descriptors(diagnostic: bool) -> Result<(Vec<Handle>, Vec<u8>)> {
    let count = if diagnostic { 4 } else { 3 };
    let mut handles = Vec::new();
    let mut table = vec![0u8; 4 + count * (1 + size_of::<HANDLE>())];
    table[..4].copy_from_slice(&(count as u32).to_ne_bytes());
    for fd in 0..count {
        handles.push(duplicate(inherited(fd)?, true)?);
        // FOPEN | FPIPE. Normal stdin/out/err and private diagnostic are pipes.
        table[4 + fd] = 1 | 8;
        unsafe {
            std::ptr::write_unaligned(
                table
                    .as_mut_ptr()
                    .add(4 + count + fd * size_of::<HANDLE>())
                    .cast::<HANDLE>(),
                handles[fd].0,
            );
        }
    }
    Ok((handles, table))
}

fn environment(policy: &Policy, scratch: &std::path::Path) -> Result<Vec<u16>> {
    let mut entries = std::collections::BTreeMap::new();
    // libuv injects its required_vars into the supervisor environment even
    // when Node receives an explicit env object. Only host-authorized names
    // from the private policy are forwarded, never ambient PATH/user metadata.
    for key in &policy.env_keys {
        let value = std::env::var(key).map_err(|_| "HandlerSandboxEnvironmentInvalid")?;
        if value.contains('\0') {
            return Err("HandlerSandboxEnvironmentInvalid");
        }
        entries.insert(key.to_uppercase(), value);
    }
    // OS location comes from Windows, never from provider/model input.
    let mut system = [0u16; 32768];
    let length = unsafe {
        windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW(
            system.as_mut_ptr(),
            system.len() as u32,
        )
    } as usize;
    if length == 0 || length >= system.len() {
        return Err("HandlerSandboxEnvironmentInvalid");
    }
    entries.insert(
        "SYSTEMROOT".into(),
        String::from_utf16_lossy(&system[..length]),
    );
    for key in ["LOCALAPPDATA", "TEMP", "TMP"] {
        entries.insert(
            key.into(),
            scratch
                .to_str()
                .ok_or("HandlerSandboxEnvironmentInvalid")?
                .into(),
        );
    }
    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(wide(format!("{key}={value}")));
    }
    block.push(0);
    if block.len() > 32767 {
        return Err("HandlerSandboxEnvironmentInvalid");
    }
    Ok(block)
}

struct Running {
    process: Handle,
    job: Handle,
}
impl Drop for Running {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.job.0, 125);
        }
        let _ = security::wait_job_empty(self.job.0);
    }
}

pub fn execute(policy: &Policy, lease: &Lease) -> Result<u32> {
    let mut caps = vec![security::Capability::new("registryRead")?];
    if policy.network {
        // General network authority, not an implicit loopback exemption or a
        // hostname allowlist. Windows still applies its independent firewall.
        for name in [
            "internetClient",
            "internetClientServer",
            "privateNetworkClientServer",
        ] {
            caps.push(security::Capability::new(name)?);
        }
    }
    let entries = caps
        .iter()
        .map(|c| SID_AND_ATTRIBUTES {
            Sid: c.sid(),
            Attributes: 4,
        })
        .collect::<Vec<_>>();
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: lease.sid.0,
        Capabilities: entries.as_ptr().cast_mut(),
        CapabilityCount: entries.len() as u32,
        Reserved: 0,
    };
    let (stdio, mut reserved) = descriptors(policy.diagnostic)?;
    let handles = stdio.iter().map(|h| h.0).collect::<Vec<_>>();
    let mut attrs = Attributes::new(3 + u32::from(!policy.process))?;
    // Attribute values are borrowed by Windows until CreateProcess returns.
    let security_values = [security];
    let opt_out = [PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT];
    let child_policy = [PROCESS_CREATION_CHILD_PROCESS_RESTRICTED];
    attrs.set(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        &security_values,
    )?;
    attrs.set(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        &opt_out,
    )?;
    attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    if !policy.process {
        attrs.set(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy)?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdio[0].0;
    startup.StartupInfo.hStdOutput = stdio[1].0;
    startup.StartupInfo.hStdError = stdio[2].0;
    startup.StartupInfo.cbReserved2 = reserved.len() as u16;
    startup.StartupInfo.lpReserved2 = reserved.as_mut_ptr();
    startup.lpAttributeList = attrs.ptr();
    let job = Handle(unsafe {
        CreateJobObjectW(null(), wide(format!("Global\\{}", lease.name)).as_ptr())
    });
    if job.0.is_null() {
        return Err("HandlerSandboxJobCreateFailed");
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        check(
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            ),
            "HandlerSandboxJobLimitFailed",
        )?;
    }
    let env = environment(policy, &lease.scratch)?;
    let mut command = wide(command_line(&policy.command, &policy.args));
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        check(
            CreateProcessW(
                wide(&policy.command).as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | DETACHED_PROCESS,
                env.as_ptr().cast::<c_void>(),
                wide(&policy.cwd).as_ptr(),
                &startup.StartupInfo,
                &mut info,
            ),
            "HandlerSandboxProcessCreateFailed",
        )?;
    }
    let running = Running {
        process: Handle(info.hProcess),
        job,
    };
    let thread = Handle(info.hThread);
    unsafe {
        if AssignProcessToJobObject(running.job.0, running.process.0) == 0 {
            TerminateProcess(running.process.0, 125);
            WaitForSingleObject(running.process.0, 5000);
            return Err("HandlerSandboxJobAssignFailed");
        }
        security::verify_token(running.process.0, lease.sid.0, &caps)?;
        let mut child_policy: windows_sys::Win32::System::SystemServices::PROCESS_MITIGATION_CHILD_PROCESS_POLICY = zeroed();
        check(GetProcessMitigationPolicy(running.process.0, ProcessChildProcessPolicy,
            (&mut child_policy as *mut windows_sys::Win32::System::SystemServices::PROCESS_MITIGATION_CHILD_PROCESS_POLICY).cast(),
            size_of_val(&child_policy)), "HandlerSandboxProcessPolicyQueryFailed")?;
        if (child_policy.Anonymous.Flags & 1 != 0) == policy.process {
            return Err("HandlerSandboxProcessPolicyMismatch");
        }
        if ResumeThread(thread.0) == u32::MAX {
            return Err("HandlerSandboxProcessResumeFailed");
        }
    }
    drop(stdio);
    if unsafe { WaitForSingleObject(running.process.0, INFINITE) } != WAIT_OBJECT_0 {
        return Err("HandlerSandboxProcessWaitFailed");
    }
    let mut code = 0;
    unsafe {
        check(
            GetExitCodeProcess(running.process.0, &mut code),
            "HandlerSandboxProcessExitFailed",
        )?;
        check(
            TerminateJobObject(running.job.0, 125),
            "HandlerSandboxJobTeardownFailed",
        )?;
    }
    security::wait_job_empty(running.job.0)?;
    Ok(code)
}
