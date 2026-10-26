// Pinned ACP schema validated with JSON Schema Draft 2020-12.
// Format annotations are deliberately not assertions. No coercion or mutation.
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
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
  private readonly options = { strict: false, allErrors: true, validateFormats: false, addUsedSchema: false };
  private readonly ajv = new Ajv2020(this.options);
  private readonly draft7 = new Ajv(this.options);
  private readonly draft2019 = new Ajv2019(this.options);
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
        // ACP remains pinned to 2020-12. Model tool schemas are independent
        // documents and may explicitly use older dialects (e.g. Zod Draft 7).
        // Never strip $schema or silently accept a compilation error.
        const dialect = typeof schemaOrName === "string" ? undefined : selected?.$schema;
        const compiler = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(dialect ?? "") ? this.draft7
          : /^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/.test(dialect ?? "") ? this.draft2019 : this.ajv;
        const canonicalDialect = compiler === this.draft7 ? "http://json-schema.org/draft-07/schema#"
          : compiler === this.draft2019 ? "https://json-schema.org/draft/2019-09/schema" : dialect;
        validate = compiler.compile(dialect && typeof document === "object" ? { ...document, $schema: canonicalDialect } : document);
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
