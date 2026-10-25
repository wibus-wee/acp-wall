import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
test('package prewarming installs an environment without invoking the agent entry point',()=>{
 const dir=mkdtempSync(join(tmpdir(),'acp-prepare-'));
 try {
  const bin=join(dir,'bin'),log=join(dir,'args');mkdirSync(bin);
  for(const command of ['npm','uvx'])writeFileSync(join(bin,command),`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});
  for(const type of ['npx','uvx']) {
   const entry=join(dir,'entry.json');writeFileSync(entry,JSON.stringify({name:'fixture',run:'must-not-start-agent',dist:{type,package:'fixture@1.2.3'}}));
   execFileSync(process.execPath,['tools/install-dist.mjs',entry],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH},stdio:'pipe'});
   const args=JSON.parse(readFileSync(log));
   assert.deepEqual(args,type==='npx'?['exec','--yes','--package=fixture@1.2.3','--','node','-e','']:['--from','fixture@1.2.3','python','-c','pass']);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('installation failure report preserves concrete diagnostics',()=>{
 const dir=mkdtempSync(join(tmpdir(),'acp-install-error-'));
 try{
  const entry=join(dir,'entry.json'),out=join(dir,'out.json'),log=join(dir,'install.log');
  writeFileSync(entry,JSON.stringify({name:'fixture'}));writeFileSync(log,'npm error E404 package unavailable');
  execFileSync(process.execPath,['tools/record-failure.mjs',entry,out,'Distribution installation failed','1',log],{cwd:root,stdio:'pipe'});
  const report=JSON.parse(readFileSync(out));assert.equal(report.setup.phase,'installation');assert.match(report.setup.note,/E404 package unavailable/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
