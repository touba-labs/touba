//! Host-to-launcher contract, also tested on non-Windows development hosts.
use serde::Deserialize;

pub const MAX_POLICY_BYTES: usize = 1024 * 1024;
pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub protocol: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub code: Vec<String>,
    pub read: Vec<String>,
    pub write: Vec<String>,
    pub network: bool,
    pub process: bool,
    pub diagnostic: bool,
    pub env_keys: Vec<String>,
}

pub fn local_path(value: &str) -> bool {
    // No UNC, device paths, alternate streams or Win32 ambiguous aliases.
    let bytes = value.as_bytes();
    bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..3] == *b":\\"
        && !value[3..].contains([':', '\0', '/'])
        && value[3..].split('\\').all(|part| {
            !part.is_empty()
                && !part.ends_with(['.', ' '])
                && !matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
}

impl Policy {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_POLICY_BYTES {
            return Err("HandlerSandboxPolicyInvalid");
        }
        let value: Self =
            serde_json::from_slice(bytes).map_err(|_| "HandlerSandboxPolicyInvalid")?;
        if value.protocol != "touba-windows-sandbox-policy-v1"
            || value.args.len() > 1024
            || value.env_keys.len() > 512
            || value.env_keys.iter().any(|k| {
                k.is_empty()
                    || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    || matches!(
                        k.to_ascii_uppercase().as_str(),
                        "SYSTEMROOT" | "LOCALAPPDATA" | "TEMP" | "TMP"
                    )
            })
            || value.args.iter().any(|v| v.contains('\0'))
            || value.code.len() + value.read.len() + value.write.len() > 4096
            || !value.code.contains(&value.command)
            || std::iter::once(&value.command)
                .chain(std::iter::once(&value.cwd))
                .chain(&value.code)
                .chain(&value.read)
                .chain(&value.write)
                .any(|p| !local_path(p))
            || command_line(&value.command, &value.args)
                .encode_utf16()
                .count()
                >= 32767
        {
            return Err("HandlerSandboxPolicyInvalid");
        }
        Ok(value)
    }
}

// Microsoft CRT argv quoting, not shell escaping. lpApplicationName is separate.
pub fn quote(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        slashes = 0;
        output.push(ch);
    }
    output.extend(std::iter::repeat_n('\\', slashes * 2));
    output.push('"');
    output
}

pub fn command_line(command: &str, args: &[String]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> serde_json::Value {
        serde_json::json!({
            "protocol":"touba-windows-sandbox-policy-v1", "command":"C:\\Touba\\node.exe", "args":[],
            "cwd":"C:\\project", "code":["C:\\Touba\\node.exe"], "read":[], "write":[],
            "network":false, "process":false, "diagnostic":false, "env_keys":[]
        })
    }
    #[test]
    fn strict_policy() {
        let mut value = policy();
        let parsed = Policy::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!parsed.network && !parsed.process && !parsed.diagnostic);
        assert!(parsed.env_keys.is_empty());
        value["unknown"] = true.into();
        assert!(Policy::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(Policy::parse(&vec![0; MAX_POLICY_BYTES + 1]).is_err());
    }
    #[test]
    fn no_device_or_stream_or_path_alias() {
        for path in [
            "C:\\",
            "relative",
            "C:relative",
            "\\\\server\\share",
            "\\\\?\\C:\\file",
            "C:\\file:secret",
            "C:\\a\\..\\b",
            "C:\\a.",
            "C:\\NUL.txt",
            "C:\\x\\COM1",
            "C:\\x\\",
        ] {
            assert!(!local_path(path), "{path}");
        }
        assert!(local_path("C:\\développeur\\handler file.py"));
    }
    #[test]
    fn command_must_be_in_code_inventory() {
        let mut value = policy();
        value["code"] = serde_json::json!([]);
        assert!(Policy::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[test]
    fn quoting_keeps_empty_quotes_and_trailing_slashes() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("a\\"), "\"a\\\\\"");
        assert_eq!(quote("a\\\"b"), "\"a\\\\\\\"b\"");
    }
    #[test]
    fn nul_and_oversized_command_are_rejected() {
        for arg in ["bad\0arg".into(), "x".repeat(32768)] {
            let mut value = policy();
            value["args"] = serde_json::json!([arg]);
            assert!(Policy::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
    #[test]
    fn environment_names_are_explicit_and_cannot_replace_os_paths() {
        let mut value = policy();
        for key in [
            "",
            "bad=value",
            "bad\0name",
            "SYSTEMROOT",
            "LocalAppData",
            "Temp",
            "tmp",
        ] {
            value["env_keys"] = serde_json::json!([key]);
            assert!(
                Policy::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{key}"
            );
        }
        value["env_keys"] = serde_json::json!(["TEST_SELECTED"]);
        assert_eq!(
            Policy::parse(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .env_keys,
            ["TEST_SELECTED"]
        );
    }
}
