import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPS, rankingFromMethods, wallRow } from '../../tools/ranking.mjs';

test('the original league table keeps its 24 columns and ranking thresholds',()=>{
  assert.equal(CAPS.length,24);assert.equal(CAPS.includes('prompt:content'),false);
  const r=rankingFromMethods({initialize:{status:'pass'}});
  assert.equal(r.cells.length,24);assert.equal(r.score,4);assert.equal(r.tier,'limited');
});
test('mixed groups retain verified submethods without claiming complete support',()=>{
  const r=rankingFromMethods({'session/list':{status:'pass'},'session/resume':{status:'pass'},'session/close':{status:'pass'},'session/delete':{status:'na',reason:'not-advertised'}});
  assert.equal(r.cells[CAPS.indexOf('sessions/*')],2);
  assert.match(r.notes['sessions/*'],/session\/list: Verified/);
  assert.match(r.notes['sessions/*'],/session\/delete: Unobserved/);
});
test('blocked and diagnostic-only results never become successful ranked cells',()=>{
  const r=rankingFromMethods({initialize:{status:'blocked'},'mcp:stdio':{status:'observed'},'mcp:http':{status:'na'},'mcp:sse':{status:'error'}});
  assert.equal(r.score,0);assert.equal(r.cells[CAPS.indexOf('mcp')],-1);
});
test('historical ranks and fresh evidence both retain the original page data contract',()=>{
  const historical=wallRow({score:63,tier:'verified',cells:[1,2],notes:{initialize:'earlier run'}});
  assert.equal(historical.score,63);assert.equal(historical.cells.length,24);
  const row=wallRow({methods:{initialize:{status:'pass'}},claimMismatches:[],transport:{mitm:{impersonated:['example.test']}}},{run:'agent acp'});
  assert.equal(row.score,4);assert.equal(row.run,'agent acp');assert.deepEqual(row.mitm,['example.test']);assert.deepEqual(row.dishonesty,[]);
});
