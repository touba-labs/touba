//! Bounded native evidence for disposable CI only. No packet payloads or DNS
//! names are collected. Audit options are restored, including on early error.
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::{CopySid, EqualSid, GetLengthSid, PSID};
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;

fn check(code: u32, operation: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("{operation}: {code:#x}"))
    }
}
fn same_guid(a: windows_sys::core::GUID, b: windows_sys::core::GUID) -> bool {
    (a.data1, a.data2, a.data3, a.data4) == (b.data1, b.data2, b.data3, b.data4)
}
unsafe fn wide(pointer: *const u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut length = 0;
    while length < 1024 && *pointer.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}
struct Record {
    filter: u64,
    line: String,
}
struct Context {
    sid: Vec<usize>,
    records: Mutex<Vec<Record>>,
}
unsafe extern "system" fn event(context: *mut c_void, value: *const FWPM_NET_EVENT2) {
    if context.is_null() || value.is_null() {
        return;
    }
    let context = &*context.cast::<Context>();
    let value = &*value;
    let header = &value.header;
    let own = header.flags & FWPM_NET_EVENT_FLAG_PACKAGE_ID_SET != 0
        && !header.packageSid.is_null()
        && EqualSid(
            header.packageSid.cast(),
            context.sid.as_ptr().cast_mut().cast(),
        ) != 0;
    // Only our package, or the local DNS canary. Never print other traffic.
    let dns = header.ipVersion == FWP_IP_VERSION_V4
        && header.remotePort == 53
        && header.Anonymous2.remoteAddrV4 == 0x7f000001;
    if !own && !dns {
        return;
    }
    let (kind, filter, layer, loopback) = match value.r#type {
        FWPM_NET_EVENT_TYPE_CLASSIFY_DROP if !value.Anonymous.classifyDrop.is_null() => {
            let detail = &*value.Anonymous.classifyDrop;
            ("drop", detail.filterId, detail.layerId, detail.isLoopback)
        }
        FWPM_NET_EVENT_TYPE_CLASSIFY_ALLOW if !value.Anonymous.classifyAllow.is_null() => {
            let detail = &*value.Anonymous.classifyAllow;
            ("allow", detail.filterId, detail.layerId, detail.isLoopback)
        }
        _ => return,
    };
    let app = if header.appId.data.is_null() || header.appId.size > 4096 {
        String::new()
    } else {
        let bytes = std::slice::from_raw_parts(header.appId.data, header.appId.size as usize);
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string()
    };
    if let Ok(mut records) = context.records.lock() {
        if records.len() < 256 {
            records.push(Record { filter, line: format!(
                "WFP EVENT {kind} own_package={own} dns_canary={dns} filter={filter} layer={layer} loopback={loopback} protocol={} local_port={} remote_port={} app={app}",
                header.ipProtocol, header.localPort, header.remotePort) });
        }
    }
}

pub struct Events {
    engine: HANDLE,
    subscription: HANDLE,
    context: Box<Context>,
    original: Vec<(FWPM_ENGINE_OPTION, u32)>,
}
impl Events {
    pub fn start(sid: PSID) -> Result<Self, String> {
        let mut engine = null_mut();
        check(
            unsafe { FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), null(), &mut engine) },
            "audit engine",
        )?;
        let length = unsafe { GetLengthSid(sid) };
        let mut copied = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe { CopySid(length, copied.as_mut_ptr().cast(), sid) } == 0 {
            unsafe {
                FwpmEngineClose0(engine);
            }
            return Err("audit CopySid".into());
        }
        let mut this = Self {
            engine,
            subscription: null_mut(),
            context: Box::new(Context {
                sid: copied,
                records: Mutex::new(Vec::new()),
            }),
            original: Vec::new(),
        };
        for (option, add) in [
            (FWPM_ENGINE_COLLECT_NET_EVENTS, 1),
            (
                FWPM_ENGINE_NET_EVENT_MATCH_ANY_KEYWORDS,
                FWPM_NET_EVENT_KEYWORD_CLASSIFY_ALLOW,
            ),
        ] {
            let mut pointer = null_mut();
            check(
                unsafe { FwpmEngineGetOption0(engine, option, &mut pointer) },
                "read audit option",
            )?;
            if pointer.is_null() {
                return Err("missing audit option".into());
            }
            let value = unsafe { *pointer };
            unsafe {
                FwpmFreeMemory0((&mut pointer as *mut *mut FWP_VALUE0).cast());
            }
            if value.r#type != FWP_UINT32 {
                return Err("unexpected audit option type".into());
            }
            let old = unsafe { value.Anonymous.uint32 };
            this.original.push((option, old));
            this.set(option, old | add)?;
        }
        check(
            unsafe {
                FwpmNetEventSubscribe1(
                    engine,
                    &FWPM_NET_EVENT_SUBSCRIPTION0::default(),
                    Some(event),
                    (&*this.context as *const Context).cast(),
                    &mut this.subscription,
                )
            },
            "subscribe WFP events",
        )?;
        Ok(this)
    }
    fn set(&self, option: FWPM_ENGINE_OPTION, value: u32) -> Result<(), String> {
        check(
            unsafe {
                FwpmEngineSetOption0(
                    self.engine,
                    option,
                    &FWP_VALUE0 {
                        r#type: FWP_UINT32,
                        Anonymous: FWP_VALUE0_0 { uint32: value },
                    },
                )
            },
            "set audit option",
        )
    }
    pub fn report(&self) -> Result<(), String> {
        // Event delivery is asynchronous. This delay gathers diagnostics; it
        // does not turn absence of an event into a security success assertion.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let records = std::mem::take(
            &mut *self
                .context
                .records
                .lock()
                .map_err(|_| "audit lock poisoned")?,
        );
        println!("WFP collected {} events (limit 256)", records.len());
        if records.len() == 256 {
            println!("WFP audit limit reached: evidence may be incomplete");
        }
        for record in records {
            println!("{}", record.line);
            let mut pointer = null_mut();
            let status = unsafe { FwpmFilterGetById0(self.engine, record.filter, &mut pointer) };
            if status != 0 || pointer.is_null() {
                println!("WFP filter {} unavailable: {status:#x}", record.filter);
                continue;
            }
            unsafe {
                let filter = &*pointer;
                println!(
                    "WFP filter {} name={} action={:#x} conditions={}",
                    record.filter,
                    wide(filter.displayData.name),
                    filter.action.r#type,
                    filter.numFilterConditions
                );
                if !filter.filterCondition.is_null() && filter.numFilterConditions <= 64 {
                    for condition in std::slice::from_raw_parts(
                        filter.filterCondition,
                        filter.numFilterConditions as usize,
                    ) {
                        if same_guid(condition.fieldKey, FWPM_CONDITION_FLAGS)
                            && condition.conditionValue.r#type == FWP_UINT32
                        {
                            println!(
                                "WFP flag predicate match={} value={:#x}",
                                condition.matchType, condition.conditionValue.Anonymous.uint32
                            );
                        }
                    }
                }
                FwpmFreeMemory0((&mut pointer as *mut *mut FWPM_FILTER0).cast());
            }
        }
        Ok(())
    }
}

impl Drop for Events {
    fn drop(&mut self) {
        // Unsubscribe waits for the callback. Keep its context alive until then.
        let status = unsafe { FwpmNetEventUnsubscribe0(self.engine, self.subscription) };
        if status != 0 {
            eprintln!("audit unsubscribe: {status:#x}");
        }
        for &(option, old) in self.original.iter().rev() {
            if let Err(error) = self.set(option, old) {
                eprintln!("audit restore: {error}");
            }
        }
        unsafe {
            FwpmEngineClose0(self.engine);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_all_guid_fields() {
        let original = FWPM_CONDITION_FLAGS;
        assert!(same_guid(original, original));
        let mut changed = original;
        changed.data4[7] ^= 1;
        assert!(!same_guid(original, changed));
    }
    #[test]
    fn callback_records_only_local_dns_or_own_package_not_arbitrary_traffic() {
        let context = Context {
            sid: vec![0usize; 16],
            records: Mutex::new(Vec::new()),
        };
        let mut detail = FWPM_NET_EVENT_CLASSIFY_ALLOW0 {
            filterId: 123,
            layerId: 7,
            ..Default::default()
        };
        let mut value = FWPM_NET_EVENT2 {
            r#type: FWPM_NET_EVENT_TYPE_CLASSIFY_ALLOW,
            Anonymous: FWPM_NET_EVENT2_0 {
                classifyAllow: &mut detail,
            },
            ..Default::default()
        };
        value.header.ipVersion = FWP_IP_VERSION_V4;
        value.header.remotePort = 53;
        value.header.Anonymous2.remoteAddrV4 = 0x7f000001;
        let pointer = (&context as *const Context).cast_mut().cast();
        unsafe {
            event(pointer, &value);
        }
        assert_eq!(context.records.lock().unwrap().len(), 1);
        value.header.remotePort = 80;
        unsafe {
            event(pointer, &value);
            event(null_mut(), &value);
            event(pointer, null());
        }
        assert_eq!(context.records.lock().unwrap().len(), 1);
        assert_eq!(context.records.lock().unwrap()[0].filter, 123);
    }
}
