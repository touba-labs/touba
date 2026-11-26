//! Local UDP DNS canary. No global DNS setting is modified. A negative API
//! result alone is not a denial proof: the host counts the actual datagrams.
use std::net::UdpSocket;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER};
use windows_sys::Win32::NetworkManagement::Dns::*;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedUdpTable, MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID, UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

// Query only the actual canary sender before replying, while its UDP socket is
// still expected to exist. Absence/races are inconclusive, never a denial proof.
fn sender(port: u16) -> Result<String, String> {
    let mut bytes = 0;
    let status = unsafe {
        GetExtendedUdpTable(
            std::ptr::null_mut(),
            &mut bytes,
            0,
            AF_INET as u32,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    if status != ERROR_INSUFFICIENT_BUFFER || !(4..=1_048_576).contains(&bytes) {
        return Err(format!("UDP table sizing={status}, bytes={bytes}"));
    }
    let mut storage = vec![0u32; (bytes as usize).div_ceil(4)];
    let status = unsafe {
        GetExtendedUdpTable(
            storage.as_mut_ptr().cast(),
            &mut bytes,
            0,
            AF_INET as u32,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    if status != 0 {
        return Err(format!("UDP table={status}"));
    }
    let table = storage.as_ptr().cast::<MIB_UDPTABLE_OWNER_PID>();
    let offset = std::mem::offset_of!(MIB_UDPTABLE_OWNER_PID, table);
    let count = unsafe { (*table).dwNumEntries as usize };
    if offset + count.saturating_mul(std::mem::size_of::<MIB_UDPROW_OWNER_PID>())
        > storage.len() * 4
    {
        return Err("UDP table size mismatch".into());
    }
    let rows = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!((*table).table).cast::<MIB_UDPROW_OWNER_PID>(),
            count,
        )
    };
    let matches: Vec<_> = rows
        .iter()
        .filter(|row| {
            u16::from_be(row.dwLocalPort as u16) == port
                && (row.dwLocalAddr == 0 || row.dwLocalAddr.to_ne_bytes() == [127, 0, 0, 1])
        })
        .collect();
    if matches.len() != 1 {
        return Err(format!("UDP sender matches={}", matches.len()));
    }
    let pid = matches[0].dwOwningPid;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Ok(format!("pid={pid}, image unavailable"));
    }
    let mut image = vec![0u16; 4096];
    let mut length = image.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) };
    unsafe {
        CloseHandle(process);
    }
    let image = if ok != 0 {
        String::from_utf16_lossy(&image[..length as usize])
    } else {
        "unavailable".into()
    };
    Ok(format!("pid={pid}, image={image}"))
}

pub struct Server {
    pub port: u16,
    count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    pub fn start() -> Result<Self, String> {
        // DnsQueryEx's documented sample supplies an IP address with port zero
        // (the default DNS port), not an arbitrary UDP endpoint. Use a real
        // local DNS listener; refuse if occupied, never alter another service.
        let socket = UdpSocket::bind("127.0.0.1:53").map_err(|e| e.to_string())?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|e| e.to_string())?;
        let count = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, stopping) = (count.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            let mut bytes = [0u8; 4096];
            while !stopping.load(Ordering::SeqCst) {
                match socket.recv_from(&mut bytes) {
                    Ok((size, from)) if size >= 12 => {
                        println!("DNS CANARY sender {:?}", sender(from.port()));
                        seen.fetch_add(1, Ordering::SeqCst);
                        // Real NXDOMAIN reply, preserving ID and question.
                        bytes[2] = 0x81;
                        bytes[3] = 0x83;
                        // Keep the additional-record count: DNS clients can
                        // include an EDNS OPT record after the question.
                        bytes[6..10].fill(0);
                        socket
                            .send_to(&bytes[..size], from)
                            .expect("DNS fixture reply");
                    }
                    Ok(_) => {
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(e) => panic!("DNS fixture receive: {e}"),
                }
            }
        });
        Ok(Self {
            port,
            count,
            stop,
            thread: Some(thread),
        })
    }
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("DNS fixture thread");
        }
    }
}
pub fn query(port: u16) -> i32 {
    assert_eq!(port, 53, "the DNS canary uses the standard local DNS port");
    let mut address = DNS_ADDR::default();
    let family = AF_INET.to_ne_bytes();
    for (i, byte) in [family[0], family[1], 0, 0, 127, 0, 0, 1]
        .into_iter()
        .enumerate()
    {
        address.MaxSa[i] = byte as i8;
    }
    let mut servers = DNS_ADDR_ARRAY {
        MaxCount: 1,
        AddrCount: 1,
        AddrArray: [address],
        ..Default::default()
    };
    let name: Vec<u16> = format!("touba-qualification-{}.invalid.\0", std::process::id())
        .encode_utf16()
        .collect();
    let request = DNS_QUERY_REQUEST {
        Version: DNS_QUERY_REQUEST_VERSION1,
        QueryName: name.as_ptr(),
        QueryType: DNS_TYPE_A,
        QueryOptions: DNS_QUERY_BYPASS_CACHE as u64,
        pDnsServerList: &mut servers,
        ..Default::default()
    };
    let mut result = DNS_QUERY_RESULT {
        Version: DNS_QUERY_RESULTS_VERSION1,
        ..Default::default()
    };
    let status = unsafe { DnsQueryEx(&request, &mut result, std::ptr::null_mut()) };
    if !result.pQueryRecords.is_null() {
        unsafe {
            DnsFree(result.pQueryRecords.cast(), DnsFreeRecordList);
        }
    }
    status
}
