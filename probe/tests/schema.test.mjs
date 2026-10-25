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
