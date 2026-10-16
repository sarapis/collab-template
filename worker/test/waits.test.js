import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredGroups, groupName, openByGroup, waitsOn, waitsOnAny } from '../src/waits.js';

// Who a question waits on (v1.11.0): `to=` when it has it, else its audience, so a
// site that never writes `to=` reads exactly as before.

test('without to=, a question waits on its audience, as it always did', () => {
  assert.deepEqual(waitsOn({ audience: 'sarapis' }), ['sarapis']);
  assert.deepEqual(waitsOn({ audience: 'sarapis', to: [] }), ['sarapis']);
});

test('with to=, it waits on its addressees and not its audience', () => {
  const q = { audience: 'public', to: ['platform-team', 'ana'] };
  assert.deepEqual(waitsOn(q), ['platform-team', 'ana']);
  assert.equal(waitsOnAny(q, ['ana']), true);
  assert.equal(waitsOnAny(q, ['public']), false);
});

test('a group is named from the addressees, then the audiences, then its key', () => {
  const m = { audiences: { public: { name: 'Anyone' }, x: { name: 'Audience X' } }, addressees: { x: { name: 'Addressee X' } } };
  assert.equal(groupName(m, 'x'), 'Addressee X');
  assert.equal(groupName(m, 'public'), 'Anyone');
  assert.equal(groupName(m, 'nobody'), 'nobody');
});

test('the People page offers audiences and addressees, each once, in order', () => {
  const m = { audiences: { public: { name: 'Anyone' }, team: { name: 'Team' } },
              addressees: { team: { name: 'Team (addressee)' }, ana: { name: 'Ana' } } };
  assert.deepEqual(declaredGroups(m).map((g) => g.id), ['public', 'team', 'ana']);
});

test('open questions are counted per group they wait on', () => {
  const qs = [{ audience: 'a' }, { audience: 'public', to: ['a', 'b'] }, { audience: 'a', resolved: '#x' }, { audience: 'c', hidden: true }];
  assert.deepEqual(openByGroup(qs), [{ audience: 'a', count: 2 }, { audience: 'b', count: 1 }]);
});
