//! Read labels and normalize only freshly owned diagnostic fixtures.
//! Never change integrity labels on existing user files to grant sandbox access.
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::SystemServices::{
    SECURITY_MANDATORY_MEDIUM_RID, SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
};

type Result<T> = std::result::Result<T, String>;

struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[derive(Debug, PartialEq)]
pub struct Label {
    pub rid: u32,
    pub policy: u32,
    pub implicit: bool,
}

impl Label {
    fn implicit_medium() -> Self {
        Self {
            rid: SECURITY_MANDATORY_MEDIUM_RID as u32,
            policy: SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
            implicit: true,
        }
    }
}

// `sd` is owned by the caller and comes directly from a successful Windows API.
unsafe fn descriptor_label(sd: PSECURITY_DESCRIPTOR) -> Result<Label> {
    let mut present = 0;
    let mut defaulted = 0;
    let mut sacl = null_mut();
    if GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted) == 0 {
        return Err(format!("Read label SACL: {}", GetLastError()));
    }
    if present == 0 || sacl.is_null() {
        return Ok(Label::implicit_medium());
    }
    if IsValidAcl(sacl) == 0 {
        return Err("Invalid label ACL".into());
    }
    let mut found = None;
    for index in 0..(*sacl).AceCount {
        let mut entry = null_mut();
        if GetAce(sacl, index as u32, &mut entry) == 0 || entry.is_null() {
            return Err("Missing label ACE".into());
        }
        let header = &*entry.cast::<ACE_HEADER>();
        if header.AceType as u32 != SYSTEM_MANDATORY_LABEL_ACE_TYPE {
            continue;
        }
        // Header(4) + access mask(4) + integrity SID(12).
        if header.AceSize < 20 || found.is_some() {
            return Err("Invalid label ACE".into());
        }
        let ace = &*entry.cast::<SYSTEM_MANDATORY_LABEL_ACE>();
        let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
        if IsValidSid(sid) == 0 || *GetSidSubAuthorityCount(sid) != 1 {
            return Err("Invalid label SID".into());
        }
        found = Some(Label {
            rid: *GetSidSubAuthority(sid, 0),
            policy: ace.Mask,
            implicit: false,
        });
    }
    Ok(found.unwrap_or_else(Label::implicit_medium))
}

pub fn label(path: &Path) -> Result<Label> {
    let mut sd = null_mut();
    unsafe {
        let result = GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut sd,
        );
        if result != 0 {
            return Err(format!("Read fixture label: {result}"));
        }
        let _sd = Local(sd);
        descriptor_label(sd)
    }
}

pub fn fixture_medium(path: &Path) -> Result<()> {
    fixture_label(path, "S:(ML;;NW;;;ME)")
}

pub fn fixture_low(path: &Path) -> Result<()> {
    fixture_label(path, "S:(ML;;NW;;;LW)")
}

pub fn fixture_high(path: &Path) -> Result<()> {
    fixture_label(path, "S:(ML;;NW;;;HI)")
}

fn fixture_label(path: &Path, sddl: &str) -> Result<()> {
    // Label-only update: never change the DACL or grant Everyone/ALL PACKAGES.
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mut sd = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            null_mut(),
        ) == 0
        {
            return Err(format!("Build fixture label: {}", GetLastError()));
        }
        let _sd = Local(sd);
        let mut present = 0;
        let mut defaulted = 0;
        let mut sacl = null_mut();
        if GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted) == 0
            || present == 0
            || sacl.is_null()
        {
            return Err("Missing fixture label".into());
        }
        let result = SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null(),
            sacl,
        );
        if result != 0 {
            return Err(format!("Set fixture label: {result}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dacl_bytes(path: &Path) -> Vec<u8> {
        let mut acl = null_mut();
        let mut sd = null_mut();
        unsafe {
            assert_eq!(
                GetNamedSecurityInfoW(
                    wide(path).as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut acl,
                    null_mut(),
                    &mut sd
                ),
                0
            );
            let _sd = Local(sd);
            assert!(!acl.is_null());
            assert_ne!(IsValidAcl(acl), 0);
            std::slice::from_raw_parts(acl.cast(), (*acl).AclSize as usize).to_vec()
        }
    }

    fn from_sddl(sddl: &str) -> Label {
        let text: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut sd = null_mut();
        unsafe {
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    null_mut()
                ),
                0
            );
            let _sd = Local(sd);
            descriptor_label(sd).unwrap()
        }
    }

    #[test]
    fn native_descriptor_labels_are_read_without_string_projection() {
        for (label, rid) in [("LW", 0x1000), ("ME", 0x2000), ("HI", 0x3000)] {
            assert_eq!(
                from_sddl(&format!("S:(ML;;NW;;;{label})")),
                Label {
                    rid,
                    policy: SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
                    implicit: false
                }
            );
        }
    }

    #[test]
    fn absent_label_is_implicit_medium_not_an_instrumentation_error() {
        assert_eq!(from_sddl("D:(A;;GA;;;SY)"), Label::implicit_medium());
    }

    #[test]
    fn fresh_fixture_label_round_trip_preserves_file_contents() {
        let name = format!(
            "touba-label-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(name);
        // Exclusive creation and cleanup only of this newly owned file.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        drop(file);
        let result = (|| -> Result<()> {
            std::fs::write(&path, b"label-canary").map_err(|e| e.to_string())?;
            let _original = label(&path)?;
            let permissions = dacl_bytes(&path);
            fixture_medium(&path)?;
            assert_eq!(
                label(&path)?,
                Label {
                    rid: 0x2000,
                    policy: SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
                    implicit: false
                }
            );
            assert_eq!(std::fs::read(&path).unwrap(), b"label-canary");
            assert_eq!(dacl_bytes(&path), permissions);
            fixture_low(&path)?;
            assert_eq!(label(&path)?.rid, 0x1000);
            assert_eq!(std::fs::read(&path).unwrap(), b"label-canary");
            assert_eq!(dacl_bytes(&path), permissions);
            Ok(())
        })();
        std::fs::remove_file(&path).unwrap();
        result.unwrap();
    }
}
