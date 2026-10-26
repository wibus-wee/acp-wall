import test from 'node:test';
import assert from 'node:assert/strict';
import { schema } from '../dist/src/schema.js';

test('oneOf rejects overlapping successful branches', () => {
  assert.ok(schema.validate(3, { oneOf: [{ type: 'number' }, { type: 'integer' }] }).length);
});
test('boolean false and unresolved references fail closed', () => {
  assert.ok(schema.validate('anything', false).length);
  assert.ok(schema.validate({}, { $ref: '#/$defs/does-not-exist' }).length);
});
test('string length and structural enum constraints are enforced', () => {
  assert.ok(schema.validate('', { type: 'string', minLength: 1 }).length);
  assert.equal(schema.validate({ a: 1 }, { enum: [{ a: 1 }] }).length, 0);
});
test('tool argument schemas honor their declared Draft 7 dialect', () => {
  const tool={$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{path:{type:'string',minLength:1}},required:['path']};
  assert.deepEqual(schema.validate({path:'canary'},tool),[]);
  assert.ok(schema.validate({path:''},tool).length);
});
test('tool schemas support declared 2019-09 without changing pinned ACP validation', () => {
  const tool={$schema:'https://json-schema.org/draft/2019-09/schema',type:'object',properties:{x:{type:'string'}},dependentRequired:{x:['y']}};
  assert.ok(schema.validate({x:'x'},tool).length);assert.deepEqual(schema.validate({x:'x',y:1},tool),[]);
  assert.ok(schema.validate({},'InitializeRequest').length);
});
test('independent tools may reuse an id without sharing compiled constraints', () => {
  const a={$schema:'http://json-schema.org/draft-07/schema#',$id:'https://example.com/tool',type:'string'};
  const b={...a,type:'number'};
  assert.deepEqual(schema.validate('ok',a),[]);assert.deepEqual(schema.validate(3,b),[]);assert.ok(schema.validate('no',b).length);
});
