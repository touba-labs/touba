use crate::air::AirDocument;

pub const AIR_JSON_PROFILE: &str = "touba-air-json-canonical-v1";

pub fn serialize_air_to_json(document: &AirDocument) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(document)
}

pub fn deserialize_air_from_json(json: &str) -> Result<AirDocument, serde_json::Error> {
    serde_json::from_str(json)
}
