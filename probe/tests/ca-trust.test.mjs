import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { writeCombinedCaBundle } from '../dist/src/ca-trust.js';
test('replacement CA bundle preserves public roots and inherited custom trust', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-ca-test-'));
  try {
    const ca=join(dir,'probe.pem'), custom=join(dir,'custom.pem'), out=join(dir,'all.pem');
    writeFileSync(ca,'PROBE_CA'); writeFileSync(custom,'CUSTOM_CA');
    writeCombinedCaBundle(out,ca,{SSL_CERT_FILE:custom});
    const pem=readFileSync(out,'utf8');
    assert.ok(rootCertificates.every(cert=>pem.includes(cert)));
    assert.match(pem,/PROBE_CA/); assert.match(pem,/CUSTOM_CA/);
    assert.throws(()=>writeCombinedCaBundle(out,ca,{SSL_CERT_FILE:join(dir,'missing')}));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
