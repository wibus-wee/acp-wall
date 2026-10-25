import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClientStubs } from '../dist/src/stubs.js';
const calls=()=>({fsReads:[],fsWrites:[],terminalCreates:[],terminalCalls:[],permissionRequests:[],elicitations:[],mcpRelayCalls:[],elicitationCompletes:[]});
test('a rejected file request does not count as a successful client interaction',async()=>{const c=calls(),stub=makeClientStubs(c);await assert.rejects(stub('fs/read_text_file',{path:'relative.txt'}));assert.equal(c.fsReads.length,0);await stub('fs/read_text_file',{path:'/tmp/file'});assert.equal(c.fsReads.length,1);});
test('permission requests without allow_once receive a valid cancellation',async()=>{const stub=makeClientStubs(calls());assert.deepEqual(await stub('session/request_permission',{options:[]}),{outcome:{outcome:'cancelled'}});});
test('terminal lifecycle rejects unknown, cross-session and released handles',async()=>{
  const c=calls(),stub=makeClientStubs(c);
  const {terminalId}=await stub('terminal/create',{sessionId:'s',command:'echo'});
  await assert.rejects(stub('terminal/wait_for_exit',{sessionId:'other',terminalId}));
  assert.equal(c.terminalCalls.length,0);
  await stub('terminal/output',{sessionId:'s',terminalId});
  await stub('terminal/release',{sessionId:'s',terminalId});
  await assert.rejects(stub('terminal/output',{sessionId:'s',terminalId}));
  assert.equal(c.terminalCalls.length,2);
});
