//! Isolated WFP primitive experiment, not a shipped service or runtime policy.
//! Persistent BLOCK filters survive closing the engine. Explicit removal is
//! permitted only once the diagnostic host has stopped all fixture children.
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;

fn check(status: u32, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation}: {status:#x}"))
    }
}
struct Engine(HANDLE);
impl Engine {
    fn open() -> Result<Self, String> {
        let mut handle = null_mut();
        check(
            unsafe { FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), null(), &mut handle) },
            "FwpmEngineOpen0",
        )?;
        Ok(Self(handle))
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
pub struct Filters {
    ids: Vec<u64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Original,
    BlockAll,
    LoopbackOnly,
    SocketAllocation,
}

fn allocation_filter(
    layer: windows_sys::core::GUID,
    condition: &mut FWPM_FILTER_CONDITION0,
    name: &mut [u16],
) -> Result<FWPM_FILTER0, String> {
    if name.len() < 2 || name.last() != Some(&0) || name[..name.len() - 1].contains(&0) {
        return Err("WFP filter requires a nonempty terminated display name".into());
    }
    Ok(FWPM_FILTER0 {
        displayData: FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            description: null_mut(),
        },
        layerKey: layer,
        subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
        flags: FWPM_FILTER_FLAG_PERSISTENT | FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT,
        numFilterConditions: 1,
        filterCondition: condition,
        action: FWPM_ACTION0 {
            r#type: FWP_ACTION_PERMIT,
            ..Default::default()
        },
        ..Default::default()
    })
}
impl Filters {
    pub fn install(sid: PSID, mode: Mode) -> Result<Self, String> {
        let engine = Engine::open()?;
        check(
            unsafe { FwpmTransactionBegin0(engine.0, 0) },
            "FwpmTransactionBegin0",
        )?;
        let mut ids = Vec::new();
        let result = (|| {
            for layer in [
                FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
                FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
            ] {
                // Do NOT permit all loopback: a normal host service is outside
                // the invocation. Windows' AppContainer isolation additionally
                // separates distinct package SIDs; that needs native controls.
                let mut conditions = vec![
                    FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
                        matchType: FWP_MATCH_EQUAL,
                        conditionValue: FWP_CONDITION_VALUE0 {
                            r#type: FWP_SID,
                            Anonymous: FWP_CONDITION_VALUE0_0 { sid: sid.cast() },
                        },
                    },
                    FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_FLAGS,
                        matchType: FWP_MATCH_FLAGS_NONE_SET,
                        conditionValue: FWP_CONDITION_VALUE0 {
                            r#type: FWP_UINT32,
                            Anonymous: FWP_CONDITION_VALUE0_0 {
                                uint32: if mode == Mode::Original {
                                    FWP_CONDITION_FLAG_IS_APPCONTAINER_LOOPBACK
                                } else {
                                    FWP_CONDITION_FLAG_IS_LOOPBACK
                                },
                            },
                        },
                    },
                ];
                if mode == Mode::BlockAll {
                    conditions.truncate(1);
                }
                let mut name: Vec<u16> =
                    "Touba isolated qualification: deny outside AppContainer loopback\0"
                        .encode_utf16()
                        .collect();
                let filter = FWPM_FILTER0 {
                    displayData: FWPM_DISPLAY_DATA0 {
                        name: name.as_mut_ptr(),
                        description: null_mut(),
                    },
                    flags: FWPM_FILTER_FLAG_PERSISTENT,
                    layerKey: layer,
                    subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
                    numFilterConditions: conditions.len() as u32,
                    filterCondition: conditions.as_mut_ptr(),
                    action: FWPM_ACTION0 {
                        r#type: FWP_ACTION_BLOCK,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut id = 0;
                check(
                    unsafe { FwpmFilterAdd0(engine.0, &filter, null_mut(), &mut id) },
                    "FwpmFilterAdd0",
                )?;
                ids.push(id);
                println!("WFP installed block id={id} mode={mode:?}");
            }
            if mode == Mode::SocketAllocation {
                // Hypothesis only: does allocation-layer policy, rather than
                // device access, explain LPAC socket creation without IP caps?
                for layer in [
                    FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4,
                    FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6,
                ] {
                    let mut condition = FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
                        matchType: FWP_MATCH_EQUAL,
                        conditionValue: FWP_CONDITION_VALUE0 {
                            r#type: FWP_SID,
                            Anonymous: FWP_CONDITION_VALUE0_0 { sid: sid.cast() },
                        },
                    };
                    // Required by FWPM_FILTER0, even for a diagnostic permit.
                    let mut name: Vec<u16> =
                        "Touba isolated qualification: allocation without IP capabilities\0"
                            .encode_utf16()
                            .collect();
                    let filter = allocation_filter(layer, &mut condition, &mut name)?;
                    let mut id = 0;
                    check(
                        unsafe { FwpmFilterAdd0(engine.0, &filter, null_mut(), &mut id) },
                        "allocation filter",
                    )?;
                    ids.push(id);
                    println!("WFP installed allocation hypothesis id={id}");
                }
            }
            check(
                unsafe { FwpmTransactionCommit0(engine.0) },
                "FwpmTransactionCommit0",
            )
        })();
        if result.is_err() {
            unsafe {
                FwpmTransactionAbort0(engine.0);
            }
        }
        result?;
        // Engine closes here, before the child starts: persistence across the
        // helper's connection lifetime is exercised, not assumed.
        Ok(Self { ids })
    }
    pub fn remove_after_children_stop(self) -> Result<(), String> {
        let engine = Engine::open()?;
        for id in self.ids {
            check(
                unsafe { FwpmFilterDeleteById0(engine.0, id) },
                "FwpmFilterDeleteById0",
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocation_requires_display_name_and_keeps_the_sid_condition() {
        let mut condition = FWPM_FILTER_CONDITION0::default();
        let layer = FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4;
        assert!(allocation_filter(layer, &mut condition, &mut []).is_err());
        assert!(allocation_filter(layer, &mut condition, &mut [0]).is_err());
        assert!(allocation_filter(layer, &mut condition, &mut [65]).is_err());
        let mut name = [65, 0];
        let filter = allocation_filter(layer, &mut condition, &mut name).unwrap();
        assert_eq!(filter.displayData.name, name.as_mut_ptr());
        assert_eq!(filter.numFilterConditions, 1);
        assert_eq!(filter.filterCondition, &mut condition as *mut _);
        assert_ne!(filter.flags & FWPM_FILTER_FLAG_PERSISTENT, 0);
    }
}
