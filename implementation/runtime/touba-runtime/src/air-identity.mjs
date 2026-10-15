// @ts-check
import { canonicalDigest } from "./execution-checkpoints.mjs";

/**
 * Identity of the complete JSON AIR admitted for execution, including source
 * locations, constants, expressions and authority declarations. Object key
 * order is irrelevant; array order is significant. Optional undefined host
 * properties are absent in the JSON document, just as in its serialized form.
 * This is a content commitment, not a signature or proof of a trusted writer.
 * @param {unknown} document
 * @returns {string}
 */
export function airDocumentDigest(document) {
  return canonicalDigest(JSON.parse(JSON.stringify(document)));
}
