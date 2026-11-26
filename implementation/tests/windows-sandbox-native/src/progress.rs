//! Diagnostic exit codes independent of filesystem access or inherited handles.
use std::sync::atomic::{AtomicU32, Ordering};

macro_rules! stages {
    ($($name:ident = $code:literal => $label:literal),+ $(,)?) => {
        #[derive(Clone, Copy)]
        #[repr(u32)]
        pub enum Stage { $($name = $code),+ }

        pub fn describe(code: u32) -> &'static str {
            let stage = if code & 0xff00_0000 == OS_ERROR_TAG {
                (code >> 16) & 0xff
            } else { code };
            match stage {
                $($code => $label,)+
                0xc0000142 => "Windows DLL initialization failed before a diagnostic result",
                _ => "unclassified process exit",
            }
        }

        #[cfg(test)]
        const ALL: &[(Stage, &str)] = &[$((Stage::$name, $label)),+];
    };
}

stages! {
    Entry = 32 => "child entry or invalid arguments",
    AppContainer = 33 => "AppContainer token query/check",
    Lpac = 34 => "LPAC all-application-packages read refusal",
    Environment = 35 => "host environment isolation",
    Read = 36 => "declared file read",
    ReadOnly = 37 => "write refusal on read-only file",
    WriteOnly = 38 => "read refusal on write-only file",
    Write = 39 => "declared file write",
    Private = 40 => "private-file read refusal",
    Symlink = 41 => "symlink target read refusal",
    Listing = 42 => "directory listing refusal",
    Network = 43 => "network refusal",
    ProcessDenied = 44 => "descendant creation refusal",
    ProcessInherited = 45 => "allowed descendant and inherited restrictions",
    SpawnHeartbeat = 46 => "heartbeat descendant creation",
    Heartbeat = 47 => "heartbeat descendant write",
    HighIntegrity = 48 => "high-integrity canary write refusal",
    AppContainerControl = 49 => "ordinary AppContainer read positive control",
    WriteOpen = 50 => "open declared write target without truncation",
    WriteCommit = 51 => "write bytes to declared target",
    WinsockStartup = 52 => "Winsock initialization (not network denial)",
    SocketProbe = 53 => "socket creation and internal-pair diagnostic",
    DnsProbe = 54 => "Windows DNS API diagnostic",
}

static CURRENT: AtomicU32 = AtomicU32::new(Stage::Entry as u32);
static OS_ERROR: AtomicU32 = AtomicU32::new(0);
const OS_ERROR_TAG: u32 = 0xe100_0000;

pub fn mark(stage: Stage) {
    CURRENT.store(stage as u32, Ordering::Relaxed);
    OS_ERROR.store(0, Ordering::Relaxed);
}

pub fn record_os_error(code: i32) {
    if (1..=u16::MAX as i32).contains(&code) {
        OS_ERROR.store(code as u32, Ordering::Relaxed);
    }
}

pub fn os_error(code: u32) -> Option<u32> {
    (code & 0xff00_0000 == OS_ERROR_TAG).then_some(code & 0xffff)
}

fn encode(stage: u32, error: u32) -> u32 {
    if error == 0 {
        stage
    } else {
        OS_ERROR_TAG | (stage << 16) | error
    }
}

pub fn failure_code() -> u32 {
    encode(
        CURRENT.load(Ordering::Relaxed),
        OS_ERROR.load(Ordering::Relaxed),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_codes_are_distinct_nonzero_and_preserved_without_a_file() {
        let codes: std::collections::HashSet<_> = ALL.iter().map(|(s, _)| *s as u32).collect();
        assert_eq!(codes.len(), ALL.len());
        for (stage, label) in ALL {
            mark(*stage);
            assert_ne!(failure_code(), 0);
            assert_eq!(describe(failure_code()), *label);
            record_os_error(5);
            assert_eq!(os_error(failure_code()), Some(5));
            assert_eq!(describe(failure_code()), *label);
            mark(*stage);
            assert_eq!(os_error(failure_code()), None);
        }
    }

    #[test]
    fn os_initialization_failure_is_not_a_passed_permission_check() {
        assert!(describe(0xc0000142).starts_with("Windows DLL initialization failed"));
        assert_eq!(describe(0), "unclassified process exit");
        assert_eq!(describe(1), "unclassified process exit");
        assert_eq!(os_error(0xc0000142), None);
    }

    #[test]
    fn os_errors_preserve_stage_without_a_writable_report_file() {
        for (stage, label) in ALL {
            for error in [5, 24, 87, 367, 10091, 65535] {
                let code = encode(*stage as u32, error);
                assert_eq!(describe(code), *label);
                assert_eq!(os_error(code), Some(error));
            }
        }
        assert_eq!(os_error(encode(Stage::Write as u32, 0)), None);
    }
}
