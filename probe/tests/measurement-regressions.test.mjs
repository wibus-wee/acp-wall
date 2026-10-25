import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLody, probeSetMode, probeSetConfig, probeCancel, probeClientCalls } from '../dist/src/probes.js';
import '../../ui/evidence-view.js';
const context = handler => ({ rpc:{request:handler,notify(){}}, calls:{fsReads:[],fsWrites:[],terminalCreates:[],terminalCalls:[],permissionRequests:[],elicitations:[]}, initResult:{agentCapabilities:{}}, sessionCwd:'/tmp', updates:[],results:{},violations:[],dishonesty:[] });

test('null or rejected extension replies do not imply support or use fake sessions', async () => {
  const requests=[];const ctx=context(async (m,p)=>{requests.push([m,p]);return null;});
  await probeLody(ctx);
  assert.equal(requests.length,1);assert.equal(requests[0][0],'_lody/rate_limits/get');
  assert.equal(ctx.lody.endpoints[0].outcome,'null-result');
  assert.equal(AcpEvidenceView.extensionMark({lody:ctx.lody}).txt,'·');
  assert.equal(AcpEvidenceView.extensionMark({lody:{advertised:{},answered:['anything'],observed:[]}}).txt,'·');
});
test('blocked measurements are not ranked but retain coverage and issue evidence', () => {
  const a=AcpEvidenceView.assessment({score:4,methods:{initialize:{status:'pass'},'session/new':{status:'blocked',reason:'authentication'}}});
  assert.equal(a.rankable,false);assert.equal(a.coverage,4);assert.equal(a.label,'Authentication blocked');
  const methods=Object.fromEntries(['initialize','session/new','session/prompt'].map(k=>[k,{status:'pass'}]));
  assert.equal(AcpEvidenceView.assessment({methods}).rankable,true);
  assert.equal(AcpEvidenceView.assessment({methods,setup:{status:'error'}}).rankable,false);
});
test('mode probe changes another offered mode and restores the baseline', async () => {
  const requests=[];const ctx=context(async(m,p)=>{requests.push(p.modeId);ctx.updates.push({params:{sessionId:'s',update:{sessionUpdate:'current_mode_update',currentModeId:p.modeId}}});return {};});
  ctx.sessionId='s';ctx.sessionModes={currentModeId:'read',availableModes:[{id:'read'},{id:'write'}]};
  await probeSetMode(ctx);assert.deepEqual(requests,['write','read']);assert.equal(ctx.results.set_mode.status,'pass');
});
test('configuration probe confirms changed and restored values', async () => {
  const values=[];const ctx=context(async(m,p)=>{values.push(p.value);return {configOptions:[{id:'permission',type:'select',name:'Permission',currentValue:p.value,options:[{name:'Read',value:'read'},{name:'Write',value:'write'}]}]};});
  ctx.sessionId='s';ctx.sessionConfigOptions=[{id:'permission',type:'select',currentValue:'read',options:[{value:'read'},{value:'write'}]}];
  await probeSetConfig(ctx);assert.deepEqual(values,['write','read']);assert.equal(ctx.results.set_config.status,'pass');
});
test('unconfirmed restoration prevents baseline prompts',async()=>{
  const ctx=context(async()=>({configOptions:[]}));ctx.sessionId='s';ctx.sessionConfigOptions=[{id:'x',currentValue:'a',options:[{value:'a'},{value:'b'}]}];
  await probeSetConfig(ctx);assert.equal(ctx.promptBlocked,true);assert.equal(ctx.results.set_config.reason,'restoration-unconfirmed');
});
test('terminal create alone is diagnostic, not a complete terminal lifecycle',()=>{
  const ctx=context(async()=>({}));ctx.sessionId='s';ctx.calls.terminalCreates=[{sessionId:'s',command:'echo'}];
  probeClientCalls(ctx);assert.equal(ctx.results['terminal/*'].status,'observed');
});
test('cancel waits for model-side barrier instead of a 400ms guess',async()=>{
  let resolve;const ctx=context(()=>new Promise(r=>{resolve=r;setTimeout(()=>{ctx.mcpLlmEvidence.slowRequests++;ctx.mcpLlmEvidence.slowPending++;},500);}));
  ctx.sessionId='s';ctx.mcpLlmEvidence={slowRequests:0,slowPending:0};
  ctx.rpc.notify=()=>{assert.equal(ctx.mcpLlmEvidence.slowPending,1);resolve({stopReason:'cancelled'});};
  await probeCancel(ctx);assert.equal(ctx.results.cancel.status,'pass');
});
test('process diagnostics distinguish environmental blockers from unknown exits',async()=>{
  const {classifyError}=await import('../dist/src/probes.js');
  for(const [stderr,reason] of [['invalid peer certificate: UnknownIssuer','environment-tls'],['sandbox_unavailable: socat not installed','runtime-prerequisite'],['npm error E404','package-resolution']]) {
    const r=classifyError({processExit:true,stderr,message:stderr});assert.equal(r.status,'blocked');assert.equal(r.reason,reason);assert.match(r.note,new RegExp(stderr.split(':')[0]));
  }
  assert.equal(classifyError({processExit:true,stderr:'unknown crash',message:'exit 2'}).status,'na');
});

test('Lody column restores +N declarations ahead of observations', () => {
  assert.equal(AcpEvidenceView.extensionMark({lody:{advertised:{usage:{},goal:{}},observed:['goal']}}).txt,'+2');
  assert.equal(AcpEvidenceView.extensionMark({lody:{advertised:{usage:{}},observed:[]}}).txt,'+1');
  assert.equal(AcpEvidenceView.extensionMark({lody:{advertised:{},observed:['goal']}}).txt,'±');
});
test('offering interactive authentication is not the cause of every incomplete run', () => {
  const methods={initialize:{status:'pass'},authenticate:{status:'blocked',reason:'interactive-auth'},'session/new':{status:'observed',reason:'request-rejected'}};
  assert.equal(AcpEvidenceView.assessment({methods}).label,'Measurement incomplete');
});
