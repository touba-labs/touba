//! Closed field constraints and construction defaults; no host evaluation.
use crate::ast::{AstExpression, AstFieldConstraint};
use crate::typecheck::is_iso_date;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub(crate) type Constraints = BTreeMap<String, Value>;

pub(crate) fn constraints(
    items: &[AstFieldConstraint],
    type_ref: &str,
) -> Result<Constraints, String> {
    let mut result = BTreeMap::new();
    let mut seen = HashSet::new();
    for item in items {
        if !seen.insert(&item.kind) {
            return Err(format!("duplicate field constraint `{}`", item.kind));
        }
        match item.kind.as_str() {
            "format" if type_ref == "builtin:Text" && item.value == "digits" => {
                result.insert("format".into(), json!(item.value));
            }
            "length" if type_ref == "builtin:Text" || type_ref.starts_with("list:") => {
                let min = item
                    .value
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value <= 9_007_199_254_740_991);
                let max = item
                    .upper
                    .as_deref()
                    .unwrap_or(&item.value)
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value <= 9_007_199_254_740_991);
                let (Some(min), Some(max)) = (min, max) else {
                    return Err("length requires nonnegative safe integer bounds".into());
                };
                if min > max {
                    return Err("length lower bound exceeds upper bound".into());
                }
                result.insert("min_length".into(), json!(min));
                result.insert("max_length".into(), json!(max));
            }
            "min" | "max" if ["builtin:Int", "builtin:Float"].contains(&type_ref) => {
                let number = item
                    .value
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite());
                let Some(number) = number else {
                    return Err("numeric constraint requires a finite number".into());
                };
                if type_ref == "builtin:Int" {
                    // A decimal fraction can round to an integer in f64.
                    // Validate the source digits before using the numeric value.
                    let (whole, fraction) = item.value.split_once('.').unwrap_or((&item.value, ""));
                    let safe_whole = whole
                        .parse::<i64>()
                        .is_ok_and(|value| value.unsigned_abs() <= 9_007_199_254_740_991);
                    if !safe_whole || !fraction.bytes().all(|digit| digit == b'0') {
                        return Err("Int constraint requires a safe integer".into());
                    }
                }
                result.insert(item.kind.clone(), json!(number));
            }
            _ => {
                return Err(format!(
                    "constraint `{}` is unsupported for `{type_ref}`",
                    item.kind
                ));
            }
        }
    }
    if let (Some(min), Some(max)) = (result.get("min"), result.get("max"))
        && min.as_f64() > max.as_f64()
    {
        return Err("min exceeds max".into());
    }
    Ok(result)
}

pub(crate) fn literal(expression: &AstExpression) -> Option<(String, Value)> {
    match expression {
        AstExpression::StringLiteral { value, .. } => Some(("builtin:Text".into(), json!(value))),
        AstExpression::BooleanLiteral { value, .. } => {
            Some(("builtin:Boolean".into(), json!(value)))
        }
        AstExpression::IntLiteral { value, .. } => value
            .parse::<i64>()
            .ok()
            .filter(|v| v.unsigned_abs() <= 9_007_199_254_740_991)
            .map(|v| ("builtin:Int".into(), json!(v))),
        AstExpression::FloatLiteral { value, .. } => value
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .map(|v| ("builtin:Float".into(), json!(v))),
        AstExpression::DateConversion { expression, .. } => match expression.as_ref() {
            AstExpression::StringLiteral { value, .. } if is_iso_date(value) => {
                Some(("builtin:Date".into(), json!(value)))
            }
            _ => None,
        },
        AstExpression::Parenthesized { expression, .. } => literal(expression),
        _ => None,
    }
}

pub(crate) fn matches(value: &Value, constraints: &Constraints) -> bool {
    for (key, limit) in constraints {
        let valid = match key.as_str() {
            "format" => value
                .as_str()
                .is_some_and(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())),
            "min_length" | "max_length" => {
                let size = value
                    .as_str()
                    .map(|text| text.chars().count())
                    .or_else(|| value.as_array().map(Vec::len));
                size.is_some_and(|size| {
                    if key == "min_length" {
                        size as u64 >= limit.as_u64().unwrap()
                    } else {
                        size as u64 <= limit.as_u64().unwrap()
                    }
                })
            }
            "min" => value.as_f64().is_some_and(|v| v >= limit.as_f64().unwrap()),
            "max" => value.as_f64().is_some_and(|v| v <= limit.as_f64().unwrap()),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    true
}
