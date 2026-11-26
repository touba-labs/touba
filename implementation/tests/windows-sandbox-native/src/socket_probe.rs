//! Read-only capability comparison inside disposable diagnostic children.
//! Observations are not success assertions for the production runtime.
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Networking::WinSock::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
};

fn socket_security(socket: SOCKET) -> String {
    unsafe {
        let mut sd = std::ptr::null_mut();
        let status = GetSecurityInfo(
            socket as _,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        if status != 0 {
            return format!("socket GetSecurityInfo={status}");
        }
        let mut text = std::ptr::null_mut();
        let mut length = 0;
        let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(
            sd,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            &mut length,
        );
        let output = if ok != 0 && !text.is_null() && length <= 8192 {
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length as usize))
                .trim_end_matches('\0')
                .to_string();
            format!("socket DACL={value}")
        } else {
            "socket DACL unavailable".into()
        };
        if !text.is_null() {
            LocalFree(text.cast());
        }
        LocalFree(sd);
        output
    }
}

pub fn host_security() -> Result<(), String> {
    // Open the device itself without a socket's EA, requesting metadata only.
    // A socket handle's private DACL is not the device's admission policy.
    let device: Vec<u16> = "\\\\?\\GLOBALROOT\\Device\\Afd\0".encode_utf16().collect();
    let handle = unsafe {
        CreateFileW(
            device.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        println!("HOST AFD metadata open failed: {}", unsafe {
            GetLastError()
        });
    } else {
        println!("HOST AFD metadata {}", socket_security(handle as _));
        unsafe {
            CloseHandle(handle);
        }
    }
    let mut data = unsafe { std::mem::zeroed() };
    let status = unsafe { WSAStartup(0x0202, &mut data) };
    if status != 0 {
        return Err(format!("host WSAStartup: {status}"));
    }
    let handle = unsafe { socket(AF_INET as i32, SOCK_STREAM, IPPROTO_TCP) };
    if handle != INVALID_SOCKET {
        println!("HOST {}", socket_security(handle));
        unsafe {
            closesocket(handle);
        }
    }
    unsafe {
        WSACleanup();
    }
    if handle == INVALID_SOCKET {
        Err("host socket positive control failed".into())
    } else {
        Ok(())
    }
}

pub fn observe(host_address: &str) -> Result<String, String> {
    let mut data = unsafe { std::mem::zeroed() };
    let status = unsafe { WSAStartup(0x0202, &mut data) };
    if status != 0 {
        return Err(format!("WSAStartup: {status}"));
    }
    let mut output = String::new();
    for (name, flags) in [
        ("socket", None),
        ("WSASocket-overlapped", Some(WSA_FLAG_OVERLAPPED)),
        (
            "WSASocket-no-inherit",
            Some(WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT),
        ),
    ] {
        let handle = unsafe {
            match flags {
                None => socket(AF_INET as i32, SOCK_STREAM, IPPROTO_TCP),
                Some(flags) => WSASocketW(
                    AF_INET as i32,
                    SOCK_STREAM,
                    IPPROTO_TCP,
                    std::ptr::null(),
                    0,
                    flags,
                ),
            }
        };
        let result = if handle == INVALID_SOCKET {
            format!("error {}", unsafe { WSAGetLastError() })
        } else {
            unsafe {
                closesocket(handle);
            }
            "created".into()
        };
        output.push_str(&format!("{name}: {result}\n"));
    }
    // Bind and connect are bounded; accept is nonblocking, never an indefinite
    // wait in the very failure mode this experiment is intended to diagnose.
    let pair = (|| -> std::io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let _connection =
            TcpStream::connect_timeout(&listener.local_addr()?, Duration::from_secs(1))?;
        let _accepted = listener.accept()?;
        Ok(())
    })();
    output.push_str(&format!("same-container-pair: {pair:?}\n"));
    let pair_v6 = (|| -> std::io::Result<()> {
        let listener = TcpListener::bind("[::1]:0")?;
        listener.set_nonblocking(true)?;
        let _connection =
            TcpStream::connect_timeout(&listener.local_addr()?, Duration::from_secs(1))?;
        let _accepted = listener.accept()?;
        Ok(())
    })();
    output.push_str(&format!("same-container-pair-v6: {pair_v6:?}\n"));
    let address = host_address
        .parse()
        .map_err(|e| format!("Fixture address: {e}"))?;
    let external = TcpStream::connect_timeout(&address, Duration::from_secs(1));
    output.push_str(&format!("host-loopback: {external:?}\n"));
    unsafe {
        WSACleanup();
    }
    Ok(output)
}

pub fn filtered(host_address: &str) -> Result<String, String> {
    for address in ["127.0.0.1:0", "[::1]:0"] {
        let listener =
            TcpListener::bind(address).map_err(|e| format!("internal bind {address}: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let _connection = TcpStream::connect_timeout(
            &listener.local_addr().map_err(|e| e.to_string())?,
            Duration::from_secs(1),
        )
        .map_err(|e| format!("internal pair {address}: {e}"))?;
        let _accepted = listener.accept().map_err(|e| e.to_string())?;
    }
    let address = host_address
        .parse()
        .map_err(|e| format!("Host fixture address: {e}"))?;
    let attempted = TcpStream::connect_timeout(&address, Duration::from_secs(1));
    if !matches!(attempted, Err(ref e) if e.raw_os_error() == Some(WSAEACCES)) {
        return Err(format!(
            "Expected host TCP permission denial: {attempted:?}"
        ));
    }
    let udp = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let attempted = udp.send_to(b"touba-fixture", host_address);
    if !matches!(attempted, Err(ref e) if e.raw_os_error() == Some(WSAEACCES)) {
        return Err(format!(
            "Expected host UDP permission denial: {attempted:?}"
        ));
    }
    Ok("IPv4/IPv6 internal pairs succeeded; host TCP/UDP refused with WSAEACCES".into())
}
