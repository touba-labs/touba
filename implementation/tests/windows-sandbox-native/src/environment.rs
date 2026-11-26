//! The Windows process-container API requires both names even when the child
//! environment is explicitly closed. No host environment enumeration or retry
//! with an inherited block is allowed.
//! Reference: https://github.com/microsoft/mxc/pull/1158
pub fn block(system_root: &str, app_data: &str) -> Result<Vec<u16>, &'static str> {
    if [system_root, app_data]
        .iter()
        .any(|value| value.is_empty() || value.contains('\0'))
    {
        return Err("Invalid required Windows environment");
    }
    // Case-insensitive sorted entries, each terminated by NUL, then final NUL.
    Ok(
        format!("LOCALAPPDATA={app_data}\0SystemRoot={system_root}\0\0")
            .encode_utf16()
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::block;

    #[test]
    fn includes_only_the_two_required_variables_with_a_double_terminator() {
        let encoded = block(r"C:\Windows", r"D:\fixture").unwrap();
        assert_eq!(
            String::from_utf16(&encoded).unwrap(),
            "LOCALAPPDATA=D:\\fixture\0SystemRoot=C:\\Windows\0\0"
        );
        assert_eq!(encoded.iter().filter(|value| **value == 0).count(), 3);
    }

    #[test]
    fn preserves_spaces_and_unicode_as_data() {
        let encoded = block(r"C:\Windows", r"D:\test é🙂").unwrap();
        assert!(String::from_utf16(&encoded)
            .unwrap()
            .starts_with("LOCALAPPDATA=D:\\test é🙂\0"));
    }

    #[test]
    fn rejects_missing_values_and_environment_entry_injection() {
        assert!(block("", "fixture").is_err());
        assert!(block("root", "").is_err());
        assert!(block("root\0PRIVATE=leak", "fixture").is_err());
        assert!(block("root", "fixture\0PRIVATE=leak").is_err());
    }
}
