// schema.ts — zero-dep JSON Schema validator for the vendored ACP schema.
// Covers the constructs the ACP schema actually uses: $ref (#/$defs/*),
// allOf/anyOf/oneOf, type (+ type arrays), properties/required,
// additionalProperties (bool or schema), items, enum, const, minimum,
// min/maxItems, pattern. `format`/annotations are ignored.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Violation {
  path: string;
  msg: string;
}

export interface MethodBinding {
  request?: string;
  response?: string;
}

export class SchemaIndex {
  private root: any;
  private defs: Record<string, any>;
  /** method → {request,response} def names, split by side */
  readonly bindings: { agent: Map<string, MethodBinding>; client: Map<string, MethodBinding> } = {
    agent: new Map(),
    client: new Map(),
  };

  constructor(schemaPath?: string) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      schemaPath,
      join(here, "..", "schema", "acp-schema.json"),      // running from src/
      join(here, "..", "..", "schema", "acp-schema.json"), // running from dist/src/
    ].filter(Boolean) as string[];
    const p = candidates.find((c) => existsSync(c));
    if (!p) throw new Error(`acp-schema.json not found (tried ${candidates.join(", ")})`);
    this.root = JSON.parse(readFileSync(p, "utf8"));
    this.defs = this.root.$defs ?? this.root.definitions ?? {};
    for (const [name, def] of Object.entries<any>(this.defs)) {
      const side = def["x-side"] as "agent" | "client" | undefined;
      const method = def["x-method"] as string | undefined;
      if (!side || !method || (side !== "agent" && side !== "client")) continue;
      const b = this.bindings[side].get(method) ?? {};
      if (name.endsWith("Response")) b.response = name;
      else if (name.endsWith("Request") || name.endsWith("Notification")) b.request = name;
      this.bindings[side].set(method, b);
    }
  }

  def(name: string): any {
    return this.defs[name];
  }

  /** Validate `value` against def name or inline schema; returns violations. */
  validate(value: any, schemaOrName: any, path = ""): Violation[] {
    const schema = typeof schemaOrName === "string" ? this.def(schemaOrName) : schemaOrName;
    if (!schema) return [{ path, msg: `unknown schema ${schemaOrName}` }];
    return this.v(value, schema, path);
  }

  private resolve(s: any): any {
    while (s && typeof s === "object" && s.$ref) {
      const ref: string = s.$ref;
      if (!ref.startsWith("#/$defs/")) return s; // external refs unsupported
      const target = this.defs[ref.slice(8)];
      if (!target) return s;
      s = target;
    }
    return s;
  }

  private typeOf(v: any): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number" && Number.isInteger(v)) return "integer";
    return typeof v;
  }

  private typeOk(v: any, want: string | string[]): boolean {
    const wants = Array.isArray(want) ? want : [want];
    const got = this.typeOf(v);
    return wants.some((w) => (w === "integer" ? got === "integer" : w === "number" ? got === "integer" || got === "number" : got === w));
  }

  private v(value: any, raw: any, path: string): Violation[] {
    const s = this.resolve(raw);
    if (!s || typeof s !== "object") return [];
    const out: Violation[] = [];

    if (s.allOf) {
      for (const sub of s.allOf) out.push(...this.v(value, sub, path));
    }
    if (s.anyOf) {
      const results: Violation[][] = s.anyOf.map((sub: any) => this.v(value, sub, path));
      if (!results.some((r) => r.length === 0)) {
        // report the closest branch
        const best = results.reduce((a, b) => (a.length <= b.length ? a : b));
        out.push(...best.map((r) => ({ ...r, msg: `anyOf: ${r.msg}` })));
      }
    }
    if (s.oneOf) {
      const results: Violation[][] = s.oneOf.map((sub: any) => this.v(value, sub, path));
      const ok = results.filter((r) => r.length === 0).length;
      if (ok !== 1) {
        const best = results.reduce((a, b) => (a.length <= b.length ? a : b));
        out.push(...best.map((r) => ({ ...r, msg: `oneOf(${ok} matched): ${r.msg}` })));
      }
    }
    if (s.const !== undefined && value !== s.const) {
      out.push({ path, msg: `const ${JSON.stringify(s.const)} expected, got ${JSON.stringify(value)}` });
    }
    if (s.enum && !s.enum.includes(value)) {
      out.push({ path, msg: `enum violation: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}` });
    }
    if (s.type && !this.typeOk(value, s.type)) {
      out.push({ path, msg: `type ${this.typeOf(value)} ≠ ${JSON.stringify(s.type)}` });
      return out; // deeper checks meaningless on type mismatch
    }

    const t = this.typeOf(value);
    if (t === "object") {
      if (s.required) {
        for (const k of s.required) {
          if (!(k in value)) out.push({ path: path ? `${path}.${k}` : k, msg: "required property missing" });
        }
      }
      const props = s.properties ?? {};
      for (const [k, sub] of Object.entries<any>(props)) {
        if (k in value) out.push(...this.v(value[k], sub, path ? `${path}.${k}` : k));
      }
      if (s.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in props) && k !== "_meta") out.push({ path: path ? `${path}.${k}` : k, msg: "unexpected property" });
        }
      } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
        for (const k of Object.keys(value)) {
          if (!(k in props)) out.push(...this.v(value[k], s.additionalProperties, path ? `${path}.${k}` : k));
        }
      }
    }
    if (t === "array") {
      if (s.minItems !== undefined && value.length < s.minItems)
        out.push({ path, msg: `minItems ${s.minItems}: got ${value.length}` });
      if (s.maxItems !== undefined && value.length > s.maxItems)
        out.push({ path, msg: `maxItems ${s.maxItems}: got ${value.length}` });
      if (s.items) value.forEach((v: any, i: number) => out.push(...this.v(v, s.items, `${path}[${i}]`)));
    }
    if (typeof value === "number") {
      if (s.minimum !== undefined && value < s.minimum) out.push({ path, msg: `below minimum ${s.minimum}` });
      if (s.maximum !== undefined && value > s.maximum) out.push({ path, msg: `above maximum ${s.maximum}` });
    }
    if (typeof value === "string" && s.pattern) {
      if (!new RegExp(s.pattern).test(value)) out.push({ path, msg: `pattern ${s.pattern} mismatch` });
    }
    return out;
  }
}

export const schema = new SchemaIndex();
