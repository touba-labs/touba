use super::{Handle, Result, acl, check, security, wide};
use crate::windows_policy::Policy;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::ptr::null;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE};
use windows_sys::Win32::System::Threading::*;

struct EditLock(Handle);
impl EditLock {
    fn acquire() -> Result<Self> {
        let name = format!("Global\\ToubaAcl-{}", security::current_user_sid()?);
        let handle = Handle(unsafe { CreateMutexW(null(), 0, wide(name).as_ptr()) });
        if handle.0.is_null() {
            return Err("HandlerSandboxAclLockFailed");
        }
        let status = unsafe { WaitForSingleObject(handle.0, 30_000) };
        if status != WAIT_OBJECT_0 && status != WAIT_ABANDONED {
            return Err("HandlerSandboxAclLockFailed");
        }
        Ok(Self(handle))
    }
}
impl Drop for EditLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0.0);
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    identity: acl::Identity,
    recursive: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    protocol: String,
    name: String,
    entries: Vec<Entry>,
}

pub struct Lease {
    pub name: String,
    pub sid: security::Sid,
    pub scratch: PathBuf,
    directory: PathBuf,
    journal: Journal,
    anchors: Vec<(acl::Target, u32, bool)>,
    // Exclusive sharing, automatically released by Windows even on hard kill.
    live: Option<File>,
    cleaned: bool,
}

fn state_root() -> Result<PathBuf> {
    let base =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("HandlerSandboxEnvironmentInvalid")?);
    if !crate::windows_policy::local_path(base.to_str().ok_or("HandlerSandboxPathInvalid")?) {
        return Err("HandlerSandboxPathInvalid");
    }
    // LOCALAPPDATA is a trusted host input, not a handler input. Never resolve
    // a state directory through a junction to some other user's files.
    let root = base.join("ToubaSandbox");
    match fs::create_dir(&root) {
        Ok(()) => security::protect_new_directory(&root)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("HandlerSandboxStateUnavailable"),
    }
    drop(acl::open(&root, true)?);
    security::verify_private_directory(&root)?;
    Ok(root)
}

impl Lease {
    pub fn create(policy: &Policy) -> Result<Self> {
        let _edit = EditLock::acquire()?;
        let root = state_root()?;
        recover(&root)?;
        let name = security::random_name()?;
        let directory = root.join(&name);
        fs::create_dir(&directory).map_err(|_| "HandlerSandboxStateUnavailable")?;
        security::protect_new_directory(&directory)?;
        let live = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(directory.join("live"))
            .map_err(|_| "HandlerSandboxStateUnavailable")?;
        let scratch = directory.join("scratch");
        fs::create_dir(&scratch).map_err(|_| "HandlerSandboxStateUnavailable")?;
        let journal = Journal {
            protocol: "touba-windows-acl-lease-v1".into(),
            name: name.clone(),
            entries: vec![],
        };
        // Journal exists durably before the profile and before any permission.
        save(&directory, &journal)?;
        let sid = security::profile(&name)?;
        let mut value = Self {
            name,
            sid,
            scratch,
            directory,
            journal,
            anchors: vec![],
            live: Some(live),
            cleaned: false,
        };
        let result = (|| {
            value.add(Path::new(&policy.cwd), acl::METADATA, false)?;
            value.add(&value.scratch.clone(), acl::READ | acl::WRITE, true)?;
            for path in &policy.code {
                value.add(Path::new(path), acl::CODE, false)?;
                value.add(
                    Path::new(path)
                        .parent()
                        .ok_or("HandlerSandboxPathInvalid")?,
                    acl::CODE_DIRECTORY,
                    false,
                )?;
            }
            for path in &policy.read {
                value.add(Path::new(path), acl::READ, true)?;
            }
            for path in &policy.write {
                value.add(Path::new(path), acl::WRITE, true)?;
            }
            // Flush the complete prepared inventory once, before applying any
            // ACE. Large explicit SDK inventories do not need one fsync/file.
            save(&value.directory, &value.journal)?;
            for (target, rights, recursive) in &value.anchors {
                acl::grant(target, value.sid.0, *rights, *recursive)?;
            }
            Ok(())
        })();
        // Drop acquires the edit lock, so release it before dropping on error.
        drop(_edit);
        result?;
        Ok(value)
    }

    fn add(&mut self, path: &Path, rights: u32, recursive: bool) -> Result<()> {
        // Host policy may never expose the launcher's own recovery database.
        let state = self
            .directory
            .parent()
            .ok_or("HandlerSandboxStateInvalid")?;
        if path
            .to_string_lossy()
            .to_lowercase()
            .starts_with(&state.to_string_lossy().to_lowercase())
            && path != self.scratch
        {
            return Err("HandlerSandboxStateScopeForbidden");
        }
        let target = acl::open(path, true)?;
        if target.directory && recursive {
            acl::tree(path)?;
        }
        if target.directory && !recursive && rights == acl::CODE {
            return Err("HandlerSandboxPathInvalid");
        }
        if !target.directory && rights == acl::CODE_DIRECTORY {
            return Err("HandlerSandboxPathInvalid");
        }
        // Persist the exact object identity before SetSecurityInfo. Recovery
        // cannot mistake a replacement at the same name for the original.
        if let Some(entry) = self
            .journal
            .entries
            .iter_mut()
            .find(|entry| entry.identity == target.identity)
        {
            entry.recursive |= recursive;
        } else {
            self.journal.entries.push(Entry {
                path: path.into(),
                identity: target.identity.clone(),
                recursive,
            });
        }
        // Cwd metadata is NOT inherited: it must not expose the project tree.
        if let Some((_, existing, _)) = self.anchors.iter_mut().find(|(other, _, inherits)| {
            other.identity == target.identity && *inherits == recursive
        }) {
            *existing |= rights;
        } else {
            self.anchors.push((target, rights, recursive));
        }
        Ok(())
    }

    pub fn cleanup(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        let _edit = EditLock::acquire()?;
        cleanup_entries(&self.journal, self.sid.0)?;
        security::delete_profile(&self.name)?;
        self.anchors.clear();
        self.live.take();
        fs::remove_dir_all(&self.directory).map_err(|_| "HandlerSandboxStateCleanupFailed")?;
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.cleanup();
        }
    }
}

fn save(directory: &Path, journal: &Journal) -> Result<()> {
    // Journal updates are append-safe by replacing only after a complete,
    // flushed new record. Windows rename does not overwrite an open file.
    let bytes = serde_json::to_vec(journal).map_err(|_| "HandlerSandboxStateInvalid")?;
    let pending = directory.join("pending.json");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&pending)
        .map_err(|_| "HandlerSandboxStateWriteFailed")?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "HandlerSandboxStateWriteFailed")?;
    drop(file);
    // MoveFileEx replaces atomically on a single volume; WRITE_THROUGH makes
    // the rename durable before the corresponding ACL is applied.
    unsafe {
        check(
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                wide(&pending).as_ptr(),
                wide(directory.join("journal.json")).as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            ),
            "HandlerSandboxStateWriteFailed",
        )
    }
}

fn cleanup_entries(journal: &Journal, sid: windows_sys::Win32::Security::PSID) -> Result<()> {
    // Parents first: remove inherited ACEs before processing explicit child
    // permissions, including files newly created in writable directories.
    let mut entries = journal.entries.iter().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path.components().count());
    for entry in entries {
        let target = acl::open(&entry.path, false)?;
        if target.identity != entry.identity {
            return Err("HandlerSandboxStateObjectChanged");
        }
        acl::revoke(&target, sid)?;
        if target.directory && entry.recursive {
            // Do not follow newly created reparse points. They received no
            // grants; touching their targets would cross the original scope.
            let mut pending = vec![entry.path.clone()];
            let mut count = 0;
            while let Some(dir) = pending.pop() {
                for child in fs::read_dir(dir).map_err(|_| "HandlerSandboxAclCleanupFailed")? {
                    let path = child.map_err(|_| "HandlerSandboxAclCleanupFailed")?.path();
                    use std::os::windows::fs::MetadataExt;
                    let meta = fs::symlink_metadata(&path)
                        .map_err(|_| "HandlerSandboxAclCleanupFailed")?;
                    if meta.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                    {
                        continue;
                    }
                    count += 1;
                    if count > 100_000 {
                        return Err("HandlerSandboxScopeTooLarge");
                    }
                    acl::revoke(&acl::open(&path, false)?, sid)?;
                    if meta.is_dir() {
                        pending.push(path);
                    }
                }
            }
        }
    }
    Ok(())
}

fn recover(root: &Path) -> Result<()> {
    for item in fs::read_dir(root).map_err(|_| "HandlerSandboxStateUnavailable")? {
        let directory = item.map_err(|_| "HandlerSandboxStateUnavailable")?.path();
        let name = directory
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("HandlerSandboxStateInvalid")?;
        if !security::valid_name(name) {
            return Err("HandlerSandboxStateInvalid");
        }
        drop(acl::open(&directory, true)?);
        security::verify_private_directory(&directory)?;
        let live = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(directory.join("live"))
        {
            Ok(file) => file,
            Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => continue,
            Err(_) => return Err("HandlerSandboxStateUnavailable"),
        };
        let path = directory.join("journal.json");
        if path.exists() {
            let mut bytes = Vec::new();
            File::open(path)
                .map_err(|_| "HandlerSandboxStateInvalid")?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "HandlerSandboxStateInvalid")?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("HandlerSandboxStateInvalid");
            }
            let journal: Journal =
                serde_json::from_slice(&bytes).map_err(|_| "HandlerSandboxStateInvalid")?;
            if journal.protocol != "touba-windows-acl-lease-v1"
                || journal.name != name
                || journal.entries.len() > 4100
            {
                return Err("HandlerSandboxStateInvalid");
            }
            // Usually the last Job handle has already killed all children.
            // If Windows still exposes it, wait for teardown before cleanup.
            let job = Handle(unsafe {
                OpenJobObjectW(
                    JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
                    0,
                    wide(format!("Global\\{name}")).as_ptr(),
                )
            });
            if !job.0.is_null() {
                unsafe {
                    check(
                        TerminateJobObject(job.0, 125),
                        "HandlerSandboxJobTeardownFailed",
                    )?;
                }
                security::wait_job_empty(job.0)?;
            } else if unsafe { GetLastError() } != ERROR_FILE_NOT_FOUND {
                return Err("HandlerSandboxJobRecoveryFailed");
            }
            let sid = security::profile_sid(name)?;
            cleanup_entries(&journal, sid.0)?;
            security::delete_profile(name)?;
        }
        drop(live);
        fs::remove_dir_all(&directory).map_err(|_| "HandlerSandboxStateCleanupFailed")?;
    }
    Ok(())
}
