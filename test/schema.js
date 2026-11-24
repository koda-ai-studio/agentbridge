import fs from "node:fs";
import assert from "node:assert/strict";

export const schema = JSON.parse(
  fs.readFileSync(new URL("../schema/agentbridge.v1.schema.json", import.meta.url)),
);
export function validate(value, node, at = "$") {
  if (node.$ref) node = schema.$defs[node.$ref.split("/").pop()];
  const errors = [];
  const kind = (v) =>
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (node.anyOf && !node.anyOf.some((n) => !validate(value, n, at).length))
    errors.push(`${at}: matches no anyOf branch`);
  if ("const" in node && value !== node.const) errors.push(`${at}: expected ${node.const}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${at}: ${value} not in enum`);
  if (node.type) {
    const types = [].concat(node.type), k = kind(value);
    if (!types.includes(k) && !(k === "integer" && types.includes("number")))
      return [`${at}: expected ${types.join("|")}, got ${k}`];
  }
  if (typeof value === "string") {
    if (node.minLength && value.length < node.minLength) errors.push(`${at}: too short`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${at}: pattern`);
    if (node.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${at}: date`);
  }
  if (typeof value === "number" && "minimum" in node && value < node.minimum)
    errors.push(`${at}: below minimum`);
  if (Array.isArray(value)) {
    if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${at}: too many`);
    if (node.items) value.forEach((v, i) => errors.push(...validate(v, node.items, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const r of node.required || [])
      if (!(r in value)) errors.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (node.properties?.[k]) errors.push(...validate(v, node.properties[k], `${at}.${k}`));
      else if (node.additionalProperties === false) errors.push(`${at}: unexpected ${k}`);
    }
  }
  return errors;
}
export const conforms = (value, def) =>
  assert.deepEqual(validate(value, { $ref: `#/$defs/${def}` }), [], def);
