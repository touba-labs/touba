use super::{Handle, Result, check, wide};
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::Cryptography::*;
use windows_sys::Win32::Security::Isolation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Threading::*;

pub fn random_name() -> Result<String> {
    let mut bytes = [0u8; 16];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err("HandlerSandboxRandomFailed");
    }
    Ok(format!(
        "touba-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

pub fn valid_name(name: &str) -> bool {
    name.len() == 38
        && name.starts_with("touba-")
        && name[6..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub struct Sid(pub PSID);
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.0);
        }
    }
}

pub fn profile(name: &str) -> Result<Sid> {
    if !valid_name(name) {
        return Err("HandlerSandboxStateInvalid");
    }
    let name = wide(name);
    let mut sid = null_mut();
    let status = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            name.as_ptr(),
            name.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if status < 0 {
        return Err("HandlerSandboxProfileCreateFailed");
    }
    Ok(Sid(sid))
}

pub fn profile_sid(name: &str) -> Result<Sid> {
    if !valid_name(name) {
        return Err("HandlerSandboxStateInvalid");
    }
    let mut sid = null_mut();
    let status =
        unsafe { DeriveAppContainerSidFromAppContainerName(wide(name).as_ptr(), &mut sid) };
    if status < 0 {
        return Err("HandlerSandboxProfileSidFailed");
    }
    Ok(Sid(sid))
}

pub fn delete_profile(name: &str) -> Result<()> {
    if !valid_name(name) {
        return Err("HandlerSandboxStateInvalid");
    }
    let status = unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) };
    // An interruption before creation also has a journal; absence is benign.
    if status < 0 && status as u32 != 0x80070002 {
        return Err("HandlerSandboxProfileCleanupFailed");
    }
    Ok(())
}

pub struct Capability {
    groups: *mut PSID,
    group_count: u32,
    sids: *mut PSID,
    count: u32,
}
impl Capability {
    pub fn new(name: &str) -> Result<Self> {
        let mut value = Self {
            groups: null_mut(),
            group_count: 0,
            sids: null_mut(),
            count: 0,
        };
        unsafe {
            check(
                DeriveCapabilitySidsFromName(
                    wide(name).as_ptr(),
                    &mut value.groups,
                    &mut value.group_count,
                    &mut value.sids,
                    &mut value.count,
                ),
                "HandlerSandboxCapabilityFailed",
            )?;
            if value.count != 1 || value.sids.is_null() || IsValidSid(*value.sids) == 0 {
                return Err("HandlerSandboxCapabilityInvalid");
            }
        }
        Ok(value)
    }
    pub fn sid(&self) -> PSID {
        unsafe { *self.sids }
    }
}
impl Drop for Capability {
    fn drop(&mut self) {
        unsafe {
            for (array, count) in [(self.groups, self.group_count), (self.sids, self.count)] {
                if !array.is_null() {
                    for index in 0..count {
                        LocalFree((*array.add(index as usize)).cast());
                    }
                    LocalFree(array.cast());
                }
            }
        }
    }
}

pub fn token_buffer(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut bytes);
    }
    if !(4..=65536).contains(&bytes) {
        return Err("HandlerSandboxTokenInvalid");
    }
    let mut storage = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    unsafe {
        check(
            GetTokenInformation(token, class, storage.as_mut_ptr().cast(), bytes, &mut bytes),
            "HandlerSandboxTokenQueryFailed",
        )?;
    }
    Ok(storage)
}

pub fn process_token(process: HANDLE) -> Result<Handle> {
    let mut token = null_mut();
    unsafe {
        check(
            OpenProcessToken(process, TOKEN_QUERY, &mut token),
            "HandlerSandboxTokenOpenFailed",
        )?;
    }
    Ok(Handle(token))
}

pub fn current_user_sid() -> Result<String> {
    let token = process_token(unsafe { GetCurrentProcess() })?;
    let buffer = token_buffer(token.0, TokenUser)?;
    let mut value = null_mut();
    unsafe {
        check(
            ConvertSidToStringSidW((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut value),
            "HandlerSandboxUserSidFailed",
        )?;
        let mut length = 0;
        while *value.add(length) != 0 {
            length += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(value, length));
        LocalFree(value.cast());
        Ok(text)
    }
}

pub fn verify_token(process: HANDLE, sid: PSID, capabilities: &[Capability]) -> Result<()> {
    let token = process_token(process)?;
    let app = token_buffer(token.0, TokenIsAppContainer)?;
    let package = token_buffer(token.0, TokenAppContainerSid)?;
    let caps = token_buffer(token.0, TokenCapabilities)?;
    let label = token_buffer(token.0, TokenIntegrityLevel)?;
    unsafe {
        let package_sid =
            (*package.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()).TokenAppContainer;
        let groups = caps.as_ptr().cast::<TOKEN_GROUPS>();
        let integrity = (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
        if *app.as_ptr().cast::<u32>() == 0
            || package_sid.is_null()
            || EqualSid(package_sid, sid) == 0
            || (*groups).GroupCount as usize != capabilities.len()
            || IsValidSid(integrity) == 0
            || *GetSidSubAuthorityCount(integrity) != 1
            || *GetSidSubAuthority(integrity, 0) != 0x1000
        {
            return Err("HandlerSandboxTokenMismatch");
        }
        let groups = std::slice::from_raw_parts(
            std::ptr::addr_of!((*groups).Groups).cast::<SID_AND_ATTRIBUTES>(),
            capabilities.len(),
        );
        for expected in capabilities {
            if !groups
                .iter()
                .any(|g| EqualSid(g.Sid, expected.sid()) != 0 && g.Attributes == 4)
            {
                return Err("HandlerSandboxTokenMismatch");
            }
        }
    }
    Ok(())
}

/// Only for new, empty launcher-owned state directories. Never for user paths.
pub fn protect_new_directory(path: &std::path::Path) -> Result<()> {
    let user = current_user_sid()?;
    let mut descriptor = null_mut();
    unsafe {
        check(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(format!("D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)")).as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ),
            "HandlerSandboxStateAclFailed",
        )?;
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        let result = (|| {
            check(
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted),
                "HandlerSandboxStateAclFailed",
            )?;
            let status = SetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            );
            if status != 0 {
                return Err("HandlerSandboxStateAclFailed");
            }
            Ok(())
        })();
        LocalFree(descriptor.cast());
        result
    }
}

pub fn verify_private_directory(path: &std::path::Path) -> Result<()> {
    let token = process_token(unsafe { GetCurrentProcess() })?;
    let user = token_buffer(token.0, TokenUser)?;
    let mut descriptor = null_mut();
    let mut acl = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err("HandlerSandboxStateAclInvalid");
    }
    let result = (|| {
        unsafe {
            if acl.is_null() {
                return Err("HandlerSandboxStateAclInvalid");
            }
            for index in 0..(*acl).AceCount {
                let mut ace = null_mut();
                check(
                    GetAce(acl, u32::from(index), &mut ace),
                    "HandlerSandboxStateAclInvalid",
                )?;
                let header = &*ace.cast::<ACE_HEADER>();
                // The state format uses only simple allow ACEs for the actual
                // user and LocalSystem. Unexpected ACLs are refused, not replaced.
                if header.AceType != 0 {
                    return Err("HandlerSandboxStateAclInvalid");
                }
                let sid = std::ptr::addr_of!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart)
                    .cast_mut()
                    .cast();
                if EqualSid(sid, (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) == 0
                    && IsWellKnownSid(sid, WinLocalSystemSid) == 0
                {
                    return Err("HandlerSandboxStateAclInvalid");
                }
            }
            Ok(())
        }
    })();
    unsafe {
        LocalFree(descriptor.cast());
    }
    result
}

pub fn wait_job_empty(job: HANDLE) -> Result<()> {
    for _ in 0..500 {
        let mut info: windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        unsafe {
            check(
                windows_sys::Win32::System::JobObjects::QueryInformationJobObject(
                    job,
                    windows_sys::Win32::System::JobObjects::JobObjectBasicAccountingInformation,
                    (&mut info as *mut windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of_val(&info) as u32,
                    null_mut(),
                ),
                "HandlerSandboxJobQueryFailed",
            )?;
        }
        if info.ActiveProcesses == 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err("HandlerSandboxJobTeardownFailed")
}
