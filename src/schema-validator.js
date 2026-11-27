/**
 * Zero-dependency JSON Schema draft-07 subset validator.
 * Supports: type, required, properties, items, enum, minimum, maximum,
 * minItems, maxItems, minLength, maxLength, additionalProperties.
 * Unknown keywords pass silently.
 */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function matchesSingleType(value, expectedType) {
  switch (expectedType) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      // Unknown type keyword passes silently.
      return true;
  }
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
}

function validateNode(value, schema, path, errors) {
  if (schema === undefined || schema === null || schema === true) return;
  if (schema === false) {
    errors.push(`${path}: value is disallowed by schema`);
    return;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) return;

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((typeName) => matchesSingleType(value, typeName));
    if (!ok) {
      errors.push(`${path}: expected ${allowed.join(" or ")}, got ${describeType(value)}`);
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    const inEnum = schema.enum.some((candidate) => deepEqual(value, candidate));
    if (!inEnum) {
      const rendered = schema.enum.map((item) => JSON.stringify(item)).join(", ");
      errors.push(`${path}: must be one of [${rendered}]`);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      errors.push(`${path}: length must be >= ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      errors.push(`${path}: length must be <= ${schema.maxLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        const limit = Math.min(value.length, schema.items.length);
        for (let i = 0; i < limit; i += 1) {
          validateNode(value[i], schema.items[i], `${path}[${i}]`, errors);
        }
      } else if (typeof schema.items === "object" || typeof schema.items === "boolean") {
        for (let i = 0; i < value.length; i += 1) {
          validateNode(value[i], schema.items, `${path}[${i}]`, errors);
        }
      }
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey !== "string") continue;
        if (!Object.prototype.hasOwnProperty.call(value, reqKey) || value[reqKey] === undefined) {
          errors.push(`${path}: missing required property "${reqKey}"`);
        }
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : null;
    for (const [key, propValue] of Object.entries(value)) {
      const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
      if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(propValue, properties[key], childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath}: additional property is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateNode(propValue, schema.additionalProperties, childPath, errors);
      }
    }
  }
}

export function validateAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}
