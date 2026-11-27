use crate::air::AirDocument;

pub use crate::air::AIR_JSON_PROFILE;

pub fn serialize_air_to_json(document: &AirDocument) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(document)
}

pub fn deserialize_air_from_json(json: &str) -> Result<AirDocument, serde_json::Error> {
    serde_json::from_str(json)
}
