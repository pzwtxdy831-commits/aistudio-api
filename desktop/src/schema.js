// JSON Schema / OpenAPI schema → AI Studio wire Schema array (field indexes 0..22).
// Handles what real-world tool definitions throw at us: $ref/$defs, type arrays, const, anyOf with null, etc.

const TYPE_CODES = { string: 1, number: 2, integer: 3, boolean: 4, array: 5, object: 6 };
const S = {
  type: 0, format: 1, description: 2, nullable: 3, enum: 4, items: 5, properties: 6, required: 7,
  minProperties: 8, maxProperties: 9, minimum: 10, maximum: 11, minLength: 12, maxLength: 13,
  pattern: 14, anyOf: 17, maxItems: 20, minItems: 21, propertyOrdering: 22,
};

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) return null;
  }
  return node;
}

function guessType(s) {
  let t = s.type;
  let nullable = false;
  if (Array.isArray(t)) {
    nullable = t.some((x) => String(x).toLowerCase() === 'null');
    t = t.find((x) => String(x).toLowerCase() !== 'null');
  }
  t = String(t || '').toLowerCase();
  if (t === 'float') t = 'number';
  if (t === 'int') t = 'integer';
  if (t === 'bool') t = 'boolean';
  if (!TYPE_CODES[t]) {
    if (s.properties) t = 'object';
    else if (s.items || s.prefixItems) t = 'array';
    else if (s.const !== undefined) t = jsType(s.const);
    else if (Array.isArray(s.enum) && s.enum.length) t = jsType(s.enum[0]);
    else t = 'string';
  }
  return { t, nullable };
}

function jsType(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (Array.isArray(v)) return 'array';
  if (v && typeof v === 'object') return 'object';
  return 'string';
}

function merge(a, b) {
  const out = { ...a, ...b };
  if (a.properties || b.properties) out.properties = { ...(a.properties || {}), ...(b.properties || {}) };
  if (a.required || b.required) out.required = [...new Set([...(a.required || []), ...(b.required || [])])];
  return out;
}

export function schemaToWire(schema, root = schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 24) return [TYPE_CODES.string];
  let s = schema;
  if (s.$ref) {
    const target = resolveRef(s.$ref, root);
    const { $ref, ...rest } = s;
    s = target ? merge(target, rest) : rest;
  }
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const { allOf, ...rest } = s;
    s = allOf.reduce((acc, sub) => merge(acc, sub?.$ref ? resolveRef(sub.$ref, root) || {} : sub || {}), rest);
  }

  let nullableFromUnion = false;
  const union = s.anyOf || s.oneOf;
  if (Array.isArray(union) && union.length) {
    const nonNull = union.filter((u) => !(u && (u.type === 'null' || (Array.isArray(u.type) && u.type.length === 1 && u.type[0] === 'null'))));
    nullableFromUnion = nonNull.length < union.length;
    const { anyOf, oneOf, ...rest } = s;
    if (nonNull.length === 1) {
      s = merge(nonNull[0]?.$ref ? resolveRef(nonNull[0].$ref, root) || {} : nonNull[0] || {}, rest);
    } else if (nonNull.length > 1) {
      const w = [];
      w[S.anyOf] = nonNull.map((u) => schemaToWire(u, root, depth + 1));
      if (typeof rest.description === 'string' && rest.description) w[S.description] = rest.description;
      if (nullableFromUnion) w[S.nullable] = true;
      // anyOf nodes still need a concrete type; the first branch's type is what Gemini expects
      w[S.type] = w[S.anyOf][0]?.[0] || TYPE_CODES.object;
      return finalize(w);
    }
  }

  const { t, nullable } = guessType(s);
  const w = [TYPE_CODES[t]];
  if (typeof s.format === 'string' && s.format && (t === 'string' ? ['enum', 'date-time'].includes(s.format) : ['int32', 'int64', 'float', 'double'].includes(s.format))) {
    w[S.format] = s.format;
  }
  const desc = [s.description, s.title && !s.description ? s.title : null].find((x) => typeof x === 'string' && x);
  if (desc) w[S.description] = desc;
  if (s.nullable === true || nullable || nullableFromUnion) w[S.nullable] = true;

  let enumVals = Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : null;
  if (enumVals) {
    enumVals = enumVals.filter((x) => x !== null && x !== undefined);
    if (enumVals.length) {
      w[S.enum] = enumVals.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
      if (t !== 'string') w[S.type] = TYPE_CODES.string; // Gemini only accepts string enums
    }
  }

  if (t === 'array') {
    const items = Array.isArray(s.items) ? s.items[0] : s.items || (Array.isArray(s.prefixItems) ? s.prefixItems[0] : null);
    w[S.items] = items && typeof items === 'object' ? schemaToWire(items, root, depth + 1) : [TYPE_CODES.string];
    if (Number.isInteger(s.minItems)) w[S.minItems] = s.minItems;
    if (Number.isInteger(s.maxItems)) w[S.maxItems] = s.maxItems;
  }

  if (t === 'object' && s.properties && typeof s.properties === 'object') {
    const names = Object.keys(s.properties).filter((k) => s.properties[k] && typeof s.properties[k] === 'object');
    if (names.length) {
      w[S.properties] = names.map((k) => [k, schemaToWire(s.properties[k], root, depth + 1)]);
      if (Array.isArray(s.required)) {
        const req = s.required.filter((r) => names.includes(r));
        if (req.length) w[S.required] = req;
      }
    }
    if (Number.isInteger(s.minProperties)) w[S.minProperties] = s.minProperties;
    if (Number.isInteger(s.maxProperties)) w[S.maxProperties] = s.maxProperties;
  }

  if (t === 'number' || t === 'integer') {
    if (typeof s.minimum === 'number') w[S.minimum] = s.minimum;
    if (typeof s.maximum === 'number') w[S.maximum] = s.maximum;
  }
  if (t === 'string' && !w[S.enum]) {
    if (Number.isInteger(s.minLength)) w[S.minLength] = s.minLength;
    if (Number.isInteger(s.maxLength)) w[S.maxLength] = s.maxLength;
    if (typeof s.pattern === 'string' && s.pattern) w[S.pattern] = s.pattern;
  }
  return finalize(w);
}

function finalize(w) {
  for (let i = 0; i < w.length; i++) if (w[i] === undefined) w[i] = null;
  while (w.length && w[w.length - 1] === null) w.pop();
  return w;
}

// Gemini functionDeclaration / OpenAI function → wire [name, description, parameters]
export function declarationToWire(decl) {
  const d = decl.function && typeof decl.function === 'object' ? decl.function : decl;
  if (!d.name) throw new Error('函数声明缺少 name');
  const name = String(d.name);
  const params = d.parameters || d.parametersJsonSchema || d.input_schema || null;
  const w = [name, typeof d.description === 'string' ? d.description : null];
  if (params && typeof params === 'object') {
    const hasProps = params.properties && Object.keys(params.properties).length;
    if (hasProps || params.type !== 'object') w[2] = schemaToWire(params);
  }
  return finalize(w);
}
