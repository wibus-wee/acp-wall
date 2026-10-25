// Pinned ACP schema validated with JSON Schema Draft 2020-12.
// Format annotations are deliberately not assertions. No coercion or mutation.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
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
  readonly sha256: string;
  private root: any;
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  private readonly compiled = new Map<any, ValidateFunction>();
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
    const source = readFileSync(p, "utf8");
    this.sha256 = createHash("sha256").update(source).digest("hex");
    this.root = JSON.parse(source);
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

  /** Compilation failures remain explicit instead of silently accepting unknown schemas. */
  validate(value: any, schemaOrName: any, path = ""): Violation[] {
    const selected = typeof schemaOrName === "string" ? this.def(schemaOrName) : schemaOrName;
    if (selected === undefined) return [{ path, msg: `unknown schema ${schemaOrName}` }];
    try {
      let validate = this.compiled.get(schemaOrName);
      if (!validate) {
        const document = typeof schemaOrName === "string"
          ? { $defs: this.defs, $ref: `#/$defs/${schemaOrName}` }
          : typeof selected === "boolean" ? selected : { $defs: this.defs, ...selected };
        validate = this.ajv.compile(document);
        this.compiled.set(schemaOrName, validate);
      }
      if (validate(value)) return [];
      return (validate.errors ?? []).map(error => ({
        path: path + error.instancePath + (error.keyword === "required" ? `/${error.params.missingProperty}` : ""),
        msg: `${error.keyword}: ${error.message ?? "schema validation failed"}`,
      }));
    } catch (error) {
      return [{ path, msg: `schema compilation failed: ${String(error)}` }];
    }
  }
}

export const schema = new SchemaIndex();
