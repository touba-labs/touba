//! ACL leases: merge into the current DACL, never restore an old snapshot.
use super::{Handle, Result, check, wide};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    volume: u32,
    high: u32,
    low: u32,
    created_high: u32,
    created_low: u32,
}

pub struct Target {
    pub handle: Handle,
    pub identity: Identity,
    pub directory: bool,
}

fn normalized(value: &str) -> String {
    value
        .strip_prefix("\\\\?\\")
        .unwrap_or(value)
        .to_lowercase()
}

pub fn open(path: &Path, anchor: bool) -> Result<Target> {
    let text = path.to_str().ok_or("HandlerSandboxPathInvalid")?;
    if !crate::windows_policy::local_path(text) {
        return Err("HandlerSandboxPathInvalid");
    }
    // Reject every reparse ancestor; final-component OPEN_REPARSE_POINT alone
    // does not prevent traversal through a junction in an earlier component.
    for ancestor in path.ancestors().take_while(|p| p.parent().is_some()) {
        let attr = unsafe { GetFileAttributesW(wide(ancestor).as_ptr()) };
        if attr == INVALID_FILE_ATTRIBUTES || attr & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("HandlerSandboxPathInvalid");
        }
    }
    let handle = Handle(unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | if anchor { 0 } else { FILE_SHARE_DELETE },
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if handle.0 == INVALID_HANDLE_VALUE {
        return Err("HandlerSandboxAclUnavailable");
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        check(
            GetFileInformationByHandle(handle.0, &mut info),
            "HandlerSandboxPathInvalid",
        )?;
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.nNumberOfLinks > 1 {
        return Err("HandlerSandboxPathInvalid");
    }
    let mut final_path = vec![0u16; 32768];
    let size = unsafe {
        GetFinalPathNameByHandleW(
            handle.0,
            final_path.as_mut_ptr(),
            final_path.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    // Node's realpath can preserve an 8.3 ancestor (e.g. RUNNER~1), whereas
    // GetFinalPathNameByHandle returns its long name. Compare physical names,
    // not those two spellings; the reparse and file-identity checks still apply.
    let canonical = std::fs::canonicalize(path).map_err(|_| "HandlerSandboxPathInvalid")?;
    if size == 0
        || size >= final_path.len()
        || normalized(&String::from_utf16_lossy(&final_path[..size]))
            != normalized(&canonical.to_string_lossy())
    {
        return Err("HandlerSandboxPathInvalid");
    }
    Ok(Target {
        handle,
        directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        identity: Identity {
            volume: info.dwVolumeSerialNumber,
            high: info.nFileIndexHigh,
            low: info.nFileIndexLow,
            created_high: info.ftCreationTime.dwHighDateTime,
            created_low: info.ftCreationTime.dwLowDateTime,
        },
    })
}

/// Validate a bounded existing tree without following links. The host owns
/// filesystem configuration; links introduced later never acquire a new ACL.
pub fn tree(root: &Path) -> Result<Vec<PathBuf>> {
    let mut pending = vec![root.to_path_buf()];
    let mut result = Vec::new();
    while let Some(path) = pending.pop() {
        if result.len() >= 100_000 {
            return Err("HandlerSandboxScopeTooLarge");
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "HandlerSandboxPathInvalid")?;
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("HandlerSandboxPathInvalid");
        }
        // SetSecurityInfo would convert an unprotected NULL child DACL into
        // an inherited one, then leave an empty DACL on revoke. Refuse that
        // tree before any mutation, preserving the user's original access.
        let target = open(&path, false)?;
        let _ = dacl(&target)?;
        if metadata.is_dir() {
            for child in std::fs::read_dir(&path).map_err(|_| "HandlerSandboxPathInvalid")? {
                pending.push(child.map_err(|_| "HandlerSandboxPathInvalid")?.path());
            }
        }
        result.push(path);
    }
    Ok(result)
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0.cast());
        }
    }
}

fn dacl(target: &Target) -> Result<(Descriptor, *mut ACL)> {
    let mut descriptor = null_mut();
    let mut acl = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            target.handle.0,
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
        return Err("HandlerSandboxAclReadFailed");
    }
    let descriptor = Descriptor(descriptor);
    if acl.is_null() {
        return Err("HandlerSandboxUnrestrictedDacl");
    }
    Ok((descriptor, acl))
}

pub fn grant(target: &Target, sid: PSID, rights: u32, recursive: bool) -> Result<()> {
    let (_descriptor, existing) = dacl(target)?;
    // Keep non-inherited directory listing separate from inherited write.
    // Merging masks for the same SID could otherwise turn FILE_LIST_DIRECTORY
    // (the same bit as FILE_READ_DATA) into a read grant on child data files.
    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        check(
            GetAclInformation(
                existing,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                AclSizeInformation,
            ),
            "HandlerSandboxAclReadFailed",
        )?;
    }
    let size = info.AclBytesInUse + std::mem::size_of::<ACCESS_ALLOWED_ACE>() as u32
        - std::mem::size_of::<u32>() as u32
        + unsafe { GetLengthSid(sid) };
    let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let merged: *mut ACL = storage.as_mut_ptr().cast();
    unsafe {
        check(
            InitializeAcl(merged, size, ACL_REVISION_DS),
            "HandlerSandboxAclMergeFailed",
        )?;
    }
    let flags = if target.directory && recursive {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    let mut inserted = false;
    for index in 0..info.AceCount {
        let mut ace = null_mut();
        unsafe {
            check(
                GetAce(existing, index, &mut ace),
                "HandlerSandboxAclReadFailed",
            )?;
            let header = &*ace.cast::<ACE_HEADER>();
            if !inserted && u32::from(header.AceFlags) & INHERITED_ACE != 0 {
                check(
                    AddAccessAllowedAceEx(merged, ACL_REVISION_DS, flags, rights, sid),
                    "HandlerSandboxAclMergeFailed",
                )?;
                inserted = true;
            }
            check(
                AddAce(
                    merged,
                    ACL_REVISION_DS,
                    u32::MAX,
                    ace,
                    u32::from(header.AceSize),
                ),
                "HandlerSandboxAclMergeFailed",
            )?;
        }
    }
    if !inserted {
        unsafe {
            check(
                AddAccessAllowedAceEx(merged, ACL_REVISION_DS, flags, rights, sid),
                "HandlerSandboxAclMergeFailed",
            )?;
        }
    }
    let result = unsafe {
        SetSecurityInfo(
            target.handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            merged,
            null(),
        )
    };
    if result != 0 {
        return Err("HandlerSandboxAclGrantFailed");
    }
    Ok(())
}

pub fn revoke(target: &Target, sid: PSID) -> Result<()> {
    let (_descriptor, existing) = dacl(target)?;
    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        check(
            GetAclInformation(
                existing,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                AclSizeInformation,
            ),
            "HandlerSandboxAclReadFailed",
        )?;
    }
    let mut storage =
        vec![0usize; (info.AclBytesInUse as usize).div_ceil(std::mem::size_of::<usize>())];
    let reduced: *mut ACL = storage.as_mut_ptr().cast();
    unsafe {
        check(
            InitializeAcl(reduced, info.AclBytesInUse, ACL_REVISION_DS),
            "HandlerSandboxAclCleanupFailed",
        )?;
    }
    let mut removed = false;
    for index in 0..info.AceCount {
        let mut ace = null_mut();
        unsafe {
            check(
                GetAce(existing, index, &mut ace),
                "HandlerSandboxAclReadFailed",
            )?;
            let header = &*ace.cast::<ACE_HEADER>();
            let ours = matches!(header.AceType, 0 | 1)
                && EqualSid(
                    std::ptr::addr_of!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart)
                        .cast_mut()
                        .cast(),
                    sid,
                ) != 0;
            if ours {
                removed = true;
            } else {
                check(
                    AddAce(
                        reduced,
                        ACL_REVISION_DS,
                        u32::MAX,
                        ace,
                        u32::from(header.AceSize),
                    ),
                    "HandlerSandboxAclCleanupFailed",
                )?;
            }
        }
    }
    if removed {
        let status = unsafe {
            SetSecurityInfo(
                target.handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                reduced,
                null(),
            )
        };
        if status != 0 {
            return Err("HandlerSandboxAclCleanupFailed");
        }
    }
    Ok(())
}

pub const CODE: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
pub const READ: u32 = FILE_GENERIC_READ;
pub const WRITE: u32 = FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES | FILE_DELETE_CHILD | DELETE;
pub const METADATA: u32 = FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE;
// Python importlib needs to enumerate the immediate module directory. This
// right is never inherited and never authorizes reading sibling file data.
pub const CODE_DIRECTORY: u32 = METADATA | FILE_LIST_DIRECTORY;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn write_mask_does_not_grant_read_or_execute_or_acl_control() {
        assert_eq!(
            WRITE & (FILE_READ_DATA | FILE_EXECUTE | WRITE_DAC | WRITE_OWNER),
            0
        );
        assert_ne!(WRITE & FILE_READ_ATTRIBUTES, 0);
    }
    #[test]
    fn short_and_long_spellings_resolve_to_the_same_object() {
        let root = std::env::temp_dir().join(super::super::security::random_name().unwrap());
        std::fs::create_dir(&root).unwrap();
        let file = root.join("Long fixture filename.txt");
        std::fs::write(&file, b"fixture").unwrap();
        let mut short = vec![0u16; 32768];
        let length = unsafe {
            GetShortPathNameW(wide(&file).as_ptr(), short.as_mut_ptr(), short.len() as u32)
        } as usize;
        assert!(length > 0 && length < short.len());
        let short = PathBuf::from(String::from_utf16_lossy(&short[..length]));
        assert_eq!(
            open(&file, false).unwrap().identity,
            open(&short, false).unwrap().identity
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
