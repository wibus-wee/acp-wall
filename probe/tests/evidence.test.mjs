import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyError, probeInitialize, probeSessionNew, probeSessionPrompt, probeSessionMgmt, probeAuthenticate, probeLoadReplay, probeClientCalls, probePermissionProfiles, runPromptScenario, probePromptContent, checkNotification, checkClientResponse, applyViolations } from '../dist/src/probes.js';
import { buildReport } from '../dist/src/report.js';
import { summarize, cellsFromMethods, uncertaintyReasons } from '../src/evidence.js';
import { runSetup } from '../dist/src/setup.js';
const root = resolve(import.meta.dirname, '../..');
const calls = () => ({ fsReads:[],fsWrites:[],terminalCreates:[],terminalCalls:[],permissionRequests:[],elicitations:[],mcpRelayCalls:[],elicitationCompletes:[] });
const context = handler => ({ rpc:{request:handler,notify(){}}, calls:calls(), initResult:{agentCapabilities:{}}, sessionCwd:'/tmp', askPolicy:false, updates:[],results:{},violations:[],dishonesty:[] });
const rejected = e => async () => { throw e; };
const options = results => ({harness:'test',initResult:{protocolVersion:1},results,dishonesty:[],violations:[],transcript:[]});

test('structured errors preserve the distinction between absence, authentication, rejection and timeout',()=>{
  assert.equal(classifyError({code:-32601,message:'Method not found'},false,true).status,'fail');
  assert.equal(classifyError({code:-32601,message:'Method not found'}).status,'unsupported');
  assert.equal(classifyError({code:-32000,message:'Authentication required'}).status,'blocked');
  assert.equal(classifyError({code:-32000,timeout:true,message:'timed out'}).status,'na');
  assert.equal(classifyError({code:-32603,message:'Internal error'}).status,'observed');
  assert.equal(classifyError({code:-32602,message:'Invalid params'}).status,'observed');
});
test('core method_not_found never earns successful evidence',async()=>{
  for(const [method,fn]of [['initialize',probeInitialize],['session/new',probeSessionNew],['session/prompt',probeSessionPrompt]]){
    const ctx=context(rejected({code:-32601,message:'Method not found'})); ctx.sessionId='s';
    await fn(ctx); assert.equal(ctx.results[method].status,'fail');
  }
});
test('blocked session prevents fake prompt calls',async()=>{
  let requests=0;const ctx=context(async()=>{requests++;throw {code:-32000,message:'Authentication required'};});
  await probeSessionNew(ctx);await probeSessionPrompt(ctx);probeClientCalls(ctx);
  assert.equal(requests,1);assert.equal(ctx.results['session/new'].status,'blocked');
  assert.equal(ctx.results['session/prompt'].blockedBy,'session/new');
  assert.equal(ctx.results['fs/read_text_file'].status,'blocked');
});
test('one unsupported submethod does not erase a successful list operation',()=>{
  const m={'session/list':{status:'pass'},'session/resume':{status:'blocked'},'session/close':{status:'observed'},'session/delete':{status:'unsupported'}};
  const c=cellsFromMethods(m).find(c=>c.key==='sessions/*');assert.equal(c.status,'mixed');assert.equal(c.items[0].status,'pass');
  assert.equal(summarize(m).pass,1);assert.equal(summarize(m).unsupported,1);
});
test('report has evidence counts and pinned schema, with no inferred grade',()=>{
  const r=buildReport(options({initialize:{status:'pass'}}));
  assert.equal(r.reportVersion,2);assert.equal(r.summary.pass,1);assert.ok(r.summary.na>0);
  assert.match(r.schemaSha256,/^[a-f0-9]{64}$/);assert.equal(r.score,undefined);assert.equal(r.tier,undefined);
});
test('no auth declaration does not cause an invented authenticate request',async()=>{
  const ctx=context(()=>{throw Error('must not call');});await probeAuthenticate(ctx);assert.equal(ctx.results.authenticate.status,'na');
});
test('interactive authentication remains blocked during unattended discovery',async()=>{
  const ctx=context(()=>{throw Error('must not call');});ctx.initResult.authMethods=[{id:'browser',name:'Login'}];await probeAuthenticate(ctx);assert.equal(ctx.results.authenticate.status,'blocked');
});
test('disposable session failure never closes the working session',async()=>{
  const requests=[];const ctx=context(async method=>{requests.push(method);throw {code:-32603,message:'failed'};});ctx.sessionId='working';ctx.initResult.agentCapabilities.sessionCapabilities={close:{},delete:{}};
  await probeSessionMgmt(ctx);assert.deepEqual(requests,['session/new','session/new']);assert.equal(ctx.results['session/close'].status,'blocked');
});
test('a later failed prompt is retained instead of hidden by earlier successes',async()=>{
  let n=0;const ctx=context(async()=>{if(n++)throw {code:-32603,message:'model failed'};return {stopReason:'end_turn'};});ctx.sessionId='s';await probeSessionPrompt(ctx);assert.equal(ctx.results['session/prompt'].status,'observed');assert.match(ctx.results['session/prompt'].note,/1 earlier turn/);
});
test('notification schema errors are attributed to their actual feature',()=>{
  const ctx=context(async()=>({}));ctx.results={'update:message':{status:'pass'},'update:tool_call':{status:'pass'},'update:usage':{status:'pass'}};
  checkNotification(ctx,'session/update',{sessionId:'s',update:{sessionUpdate:'tool_call',title:'missing id'}});
  assert.ok(ctx.violations.length);applyViolations(ctx);assert.equal(ctx.results['update:tool_call'].status,'partial');assert.equal(ctx.results['update:message'].status,'pass');
});
test('a probe-side response defect is not charged as an agent schema issue',()=>{
  const ctx=context(async()=>({}));ctx.results={'fs/read_text_file':{status:'pass'}};checkClientResponse(ctx,'fs/read_text_file',{});applyViolations(ctx);assert.equal(ctx.results['fs/read_text_file'].status,'error');
});
test('state notifications cannot prove conversation replay',async()=>{
  const ctx=context(async()=>{ctx.updates.push({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});return {};});
  ctx.sessionId='s';ctx.initResult.agentCapabilities.loadSession=true;ctx.sessionNewParams={cwd:'/tmp',mcpServers:[]};
  await probeLoadReplay(ctx);assert.equal(ctx.results['load:replay'].status,'na');
});
const message = (text, kind = 'agent_message_chunk', sessionId = 's') => ({method:'session/update',params:{sessionId,update:{sessionUpdate:kind,content:{type:'text',text}}}});
const replayContext = handler => {
  const ctx=context(handler);ctx.sessionId='s';ctx.initResult.agentCapabilities.loadSession=true;ctx.sessionNewParams={cwd:'/tmp',mcpServers:[]};
  ctx.updates=[message('first answer'),message('second answer')];return ctx;
};
test('replay tolerates user echoes and different assistant chunk boundaries',async()=>{
  const ctx=replayContext(async()=>{ctx.updates.push(message('question one','user_message_chunk'),message('first '),message('answer'),message('question two','user_message_chunk'),message('second answer'));return {};});
  await probeLoadReplay(ctx);assert.equal(ctx.results['load:replay'].status,'pass');assert.equal(ctx.attempts.length,1);
});
test('a second load can establish replay while retaining the empty first attempt',async()=>{
  let count=0;const ctx=replayContext(async()=>{if(++count===2)ctx.updates.push(message('first answersecond answer'));return {};});
  ctx.scenario='original';await probeLoadReplay(ctx);
  assert.equal(ctx.results['load:replay'].status,'pass');assert.match(ctx.results['load:replay'].note,/first load returned no conversation/);
  assert.deepEqual(ctx.attempts.map(a=>a.scenario),['load:replay:1','load:replay:2']);assert.equal(ctx.scenario,'original');
});
test('other sessions and user text cannot stand in for assistant replay',async()=>{
  for(const update of [message('first answersecond answer','agent_message_chunk','other'),message('first answersecond answer','user_message_chunk')]){
    const ctx=replayContext(async()=>{ctx.updates.push(update);return {};});await probeLoadReplay(ctx);
    assert.notEqual(ctx.results['load:replay'].status,'pass');assert.ok(ctx.attempts.length<=2);
  }
});
test('internal tools without client callbacks do not imply a protocol or permission failure',()=>{
  const ctx=context(async()=>({}));ctx.sessionId='s';ctx.askPolicy=true;ctx.updates=[{method:'session/update',params:{update:{sessionUpdate:'tool_call',kind:'execute',status:'completed'}}}];probeClientCalls(ctx);assert.equal(ctx.results['request_permission'].status,'na');assert.equal(ctx.results['terminal/*'].status,'na');
});
test('setup failure stops subsequent preparation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acp-setup-test-'));
  try{const result=await runSetup(['exit 7',`${process.execPath} -e "require('fs').writeFileSync('ran','yes')"`],{},dir,1000);assert.equal(result.status,'error');assert.equal(result.step,1);assert.equal(existsSync(join(dir,'ran')),false);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('setup failure publishes an error report without starting ACP',()=>{
  const dir=mkdtempSync(join(tmpdir(),'acp-setup-cli-'));
  try{
    const entry=join(dir,'entry.json'),out=join(dir,'report.json');writeFileSync(entry,JSON.stringify({name:'setup-fixture',setup:['exit 8'],run:`${process.execPath} -e "require('fs').writeFileSync('${dir}/launched','yes')"`}));
    execFileSync(process.execPath,['probe/dist/src/cli.js','--entry',entry,'--out',out],{cwd:root,timeout:10000,stdio:'pipe'});
    const r=JSON.parse(readFileSync(out));assert.equal(r.state,'probe-error');assert.equal(r.summary.pass,0);assert.equal(existsSync(join(dir,'launched')),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('aggregation preserves historical uncertainty and does not overwrite a newer run',()=>{
  const dir=mkdtempSync(join(tmpdir(),'acp-aggregate-test-'));
  try{
    const reg=join(dir,'registry'),reports=join(dir,'reports'),out=join(dir,'data.js');mkdirSync(reg);mkdirSync(reports);
    writeFileSync(join(reg,'a.json'),JSON.stringify({name:'a',display:'Agent A'}));
    writeFileSync(out,'window.__ACP_WALL__ = '+JSON.stringify({harnesses:[{id:'a',n:'Agent A',probedAt:'2026-10-03T00:00:00Z',score:100,cells:[1],notes:{initialize:'old'}}]})+';');
    const r=buildReport({...options({initialize:{status:'pass'}}),harness:'a'});r.probedAt='2026-10-01T00:00:00Z';writeFileSync(join(reports,'a.report.json'),JSON.stringify(r));
    const aggregate=()=>{execFileSync(process.execPath,['tools/aggregate.mjs','--registry',reg,'--reports',reports,'--out',out],{cwd:root,stdio:'pipe'});const s=readFileSync(out,'utf8');return JSON.parse(s.slice(s.indexOf('=')+1).trim().replace(/;$/,''));};
    let data=aggregate();assert.equal(data.harnesses[0].state,'legacy');assert.equal(data.harnesses[0].cells[0],1);assert.equal(data.harnesses[0].score,100);
    r.probedAt='2026-10-04T00:00:00Z';writeFileSync(join(reports,'a.report.json'),JSON.stringify(r));data=aggregate();assert.equal(data.harnesses[0].state,'measured');assert.equal(data.harnesses[0].score,4);assert.ok(existsSync(join(dir,'reports','a.json')));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('complete CLI fixtures retain useful evidence without grading absent features',()=>{
  const dir=mkdtempSync(join(tmpdir(),'acp-fixtures-'));
  try{
    for(const name of ['good','mini','liar']){
      const out=join(dir,`${name}.json`);
      execFileSync(process.execPath,['probe/dist/src/cli.js','--entry',`registry/fixture-${name}.json`,'--out',out],{cwd:root,timeout:20000,stdio:'pipe'});
      const r=JSON.parse(readFileSync(out));
      assert.equal(r.methods.initialize.status,'pass');assert.equal(r.score,undefined);
      if(name==='liar'){assert.equal(r.methods['session/load'].status,'fail');assert.equal(r.state,'issues');assert.ok(r.claimMismatches.length);}
      else {assert.equal(r.state,'measured');assert.equal(r.summary.fail,0);assert.equal(r.summary.error,0);}
      if(name==='good')assert.ok(r.transcript.filter(e=>e.dir==='out'&&['req','res','notif'].includes(e.kind)).every(e=>e.raw?.jsonrpc==='2.0'));
      if(name==='mini')assert.equal(r.methods['mcp:stdio'].status,'observed');
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('an unmapped client defect remains a run-level probe error',()=>{
  const r=buildReport({...options({initialize:{status:'pass'}}),violations:[{where:'client-request',method:'future-method',path:'',msg:'bad fixture'}]});assert.equal(r.state,'probe-error');assert.equal(r.methods.initialize.status,'pass');
});
test('permission profiles require a distinct session and an exactly offered option',async()=>{
  for(const response of [{sessionId:'working'}, {sessionId:'fresh',configOptions:[{id:'permission',options:[{value:'read-only'}]}]}]){
    const requests=[];const ctx=context(async(method,params)=>{requests.push({method,params});return response;});ctx.sessionId='working';ctx.probeProfiles=[{id:'write',configId:'permission',value:'workspace-write',description:'fixture'}];
    await probePermissionProfiles(ctx);assert.deepEqual(requests.map(r=>r.method),['session/new']);assert.equal(ctx.scenarios.length,1);assert.notEqual(ctx.scenarios[0].result.status,'pass');
  }
});
test('configured permission scenarios retain profile values and never prompt the baseline session',async()=>{
  const requests=[];const options=[{id:'permission',name:'Permission',type:'select',currentValue:'read-only',options:[{name:'Read',value:'read-only'},{name:'Write',value:'workspace-write'}]}];
  const ctx=context(async(method,params)=>{requests.push({method,params});if(method==='session/new')return {sessionId:'fresh',configOptions:options};if(method==='session/set_config_option')return {configOptions:[{...options[0],currentValue:'workspace-write'}]};return {stopReason:'end_turn'};});
  ctx.sessionId='working';ctx.probeProfiles=[{id:'write',configId:'permission',value:'workspace-write',description:'fixture'}];await probePermissionProfiles(ctx);
  assert.equal(ctx.sessionId,'working');assert.equal(ctx.scenarios.length,3);assert.ok(requests.filter(r=>r.method==='session/prompt').every(r=>r.params.sessionId==='fresh'));assert.ok(ctx.scenarios.every(s=>s.configuration.permission==='workspace-write'));
});
test('scenario callbacks and updates exclude traffic from other sessions',async()=>{
  const ctx=context(async()=>{ctx.calls.fsWrites.push({sessionId:'other',path:'/tmp/file',content:'x'});ctx.updates.push(message('alien','agent_message_chunk','other'));return {stopReason:'end_turn'};});
  await runPromptScenario(ctx,'default:write','s',[{type:'text',text:'write'}]);assert.equal(ctx.scenarios[0].callbacks['fs/write_text_file'],0);assert.deepEqual(ctx.scenarios[0].notifications,[]);
});
test('explicit policy denial is a cause of missing callbacks, not unsupported capability',()=>{
  const ctx=context(async()=>({}));ctx.sessionId='s';ctx.scenarios=[{id:'default:write',tools:[{status:'failed',detail:'source: capability_rule'}]}];probeClientCalls(ctx);
  assert.equal(ctx.results['fs/write_text_file'].status,'na');assert.equal(ctx.results['fs/write_text_file'].reason,'policy-rejected');
  assert.equal(uncertaintyReasons(ctx.results)['policy-rejected'],1);
});
test('unadvertised content capabilities are not invoked during normal probing',async()=>{
  const ctx=context(()=>{throw Error('must not invoke');});ctx.sessionId='s';await probePromptContent(ctx);assert.equal(ctx.results['prompt:image'].reason,'not-advertised');assert.equal(ctx.results['prompt:embedded-context'].reason,'not-advertised');
});
test('malformed typed-prompt replies remain schema issues in both method and scenario evidence',async()=>{
  const ctx=context(async method=>method==='session/new'?{sessionId:'typed'}:{stopReason:42});ctx.sessionId='s';ctx.initResult.agentCapabilities.promptCapabilities={image:true};
  await probePromptContent(ctx);assert.equal(ctx.results['prompt:image'].status,'partial');assert.equal(ctx.scenarios[0].result.status,'partial');assert.ok(ctx.violations.length);
});
