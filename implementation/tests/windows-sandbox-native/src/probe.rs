//! Native experiment only. ACL replacement is restricted to freshly created
//! fixtures owned by this process. It is NOT safe for arbitrary user paths.
use super::progress::{self, Stage};
use std::ffi::{c_void, OsStr};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::net::{TcpListener, TcpStream};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Networking::WinSock::{WSACleanup, WSAStartup, WSADATA, WSAEACCES};
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::Isolation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Registry::*;
use windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::WindowsProgramming::*;

type Result<T> = std::result::Result<T, String>;

// Metadata access is separate from reading contents. CreateFile's Win32 path
// can request FILE_READ_ATTRIBUTES even when the caller asks for write only.
// This candidate mask must retain the negative file-content read control.
const WRITE_TARGET_RIGHTS: u32 = FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES;

fn io_failure(label: &str, error: std::io::Error) -> String {
    if let Some(code) = error.raw_os_error() {
        progress::record_os_error(code);
    }
    format!("{label}: {error}")
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn checked(value: i32, operation: &str) -> Result<()> {
    if value == 0 {
        Err(format!("{operation}: Win32 {}", unsafe { GetLastError() }))
    } else {
        Ok(())
    }
}

fn require(value: bool, label: &str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(label.into())
    }
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct Profile {
    name: Vec<u16>,
    sid: PSID,
    capabilities: Vec<RegistryCapability>,
}

// Experimental comparison only, never a network grant or production default.
struct RegistryCapability {
    groups: *mut PSID,
    group_count: u32,
    sids: *mut PSID,
    count: u32,
}
impl RegistryCapability {
    fn create(name: &str) -> Result<Self> {
        let mut value = Self {
            groups: null_mut(),
            group_count: 0,
            sids: null_mut(),
            count: 0,
        };
        unsafe {
            checked(
                DeriveCapabilitySidsFromName(
                    wide(name).as_ptr(),
                    &mut value.groups,
                    &mut value.group_count,
                    &mut value.sids,
                    &mut value.count,
                ),
                "Derive diagnostic capability",
            )?;
            require(
                value.count == 1 && !value.sids.is_null(),
                "Unexpected registryRead SID count",
            )?;
            require(IsValidSid(*value.sids) != 0, "Invalid registryRead SID")?;
        }
        Ok(value)
    }
    fn sid(&self) -> PSID {
        unsafe { *self.sids }
    }
}
impl Drop for RegistryCapability {
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
impl Profile {
    fn create(name: &str, registry_read: bool, filtered_network: bool) -> Result<Self> {
        let mut capabilities = Vec::new();
        if registry_read {
            capabilities.push(RegistryCapability::create("registryRead")?);
        }
        if filtered_network {
            for capability in [
                "internetClient",
                "internetClientServer",
                "privateNetworkClientServer",
            ] {
                capabilities.push(RegistryCapability::create(capability)?);
            }
        }
        let name = wide(name);
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        require(
            result >= 0,
            &format!("CreateAppContainerProfile: HRESULT {result:#x}"),
        )?;
        Ok(Self {
            name,
            sid,
            capabilities,
        })
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            let result = DeleteAppContainerProfile(self.name.as_ptr());
            if result < 0 {
                eprintln!("Profile cleanup failed: {result:#x}");
            }
            FreeSid(self.sid);
        }
    }
}

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        // Exact unique directory created below, never an environment root.
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("Fixture cleanup failed: {error}");
        }
    }
}

fn current_token() -> Result<Handle> {
    let mut token = null_mut();
    unsafe {
        checked(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
            "OpenProcessToken",
        )?;
    }
    Ok(Handle(token))
}

fn token_buffer(class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let token = current_token()?;
    token_buffer_for(token.0, class)
}

fn registry_path(root: &Path) -> Result<(String, String)> {
    let user = token_buffer(TokenUser)?;
    let mut text = null_mut();
    unsafe {
        checked(
            ConvertSidToStringSidW((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text),
            "String user SID",
        )?;
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        let name = root
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid fixture name")?;
        require(
            name.starts_with("touba-probe-") && !name.contains(['\\', '/', '\0']),
            "Invalid registry fixture name",
        )?;
        Ok((sid, format!("Software\\{name}")))
    }
}

struct RegistryFixture(Vec<u16>);
impl RegistryFixture {
    fn create(root: &Path) -> Result<Self> {
        let (sid, subkey) = registry_path(root)?;
        let mut descriptor = null_mut();
        unsafe {
            checked(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(format!("D:P(A;;KA;;;{sid})")).as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                ),
                "Private registry descriptor",
            )?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let mut key = null_mut();
            let mut disposition = 0;
            let status = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(&subkey).as_ptr(),
                0,
                null(),
                REG_OPTION_VOLATILE,
                KEY_ALL_ACCESS,
                &attributes,
                &mut key,
                &mut disposition,
            );
            LocalFree(descriptor);
            require(status == 0, &format!("Private registry fixture: {status}"))?;
            RegCloseKey(key);
            require(
                disposition == REG_CREATED_NEW_KEY,
                "Registry fixture already exists",
            )?;
            let fixture = Self(wide(&subkey));
            let status = RegOpenKeyExW(
                HKEY_USERS,
                wide(format!("{sid}\\{subkey}")).as_ptr(),
                0,
                KEY_READ,
                &mut key,
            );
            if status == 0 {
                RegCloseKey(key);
            }
            require(
                status == 0,
                &format!("Host registry positive control: {status}"),
            )?;
            Ok(fixture)
        }
    }
}
impl Drop for RegistryFixture {
    fn drop(&mut self) {
        // Exact volatile key just created by this test, never a preexisting key.
        let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, self.0.as_ptr()) };
        if status != 0 {
            eprintln!("Registry fixture cleanup failed: {status}");
        }
    }
}

fn private_registry_denied(root: &Path) -> Result<()> {
    let (sid, subkey) = registry_path(root)?;
    let mut key = null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_USERS,
            wide(format!("{sid}\\{subkey}")).as_ptr(),
            0,
            KEY_READ,
            &mut key,
        )
    };
    if status == 0 {
        unsafe {
            RegCloseKey(key);
        }
    }
    require(
        status == ERROR_ACCESS_DENIED,
        &format!("Private registry access expected denied, got {status}"),
    )
}

fn token_buffer_for(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut bytes);
        let error = GetLastError();
        // Different information classes return ERROR_BAD_LENGTH or
        // ERROR_INSUFFICIENT_BUFFER for this sizing call on build 26100.
        // Neither is a successful query. Only the following retrieval may
        // produce data; retain the original error when no bounded size exists.
        require(
            bytes > 0 && bytes <= 4096,
            &format!("GetTokenInformation({class}) sizing: Win32 {error}; bytes={bytes}"),
        )?;
    }
    let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    unsafe {
        checked(
            GetTokenInformation(token, class, buffer.as_mut_ptr().cast(), bytes, &mut bytes),
            &format!("GetTokenInformation({class}) retrieval"),
        )?;
    }
    Ok(buffer)
}

fn observe_token(process: HANDLE, profile: &Profile) -> Result<()> {
    let mut token = null_mut();
    unsafe {
        checked(
            OpenProcessToken(process, TOKEN_QUERY, &mut token),
            "Child token",
        )?;
    }
    let token = Handle(token);
    let ac = token_buffer_for(token.0, TokenIsAppContainer)?;
    let package = token_buffer_for(token.0, TokenAppContainerSid)?;
    let capabilities = token_buffer_for(token.0, TokenCapabilities)?;
    let integrity = token_buffer_for(token.0, TokenIntegrityLevel)?;
    unsafe {
        require(
            *ac.as_ptr().cast::<u32>() != 0,
            "Child is not an AppContainer",
        )?;
        let sid = (*package.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()).TokenAppContainer;
        require(
            !sid.is_null() && EqualSid(sid, profile.sid) != 0,
            "Wrong child package SID",
        )?;
        let count = (*capabilities.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount;
        require(
            count as usize == profile.capabilities.len(),
            "Unexpected child capability count",
        )?;
        let groups = std::slice::from_raw_parts(
            std::ptr::addr_of!((*capabilities.as_ptr().cast::<TOKEN_GROUPS>()).Groups)
                .cast::<SID_AND_ATTRIBUTES>(),
            count as usize,
        );
        for expected in &profile.capabilities {
            require(
                groups.iter().any(|actual| {
                    EqualSid(actual.Sid, expected.sid()) != 0
                        && actual.Attributes == SE_GROUP_ENABLED as u32
                }),
                "Unexpected child capability SID or attributes",
            )?;
        }
        let sid = (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
            .Label
            .Sid;
        require(
            IsValidSid(sid) != 0 && *GetSidSubAuthorityCount(sid) == 1,
            "Invalid token integrity",
        )?;
        let rid = *GetSidSubAuthority(sid, 0);
        println!("TOKEN AppContainer=true package=expected capabilities={count} integrity={rid}");
        require(rid == 0x1000, "Expected low-integrity AppContainer token")?;
        // Observational query only: Win32 does not document a class-specific
        // output contract here. Failure is NOT evidence of either token kind.
        // The paired file-access control below verifies opt-out behavior.
        let mut value = 0u32;
        let mut bytes = 0;
        let ok = GetTokenInformation(
            token.0,
            TokenIsLessPrivilegedAppContainer,
            (&mut value as *mut u32).cast(),
            size_of::<u32>() as u32,
            &mut bytes,
        );
        if ok == 0 {
            println!(
                "TOKEN class46 direct query failed: Win32 {}; returned_bytes={bytes}; undetermined",
                GetLastError()
            );
        } else {
            println!("TOKEN class46 direct query: value={value} bytes={bytes}; behavioral check still required");
        }
    }
    Ok(())
}

fn fixture_acl(path: &Path, sid: PSID, rights: u32) -> Result<()> {
    // Preserve access for the actual user, not the Administrators group: this
    // also lets the test run with an ordinary user token on a later machine.
    let user = token_buffer(TokenUser)?;
    let owner = unsafe { (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    let entry = |sid, rights| EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: SET_ACCESS,
        grfInheritance: 0,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
            ..Default::default()
        },
    };
    let entries = [entry(owner, GENERIC_ALL), entry(sid, rights)];
    let mut acl = null_mut();
    unsafe {
        let count = if rights == 0 { 1 } else { 2 };
        let status = SetEntriesInAclW(count, entries.as_ptr(), null(), &mut acl);
        require(status == 0, &format!("SetEntriesInAclW: {status}"))?;
        let status = SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        );
        LocalFree(acl.cast());
        require(status == 0, &format!("SetNamedSecurityInfoW: {status}"))
    }
}

struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(count: u32) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        require(bytes > 0 && bytes < 65536, "Invalid process attribute size")?;
        let mut this = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        unsafe {
            checked(
                InitializeProcThreadAttributeList(this.ptr(), count, 0, &mut bytes),
                "InitializeProcThreadAttributeList",
            )?;
        }
        this.initialized = true;
        Ok(this)
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set<T>(&mut self, key: u32, value: &T) -> Result<()> {
        unsafe {
            checked(
                UpdateProcThreadAttribute(
                    self.ptr(),
                    0,
                    key as usize,
                    (value as *const T).cast(),
                    size_of::<T>(),
                    null_mut(),
                    null(),
                ),
                "UpdateProcThreadAttribute",
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

struct Running {
    process: Handle,
    job: Handle,
}
impl Running {
    fn wait(&self) -> Result<()> {
        unsafe {
            require(
                WaitForSingleObject(self.process.0, 10_000) == WAIT_OBJECT_0,
                "Child timeout",
            )?;
            let mut code = 0;
            checked(
                GetExitCodeProcess(self.process.0, &mut code),
                "GetExitCodeProcess",
            )?;
            require(
                code == 0,
                &format!(
                    "Child exit: {code:#x}; stage: {}; OS error: {:?}",
                    progress::describe(code),
                    progress::os_error(code)
                ),
            )
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        // Also covers launch/test failure. A child must never survive the host.
        unsafe {
            TerminateJobObject(self.job.0, 125);
            WaitForSingleObject(self.process.0, 5000);
        }
    }
}

fn live_job_members(running: &Running, profile: &Profile) -> Result<Vec<Handle>> {
    // The host checks both live processes before closing the Job, not just
    // that a heartbeat once existed. Query handles do not keep the Job alive.
    let mut storage = [0usize; 8];
    unsafe {
        checked(
            QueryInformationJobObject(
                running.job.0,
                JobObjectBasicProcessIdList,
                storage.as_mut_ptr().cast(),
                size_of_val(&storage) as u32,
                null_mut(),
            ),
            "Live Job process IDs",
        )?;
        let info = storage.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        require(
            (*info).NumberOfAssignedProcesses == 2 && (*info).NumberOfProcessIdsInList == 2,
            "Expected a live parent and descendant before Job closure",
        )?;
        // Keep a raw pointer to the variable-length trailing array rather
        // than creating a Rust reference to its one-element C declaration.
        let ids = std::slice::from_raw_parts(
            std::ptr::addr_of!((*info).ProcessIdList).cast::<usize>(),
            2,
        );
        let parent = GetProcessId(running.process.0) as usize;
        require(
            parent != 0 && ids.contains(&parent) && ids[0] != ids[1],
            "Invalid Job membership",
        )?;
        let mut members = Vec::new();
        for &id in ids {
            let pid = u32::try_from(id).map_err(|_| "Invalid process ID width")?;
            let process = Handle(OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                pid,
            ));
            require(
                !process.0.is_null(),
                &format!("Open Job member: {}", GetLastError()),
            )?;
            require(
                WaitForSingleObject(process.0, 0) == WAIT_TIMEOUT,
                "Job member already exited",
            )?;
            observe_token(process.0, profile)?;
            members.push(process);
        }
        Ok(members)
    }
}

fn launch(
    executable: &Path,
    root: &Path,
    profile: &Profile,
    mode: &str,
    argument: &str,
    process: bool,
    detached: bool,
) -> Result<Running> {
    // All arguments here are generated fixture paths/modes, never user input.
    let fields = [
        executable.to_string_lossy().into_owned(),
        "--child".into(),
        mode.into(),
        root.to_string_lossy().into_owned(),
        argument.into(),
    ];
    require(
        fields
            .iter()
            .all(|v| !v.contains(['"', '\0']) && !v.ends_with('\\')),
        "Invalid fixture argument",
    )?;
    let mut command = wide(
        fields
            .iter()
            .map(|v| format!("\"{v}\""))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let lpac = mode != "appcontainer-control";
    let mut attributes = Attributes::new(1 + u32::from(lpac) + u32::from(!process))?;
    let registry_entry: Vec<_> = profile
        .capabilities
        .iter()
        .map(|cap| SID_AND_ATTRIBUTES {
            Sid: cap.sid(),
            Attributes: SE_GROUP_ENABLED as u32,
        })
        .collect();
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        Capabilities: registry_entry.as_ptr().cast_mut(),
        CapabilityCount: registry_entry.len() as u32,
        Reserved: 0,
    };
    let opt_out = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    let child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security)?;
    if lpac {
        attributes.set(
            PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
            &opt_out,
        )?;
    }
    if !process {
        attributes.set(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy)?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes.ptr();
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    require(!job.0.is_null(), "CreateJobObjectW failed")?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        checked(
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            ),
            "SetInformationJobObject",
        )?;
    }
    let system_root = std::env::var("SystemRoot").map_err(|_| "SystemRoot missing")?;
    // AppContainer requires LOCALAPPDATA to be present even with an explicit
    // environment. Use this disposable fixture, not the host's private path.
    let environment = super::environment::block(&system_root, &root.to_string_lossy())?;
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        checked(
            CreateProcessW(
                wide(executable).as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | if detached {
                        DETACHED_PROCESS
                    } else {
                        CREATE_NO_WINDOW
                    },
                environment.as_ptr().cast::<c_void>(),
                wide(root).as_ptr(),
                &startup.StartupInfo,
                &mut pi,
            ),
            "CreateProcessW LPAC",
        )?;
    }
    let running = Running {
        process: Handle(pi.hProcess),
        job,
    };
    let thread = Handle(pi.hThread);
    unsafe {
        if AssignProcessToJobObject(running.job.0, running.process.0) == 0 {
            // It has not executed any user instruction yet.
            TerminateProcess(running.process.0, 125);
            return Err(format!("AssignProcessToJobObject: {}", GetLastError()));
        }
        observe_token(running.process.0, profile)?;
        require(ResumeThread(thread.0) != u32::MAX, "ResumeThread failed")?;
    }
    Ok(running)
}

fn denied<T>(result: std::io::Result<T>) -> bool {
    matches!(result, Err(ref e) if e.kind() == std::io::ErrorKind::PermissionDenied)
}

// No stdio setup/NUL opens before CreateProcess: a permission error while
// opening NUL must not be misclassified as a child-process policy refusal.
fn spawn_descendant(root: &Path, mode: &str, inherit_cwd: bool) -> std::io::Result<Handle> {
    let executable = std::env::current_exe()?;
    let fields = [
        executable.to_string_lossy().into_owned(),
        "--child".into(),
        mode.into(),
        root.to_string_lossy().into_owned(),
        "unused".into(),
    ];
    if fields
        .iter()
        .any(|v| v.contains(['"', '\0']) || v.ends_with('\\'))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid descendant fixture argument",
        ));
    }
    let mut command = wide(
        fields
            .iter()
            .map(|v| format!("\"{v}\""))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    let cwd = wide(root);
    unsafe {
        if CreateProcessW(
            wide(&executable).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            DETACHED_PROCESS,
            null(),
            if inherit_cwd { null() } else { cwd.as_ptr() },
            &startup,
            &mut pi,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    let _thread = Handle(pi.hThread);
    Ok(Handle(pi.hProcess))
}

struct Winsock;
impl Winsock {
    fn initialize() -> Result<Self> {
        let mut data: WSADATA = unsafe { zeroed() };
        let error = unsafe { WSAStartup(0x0202, &mut data) };
        if error != 0 {
            progress::record_os_error(error);
            return Err(format!(
                "WSAStartup failed: {error}; not a network denial proof"
            ));
        }
        Ok(Self)
    }
}
impl Drop for Winsock {
    fn drop(&mut self) {
        unsafe {
            WSACleanup();
        }
    }
}

fn child(mode: &str, root: &Path, argument: &str) -> Result<()> {
    progress::mark(Stage::AppContainer);
    let token = token_buffer(TokenIsAppContainer)?;
    require(
        unsafe { *token.as_ptr().cast::<u32>() } != 0,
        "Not an AppContainer",
    )?;
    if mode == "appcontainer-control" {
        progress::mark(Stage::AppContainerControl);
        require(
            fs::read(root.join("all-packages.txt")).ok().as_deref() == Some(b"packages-canary"),
            "Ordinary AppContainer cannot read the ALL_APPLICATION_PACKAGES control",
        )?;
        return fs::write(
            root.join("child-result.txt"),
            super::socket_probe::observe(argument)?,
        )
        .map_err(|e| e.to_string());
    }
    progress::mark(Stage::Lpac);
    require(
        denied(fs::read(root.join("all-packages.txt"))),
        "LPAC opt-out did not deny the ALL_APPLICATION_PACKAGES-only file",
    )?;
    progress::mark(Stage::Environment);
    require(
        std::env::var_os("TOUBA_PRIVATE_CANARY").is_none(),
        "Host environment leaked",
    )?;
    match mode {
        "dns-probe" => {
            progress::mark(Stage::DnsProbe);
            let port = argument
                .parse()
                .map_err(|e| format!("DNS fixture port: {e}"))?;
            let status = super::dns_probe::query(port);
            fs::write(
                root.join("child-result.txt"),
                format!("DnsQueryEx status={status}"),
            )
            .map_err(|e| e.to_string())?;
            require(status != 87, "DNS request invalid; not a confinement proof")
        }
        "socket-filtered" => {
            progress::mark(Stage::SocketProbe);
            fs::write(
                root.join("child-result.txt"),
                super::socket_probe::filtered(argument)?,
            )
            .map_err(|e| e.to_string())
        }
        "socket-diagnostic" => {
            progress::mark(Stage::SocketProbe);
            fs::write(
                root.join("child-result.txt"),
                super::socket_probe::observe(argument)?,
            )
            .map_err(|e| e.to_string())
        }
        "files" => {
            progress::mark(Stage::Read);
            require(
                fs::read(root.join("read.txt")).ok().as_deref() == Some(b"allowed-read"),
                "Declared read failed",
            )?;
            progress::mark(Stage::ReadOnly);
            require(
                denied(OpenOptions::new().write(true).open(root.join("read.txt"))),
                "Read scope allowed write",
            )?;
            progress::mark(Stage::WriteOnly);
            require(
                denied(fs::read(root.join("write.txt"))),
                "Write scope allowed read",
            )?;
            progress::mark(Stage::WriteOpen);
            let opened = OpenOptions::new()
                .write(true)
                .open(root.join("write.txt"))
                .map_err(|e| io_failure("Declared write open", e))?;
            drop(opened);
            progress::mark(Stage::Write);
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(root.join("write.txt"))
                .map_err(|e| io_failure("Declared write truncate", e))?;
            progress::mark(Stage::WriteCommit);
            file.write_all(b"allowed-write")
                .map_err(|e| io_failure("Declared write bytes", e))?;
            progress::mark(Stage::Private);
            require(
                denied(fs::read(root.join("private.txt"))),
                "Private file was not denied",
            )?;
            progress::mark(Stage::Symlink);
            require(
                denied(fs::read(root.join("link.txt"))),
                "Symlink escaped the scope",
            )?;
            progress::mark(Stage::Listing);
            require(
                denied(fs::read_dir(root)),
                "Traversal granted directory listing",
            )?;
            // AppContainer has a documented exception for explicitly granted
            // Medium-or-lower resources; ordinary MIC intuition is insufficient.
            OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(root.join("medium-integrity.txt"))
                .and_then(|mut f| f.write_all(b"explicit-medium-write"))
                .map_err(|e| io_failure("Explicit Medium write control", e))?;
            progress::mark(Stage::HighIntegrity);
            require(
                denied(
                    OpenOptions::new()
                        .write(true)
                        .open(root.join("high-integrity.txt")),
                ),
                "High-integrity canary write was permitted",
            )?;
            Ok(())
        }
        "registry-denied" => private_registry_denied(root),
        "network-denied" => {
            progress::mark(Stage::WinsockStartup);
            let _winsock = Winsock::initialize()?;
            progress::mark(Stage::Network);
            let address = argument.parse().map_err(|_| "Invalid fixture address")?;
            match TcpStream::connect_timeout(&address, Duration::from_millis(1000)) {
                Err(error) if error.raw_os_error() == Some(WSAEACCES) => Ok(()),
                Err(error) => Err(io_failure("Expected WSAEACCES network denial", error)),
                Ok(_) => Err("Network connection was permitted".into()),
            }
        }
        "process-denied" => {
            progress::mark(Stage::ProcessDenied);
            let result = spawn_descendant(root, "files", false);
            match result {
                Ok(process) => {
                    unsafe {
                        TerminateProcess(process.0, 125);
                        WaitForSingleObject(process.0, 5000);
                    }
                    Err("Descendant was permitted".into())
                }
                Err(error) if error.raw_os_error() == Some(ERROR_CHILD_PROCESS_BLOCKED as i32) => {
                    Ok(())
                }
                Err(error) => Err(io_failure("Wrong descendant refusal", error)),
            }
        }
        "process-inherited" | "process-inherited-cwd" => {
            progress::mark(Stage::ProcessInherited);
            let process = spawn_descendant(root, "files", mode == "process-inherited-cwd")
                .map_err(|e| io_failure("Allowed descendant creation", e))?;
            unsafe {
                require(
                    WaitForSingleObject(process.0, 5000) == WAIT_OBJECT_0,
                    "Descendant timeout",
                )?;
                let mut code = 0;
                checked(
                    GetExitCodeProcess(process.0, &mut code),
                    "Descendant exit code",
                )?;
                require(
                    code == 0,
                    &format!(
                        "Descendant failed: {code:#x}; {}; OS error: {:?}",
                        progress::describe(code),
                        progress::os_error(code)
                    ),
                )
            }
        }
        "spawn-heartbeat" => {
            progress::mark(Stage::SpawnHeartbeat);
            let _child = spawn_descendant(root, "heartbeat", true)
                .map_err(|e| io_failure("Heartbeat descendant creation", e))?;
            std::thread::sleep(Duration::from_secs(30));
            Ok(())
        }
        "heartbeat" => {
            progress::mark(Stage::Heartbeat);
            for _ in 0..500 {
                OpenOptions::new()
                    .append(true)
                    .open(root.join("heartbeat.txt"))
                    .and_then(|mut f| f.write_all(b"x"))
                    .map_err(|e| io_failure("Heartbeat write", e))?;
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(())
        }
        _ => Err("Unknown child case".into()),
    }
}

fn host(
    registry_read: bool,
    filtered_network: bool,
    filter_mode: Option<super::wfp::Mode>,
    network_caps: bool,
) -> Result<()> {
    // Job 4 isolates CREATE_NO_WINDOW plus child restriction as the startup
    // failure. DETACHED_PROCESS preserves the identical permission boundary.
    let detached = true;
    let unique = format!(
        "touba-probe-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let root = std::env::temp_dir().join(&unique);
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let _fixture = Fixture(root.clone());
    let profile = Profile::create(&unique, registry_read, network_caps)?;
    let _registry_fixture = RegistryFixture::create(&root)?;
    let executable = root.join("probe.exe");
    fs::copy(std::env::current_exe().unwrap(), &executable).map_err(|e| e.to_string())?;
    for (name, bytes) in [
        ("read.txt", "allowed-read"),
        ("write.txt", "private-before-write"),
        ("private.txt", "private-canary"),
        ("heartbeat.txt", ""),
        ("child-result.txt", ""),
        ("high-integrity.txt", "protected-high"),
        ("medium-integrity.txt", "protected-medium"),
        ("all-packages.txt", "packages-canary"),
    ] {
        fs::write(root.join(name), bytes).map_err(|e| e.to_string())?;
    }
    // A link inside an accessible path must not grant rights to its target.
    std::os::windows::fs::symlink_file(root.join("private.txt"), root.join("link.txt"))
        .map_err(|e| format!("Fixture symlink: {e}"))?;
    fixture_acl(
        &root,
        profile.sid,
        FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    )?;
    fixture_acl(
        &executable,
        profile.sid,
        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
    )?;
    fixture_acl(&root.join("read.txt"), profile.sid, FILE_GENERIC_READ)?;
    fixture_acl(&root.join("write.txt"), profile.sid, WRITE_TARGET_RIGHTS)?;
    fixture_acl(
        &root.join("heartbeat.txt"),
        profile.sid,
        WRITE_TARGET_RIGHTS,
    )?;
    fixture_acl(
        &root.join("child-result.txt"),
        profile.sid,
        WRITE_TARGET_RIGHTS,
    )?;
    fixture_acl(&root.join("private.txt"), profile.sid, 0)?;
    let mut all_packages = [0usize; 16];
    let mut sid_size = size_of_val(&all_packages) as u32;
    unsafe {
        checked(
            CreateWellKnownSid(
                WinBuiltinAnyPackageSid,
                null_mut(),
                all_packages.as_mut_ptr().cast(),
                &mut sid_size,
            ),
            "Create ALL_APPLICATION_PACKAGES SID",
        )?;
    }
    fixture_acl(
        &root.join("all-packages.txt"),
        all_packages.as_mut_ptr().cast(),
        FILE_GENERIC_READ,
    )?;
    fixture_acl(
        &root.join("medium-integrity.txt"),
        profile.sid,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
    )?;
    super::integrity::fixture_medium(&root.join("medium-integrity.txt"))?;
    fixture_acl(
        &root.join("high-integrity.txt"),
        profile.sid,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
    )?;
    // This canary is explicitly high: never infer its label from the host token.
    super::integrity::fixture_high(&root.join("high-integrity.txt"))?;
    // Isolate the read-only DACL test from MIC: low integrity alone must never
    // allow writing to this read-only fixture.
    super::integrity::fixture_low(&root.join("read.txt"))?;
    println!(
        "FIXTURE initial write label: {:?}",
        super::integrity::label(&root.join("write.txt"))?
    );
    println!(
        "FIXTURE effective write label: {:?}",
        super::integrity::label(&root.join("write.txt"))?
    );
    println!(
        "FIXTURE protected canary label: {:?}",
        super::integrity::label(&root.join("high-integrity.txt"))?
    );
    std::env::set_var("TOUBA_PRIVATE_CANARY", "host-only-fixture");
    let elevation = token_buffer(TokenElevation)?;
    println!(
        "HOST token_elevated={}; this is not a Windows 11 standard-user qualification",
        unsafe { *elevation.as_ptr().cast::<u32>() }
    );
    println!(
        "HOST console_mode={}",
        if detached { "detached" } else { "no-window" }
    );
    println!("HOST registryRead={registry_read}; filtered_network={filtered_network}");
    let dns_server = if filtered_network {
        Some(super::dns_probe::Server::start()?)
    } else {
        None
    };
    let mut failures = Vec::new();
    let events = if filtered_network {
        Some(super::wfp_events::Events::start(profile.sid)?)
    } else {
        None
    };
    if let Some(dns) = &dns_server {
        let status = super::dns_probe::query(dns.port);
        if status == 9003 && dns.count() > 0 {
            println!("PASS DNS host positive control: real query and NXDOMAIN response");
        } else {
            let failure = format!(
                "DNS host positive control: status={status}, received={}",
                dns.count()
            );
            println!("FAIL {failure}");
            failures.push(failure);
        }
    }
    let filters = filter_mode
        .map(|mode| super::wfp::Filters::install(profile.sid, mode))
        .transpose()?;
    if filters.is_some() {
        println!("WFP persistent filters installed; engine closed before all child launches");
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let address = listener.local_addr().unwrap();
    TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .map_err(|e| format!("Host TCP control: {e}"))?;
    let _host_connection = listener
        .accept()
        .map_err(|e| format!("Accept host TCP control: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    for (mode, argument, process) in [
        ("appcontainer-control", address.to_string(), false),
        ("socket-diagnostic", address.to_string(), false),
        ("files", "unused".to_string(), false),
        ("registry-denied", "unused".to_string(), false),
        ("network-denied", address.to_string(), false),
        ("process-denied", "unused".to_string(), false),
        ("process-inherited", "unused".to_string(), true),
        ("process-inherited-cwd", "unused".to_string(), true),
    ] {
        println!("RUN {mode}");
        fs::write(root.join("child-result.txt"), "").map_err(|e| e.to_string())?;
        match launch(
            &executable,
            &root,
            &profile,
            mode,
            &argument,
            process,
            detached,
        )
        .and_then(|child| child.wait())
        {
            Ok(()) => {
                println!("PASS {mode}");
                if matches!(mode, "appcontainer-control" | "socket-diagnostic") {
                    println!(
                        "SOCKET OBSERVATIONS {mode}:\n{}",
                        fs::read_to_string(root.join("child-result.txt"))
                            .map_err(|e| e.to_string())?
                    );
                }
            }
            Err(error) => {
                let detail = fs::read_to_string(root.join("child-result.txt")).unwrap_or_default();
                let failure = format!("{mode}: {error}; {detail}");
                println!("FAIL {failure}");
                failures.push(failure);
            }
        }
        if matches!(mode, "appcontainer-control" | "socket-diagnostic") {
            if let Some(events) = &events {
                println!("WFP AUDIT AFTER {mode}");
                events.report()?;
            }
        }
    }
    if filtered_network {
        for (mode, argument) in [
            ("socket-filtered", address.to_string()),
            ("dns-probe", dns_server.as_ref().unwrap().port.to_string()),
        ] {
            let before = dns_server.as_ref().unwrap().count();
            fs::write(root.join("child-result.txt"), "").map_err(|e| e.to_string())?;
            let result = launch(
                &executable,
                &root,
                &profile,
                mode,
                &argument,
                false,
                detached,
            )
            .and_then(|child| child.wait());
            let detail = fs::read_to_string(root.join("child-result.txt")).unwrap_or_default();
            println!("WFP {mode}: {result:?}; {detail}");
            if let Some(events) = &events {
                println!("WFP AUDIT AFTER {mode}");
                events.report()?;
            }
            if let Err(error) = result {
                failures.push(format!("{mode}: {error}; {detail}"));
            }
            if mode == "dns-probe" {
                let count = dns_server.as_ref().unwrap().count() - before;
                println!("WFP DNS packets received by host: {count}");
                if filter_mode.is_none() && network_caps {
                    if count == 0 {
                        failures.push(
                            "DNS positive network-capability control emitted no query".into(),
                        );
                    }
                } else if count != 0 {
                    failures.push("DNS escaped the invocation filter".into());
                }
            }
        }
    }
    require(
        fs::read(root.join("write.txt")).unwrap() == b"allowed-write",
        "Write positive control missing",
    )?;
    require(
        fs::read(root.join("private.txt")).unwrap() == b"private-canary",
        "Private canary modified",
    )?;
    require(
        fs::read(root.join("high-integrity.txt")).unwrap() == b"protected-high",
        "High-integrity canary modified",
    )?;
    require(
        fs::read(root.join("medium-integrity.txt")).unwrap() == b"explicit-medium-write",
        "Explicit Medium write positive control missing",
    )?;
    require(
        matches!(listener.accept(), Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "Unexpected sandbox connection reached the listener",
    )?;
    println!("RUN job-descendant-teardown");
    let running = launch(
        &executable,
        &root,
        &profile,
        "spawn-heartbeat",
        "unused",
        true,
        detached,
    )?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while fs::metadata(root.join("heartbeat.txt")).unwrap().len() < 2 && Instant::now() < deadline {
        if unsafe { WaitForSingleObject(running.process.0, 0) } == WAIT_OBJECT_0 {
            let detail = fs::read_to_string(root.join("child-result.txt")).unwrap_or_default();
            return Err(format!(
                "Heartbeat parent exited: {:?}; {detail}",
                running.wait()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    require(
        fs::metadata(root.join("heartbeat.txt")).unwrap().len() >= 2,
        "Descendant never wrote: no teardown proof",
    )?;
    let members = live_job_members(&running, &profile)?;
    // Close the last Job handle explicitly, without TerminateJobObject, to
    // prove kernel teardown if the supervising process dies unexpectedly.
    let job = running.job.0;
    let process = running.process.0;
    std::mem::forget(running);
    unsafe {
        checked(CloseHandle(job), "CloseHandle(job)")?;
    }
    let process = Handle(process);
    unsafe {
        require(
            WaitForSingleObject(process.0, 5000) == WAIT_OBJECT_0,
            "Parent survived job closure",
        )?;
        for member in &members {
            require(
                WaitForSingleObject(member.0, 5000) == WAIT_OBJECT_0,
                "Job member survived last Job handle closure",
            )?;
        }
    }
    std::thread::sleep(Duration::from_millis(100));
    let length = fs::metadata(root.join("heartbeat.txt")).unwrap().len();
    std::thread::sleep(Duration::from_millis(250));
    require(
        fs::metadata(root.join("heartbeat.txt")).unwrap().len() == length,
        "Descendant survived job closure",
    )?;
    println!("PASS job-descendant-teardown");
    if let Some(events) = &events {
        events.report()?;
    }
    if let Some(filters) = filters {
        filters.remove_after_children_stop()?;
        println!("WFP filters removed after children stopped");
    }
    require(failures.is_empty(), &failures.join("; "))?;
    println!("PASS native primitive diagnostic; runtime integration remains separate");
    Ok(())
}

pub fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--child") {
        progress::mark(Stage::Entry);
        let result = if args.len() == 5 {
            child(&args[2], Path::new(&args[3]), &args[4])
        } else {
            Err("Invalid child invocation".into())
        };
        if let Err(error) = &result {
            if let Some(root) = args.get(3) {
                // Diagnostic fixture only. No host data or credentials involved.
                let _ = fs::write(Path::new(root).join("child-result.txt"), error);
            }
        }
        // No inherited handles. Exit status is the host's fail-closed signal.
        std::process::exit(if result.is_ok() {
            0
        } else {
            progress::failure_code() as i32
        });
    }
    if args.get(1).map(String::as_str) == Some("--network-matrix") && args.len() == 2 {
        if let Err(error) = super::socket_probe::host_security() {
            eprintln!("HOST socket inspection: {error}");
        }
        // A bounded causal experiment. Preserve every outcome, including the
        // deliberately unusable controls; never treat it as a release gate.
        for (name, mode, caps) in [
            ("no-filter-no-network-caps", None, false),
            ("no-filter-with-network-caps", None, true),
            (
                "original-appcontainer-loopback",
                Some(super::wfp::Mode::Original),
                true,
            ),
            (
                "block-all-including-loopback",
                Some(super::wfp::Mode::BlockAll),
                true,
            ),
            ("loopback-only", Some(super::wfp::Mode::LoopbackOnly), true),
            (
                "allocation-without-network-caps",
                Some(super::wfp::Mode::SocketAllocation),
                false,
            ),
        ] {
            println!("MATRIX BEGIN {name}");
            let result = host(true, true, mode, caps);
            println!("MATRIX END {name}: target qualification {result:?}");
        }
        // Measurements, not a qualified backend. This invocation deliberately
        // stays red until a single candidate satisfies the complete contract.
        eprintln!("Diagnostic matrix complete; no production qualification asserted");
        std::process::exit(1);
    }
    let (registry_read, filtered_network, mode, caps) = match args.as_slice() {
        [_] => (false, false, None, false),
        [_, option] if option == "--registry-read" => (true, false, None, false),
        [_, option] if option == "--wfp" => (true, true, Some(super::wfp::Mode::Original), true),
        _ => {
            eprintln!("Expected [--registry-read | --wfp | --network-matrix]");
            std::process::exit(2);
        }
    };
    if let Err(error) = host(registry_read, filtered_network, mode, caps) {
        eprintln!("FAIL {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_registry_capability_has_a_stable_single_sid() {
        let first = RegistryCapability::create("registryRead").unwrap();
        let second = RegistryCapability::create("registryRead").unwrap();
        assert_ne!(unsafe { EqualSid(first.sid(), second.sid()) }, 0);
    }

    #[test]
    fn write_target_mask_never_grants_read_data_or_execute() {
        assert_eq!(
            WRITE_TARGET_RIGHTS
                & (FILE_READ_DATA | FILE_EXECUTE | DELETE | WRITE_DAC | WRITE_OWNER),
            0
        );
        assert_eq!(WRITE_TARGET_RIGHTS & FILE_GENERIC_WRITE, FILE_GENERIC_WRITE);
        assert_eq!(
            WRITE_TARGET_RIGHTS & FILE_READ_ATTRIBUTES,
            FILE_READ_ATTRIBUTES
        );
    }

    #[test]
    fn native_token_queries_cover_fixed_and_variable_sized_information() {
        let elevation = token_buffer(TokenElevation).unwrap();
        let app_container = token_buffer(TokenIsAppContainer).unwrap();
        let user = token_buffer(TokenUser).unwrap();
        let integrity = token_buffer(TokenIntegrityLevel).unwrap();
        unsafe {
            assert!(*elevation.as_ptr().cast::<u32>() <= 1);
            assert!(*app_container.as_ptr().cast::<u32>() <= 1);
            assert_ne!(
                IsValidSid((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid),
                0
            );
            assert_ne!(
                IsValidSid(
                    (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
                        .Label
                        .Sid
                ),
                0
            );
        }
    }
}
