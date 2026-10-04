import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from '../dist/src/mock-llm.js';
const tools = [
  {type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}},
  {type:'function',function:{name:'write_file',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}},
  {type:'function',function:{name:'run_command',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}}},
  {type:'function',function:{name:'mcp__probe_noop',parameters:{type:'object',properties:{}}}},
];
const post = async(s,path,body)=>{const r=await fetch(s.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
test('each user turn selects its own tool despite tool results in earlier history',async()=>{
  const s=await startMockLlm();
  try{
    const messages=[{role:'user',content:'__probe_read__ read the file'}];
    const a=await post(s,'/chat/completions',{tools,messages});assert.equal(a.choices[0].message.tool_calls[0].function.name,'read_file');
    messages.push(a.choices[0].message,{role:'tool',tool_call_id:'call_probe_1',content:'CANARY-7729'});
    const b=await post(s,'/chat/completions',{tools,messages});assert.equal(b.choices[0].finish_reason,'stop');
    messages.push(b.choices[0].message,{role:'user',content:'__probe_write__ write the file'});
    const c=await post(s,'/chat/completions',{tools,messages});assert.equal(c.choices[0].message.tool_calls[0].function.name,'write_file');
    assert.equal(s.evidence.issuedCalls.length,2);
  }finally{s.close();}
});
test('MCP fixture is selected only for the MCP scenario',async()=>{
  const s=await startMockLlm();try{for(const [kind,name]of [['exec','run_command'],['mcp','mcp__probe_noop']]){const r=await post(s,'/chat/completions',{tools,messages:[{role:'user',content:`__probe_${kind}__`} ]});assert.equal(r.choices[0].message.tool_calls[0].function.name,name);}}finally{s.close();}
});
test('invalid synthesized arguments are recorded instead of sent to the agent',async()=>{
  const s=await startMockLlm();try{const r=await post(s,'/chat/completions',{tools:[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string',pattern:'^/absolute/'}},required:['path']}}}],messages:[{role:'user',content:'__probe_read__'}]});assert.equal(r.choices[0].finish_reason,'stop');assert.equal(s.evidence.issuedCalls.length,0);assert.equal(s.evidence.skippedCalls.length,1);}finally{s.close();}
});
test('independent mock servers retain separate evidence',async()=>{
  const a=await startMockLlm(),b=await startMockLlm();try{await Promise.all([post(a,'/chat/completions',{tools,messages:[{role:'user',content:'__probe_read__'}]}),post(b,'/chat/completions',{tools,messages:[{role:'user',content:'__probe_write__'}]})]);assert.equal(a.evidence.issuedCalls[0].name,'read_file');assert.equal(b.evidence.issuedCalls[0].name,'write_file');assert.equal(a.evidence.requests,1);assert.equal(b.evidence.requests,1);}finally{a.close();b.close();}
});
test('Anthropic tool-result user messages do not reset the current turn',async()=>{
  const s=await startMockLlm();try{const r=await post(s,'/messages',{tools:tools.map(t=>({name:t.function.name,input_schema:t.function.parameters})),messages:[{role:'user',content:[{type:'text',text:'__probe_read__'}]},{role:'assistant',content:[{type:'tool_use',id:'t',name:'read_file',input:{path:'x'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'t',content:'CANARY-7729'}]}]});assert.equal(r.stop_reason,'end_turn');assert.equal(s.evidence.issuedCalls.length,0);}finally{s.close();}
});
test('tool call identifiers remain unique across independent turns',async()=>{
  const s=await startMockLlm();try{const ids=[];for(const kind of ['read','write']){const r=await post(s,'/chat/completions',{tools,messages:[{role:'user',content:`__probe_${kind}__`}]});ids.push(r.choices[0].message.tool_calls[0].id);}assert.notEqual(ids[0],ids[1]);}finally{s.close();}
});
test('plan stimulus builds a nonempty schema-valid todo list with declared enums',async()=>{
  const s=await startMockLlm();
  const todo = {
    type:'object', required:['id','content','status','priority'],
    properties:{id:{type:'string'},content:{type:'string'},status:{enum:['pending','completed']},priority:{enum:['medium','high']}},
  };
  const tools=[{type:'function',function:{name:'todowrite',parameters:{
    type:'object', required:['todos'], properties:{todos:{type:'array',minItems:1,items:todo}},
  }}}];
  try{const r=await post(s,'/chat/completions',{tools,messages:[{role:'user',content:'__probe_plan__'}]});const call=r.choices[0].message.tool_calls[0];const args=JSON.parse(call.function.arguments);assert.equal(args.todos.length,1);assert.equal(args.todos[0].status,'pending');assert.equal(args.todos[0].priority,'medium');assert.equal(s.evidence.issuedCalls.length,1);}finally{s.close();}
});
test('an offered MCP tool with required arguments is validated before issuing it',async()=>{
  const s=await startMockLlm();try{const r=await post(s,'/chat/completions',{tools:[{type:'function',function:{name:'probe_noop',parameters:{type:'object',properties:{mode:{const:'probe'}},required:['mode']}}}],messages:[{role:'user',content:'__probe_mcp__'}]});assert.deepEqual(JSON.parse(r.choices[0].message.tool_calls[0].function.arguments),{mode:'probe'});}finally{s.close();}
});
