#!/usr/bin/env node
/**
 * Transparent TLS proxy for the ACP conformance probe (Linux CI only).
 *
 * iptables REDIRECT sends all outbound :443 here. For each connection we peek
 * at the TLS ClientHello:
 *  - SNI in the impersonation set (model API hosts) → mint a cert signed by
 *    the probe CA, terminate TLS, pipe plaintext to the local mock LLM.
 *  - anything else → raw TCP relay to the real host. TLS stays end-to-end;
 *    auth endpoints, telemetry and package registries are untouched.
 *
 * The proxy must run under a dedicated uid (CI uses `nobody`) so the
 * iptables owner-match can exempt its own upstream connections.
 */
import { createServer, connect, type Socket } from "node:net";
import * as tls from "node:tls";
import { lookup } from "node:dns";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Model-API hosts we impersonate. Deliberately excludes hosts that also
 * serve auth/licensing (api2.cursor.sh, api.github.com, *.googleapis.com
 * OAuth) — faking those would fabricate the account gate, not the model. */
const MODEL_DOMAINS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.x.ai",
  "api.mistral.ai",
  "codestral.mistral.ai",
  "api.groq.com",
  "openrouter.ai",
  "api.deepseek.com",
  "api.deepseek.ai",
  "api.z.ai",
  "open.bigmodel.cn",
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "api.moonshot.ai",
  "api.moonshot.cn",
  "api.cohere.com",
  "api.cohere.ai",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.perplexity.ai",
]);

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const MOCK_PORT = Number(arg("--mock-port"));
const CA_DIR = arg("--ca-dir") ?? "";
const LOG = arg("--log") ?? "";
for (const d of (arg("--domains") ?? "").split(",")) if (d.trim()) MODEL_DOMAINS.add(d.trim().toLowerCase());

const log = (rec: Record<string, unknown>) => {
  const line = JSON.stringify({ t: Date.now(), ...rec });
  if (LOG) try { appendFileSync(LOG, line + "\n"); } catch { /* best effort */ }
  console.error(`  [mitm] ${line}`);
};

function openssl(a: string[], cwd: string) {
  execFileSync("openssl", a, { stdio: ["ignore", "ignore", "pipe"], cwd });
}

export function ensureCa(dir: string) {
  const crt = join(dir, "ca.crt"), key = join(dir, "ca.key");
  if (!existsSync(crt)) {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-subj", "/CN=acp-probe-mitm-ca", "-keyout", key, "-out", crt,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"], dir);
  }
}

/** Mint (or reuse) a leaf cert for `host`, signed by the probe CA. */
function contextFor(host: string): tls.SecureContext {
  mkdirSync(join(CA_DIR, "certs"), { recursive: true });
  const safe = host.replace(/[^\w.-]/g, "_");
  const key = join(CA_DIR, "certs", `${safe}.key`);
  const crt = join(CA_DIR, "certs", `${safe}.crt`);
  if (!existsSync(crt)) {
    const csr = join(CA_DIR, "certs", `${safe}.csr`);
    const ext = join(CA_DIR, "certs", `${safe}.ext`);
    writeFileSync(ext, `subjectAltName=DNS:${host}\n`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${host}`, "-keyout", key, "-out", csr], CA_DIR);
    openssl(["x509", "-req", "-in", csr, "-CA", join(CA_DIR, "ca.crt"), "-CAkey", join(CA_DIR, "ca.key"),
      "-CAcreateserial", "-days", "2", "-extfile", ext, "-out", crt], CA_DIR);
  }
  return tls.createSecureContext({ key: readFileSync(key), cert: readFileSync(crt) });
}

/** Pull the SNI hostname out of a complete TLS ClientHello record. */
function sniOf(buf: Buffer): string | null {
  if (buf.length < 5 || buf[0] !== 0x16) return null;
  let p = 5;
  if (buf[p] !== 0x01) return null; // not a ClientHello
  p += 4 + 2 + 32; // hs type+len, client version, random
  const sidLen = buf[p]; p += 1 + sidLen;
  const csLen = buf.readUInt16BE(p); p += 2 + csLen;
  const compLen = buf[p]; p += 1 + compLen;
  const extEnd = Math.min(p + 2 + buf.readUInt16BE(p), buf.length);
  p += 2;
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    if (type === 0 && len >= 5) {
      const nameLen = buf.readUInt16BE(p + 7);
      return buf.subarray(p + 9, p + 9 + nameLen).toString("ascii");
    }
    p += 4 + len;
  }
  return null;
}

function impersonate(host: string, sock: Socket) {
  let ctx: tls.SecureContext;
  try {
    ctx = contextFor(host);
  } catch (e) {
    log({ sni: host, action: "mint-fail", err: String(e).slice(0, 120) });
    sock.destroy();
    return;
  }
  const tsock = new tls.TLSSocket(sock, {
    isServer: true,
    secureContext: ctx,
    ALPNProtocols: ["http/1.1"],
  });
  tsock.on("error", (e) => {
    log({ sni: host, action: "tls-fail", err: String(e).slice(0, 120) });
    sock.destroy();
  });
  tsock.once("secure", () => {
    const up = connect(MOCK_PORT, "127.0.0.1", () => {
      tsock.pipe(up).pipe(tsock);
      log({ sni: host, action: "impersonate" });
    });
    up.on("error", () => tsock.destroy());
  });
}

function relay(host: string, sock: Socket) {
  lookup(host, { all: true }, (err, addrs) => {
    if (err || !addrs?.length) {
      log({ sni: host, action: "dns-fail" });
      sock.destroy();
      return;
    }
    // IPv4 first — harnesses' egress is IPv4 on the runners, and a stalled
    // IPv6 attempt must not hold the client socket open.
    const ordered = [...addrs].sort((a, b) => a.family - b.family);
    let i = 0;
    const tryNext = () => {
      if (i >= ordered.length) {
        log({ sni: host, action: "unreachable" });
        sock.destroy();
        return;
      }
      const up = connect(443, ordered[i++].address);
      let connected = false;
      const fail = () => {
        if (connected) sock.destroy();
        else {
          up.destroy();
          tryNext();
        }
      };
      up.setTimeout(8000, fail);
      up.once("connect", () => {
        connected = true;
        up.setTimeout(0);
        // ClientHello was unshift()ed back onto sock — it flows through first.
        sock.pipe(up).pipe(sock);
        log({ sni: host, action: "relay" });
      });
      up.on("error", fail);
    };
    tryNext();
  });
}

function route(sock: Socket) {
  let buf = Buffer.alloc(0);
  const onData = (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    if (buf.length < 5) return;
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return; // wait for the full record
    sock.off("data", onData);
    sock.pause(); // paused sockets keep unshift()ed bytes for the next consumer
    const host = buf[0] === 0x16 ? sniOf(buf) : null;
    sock.unshift(buf);
    sock.setTimeout(0); // routed sockets may be long-lived (keep-alive, SSE)
    if (!host) {
      log({ action: "drop", reason: "no SNI / not TLS" });
      sock.destroy();
      return;
    }
    if (MODEL_DOMAINS.has(host.toLowerCase())) impersonate(host, sock);
    else relay(host, sock);
  };
  sock.on("data", onData);
  sock.on("error", () => sock.destroy());
  sock.setTimeout(20000, () => sock.destroy());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!MOCK_PORT || !CA_DIR) {
    console.error("usage: mitm.js --mock-port N --ca-dir DIR [--port N] [--domains a,b] [--log FILE]");
    process.exit(2);
  }
  ensureCa(CA_DIR);
  const srv = createServer(route);
  srv.listen(Number(arg("--port") ?? 0), "0.0.0.0", () => {
    const a = srv.address();
    const port = typeof a === "object" && a ? a.port : 0;
    // parent (cli.ts) parses this line to learn the port for the iptables rule
    console.log(`PORT=${port}`);
  });
}
