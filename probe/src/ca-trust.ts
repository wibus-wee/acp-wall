import { rootCertificates } from 'node:tls';
import { readFileSync, writeFileSync } from 'node:fs';

/** SSL_CERT_FILE replaces (not extends) defaults in uv/OpenSSL clients. */
export function writeCombinedCaBundle(path: string, probeCa: string, inherited: NodeJS.ProcessEnv = process.env): string {
  const certificates = [...rootCertificates, readFileSync(probeCa, 'utf8')];
  for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'NODE_EXTRA_CA_CERTS']) {
    const source = inherited[key];
    if (source) certificates.push(readFileSync(source, 'utf8')); // fail closed if configured trust is unavailable
  }
  writeFileSync(path, certificates.join('\n'), { mode: 0o600 });
  return path;
}
