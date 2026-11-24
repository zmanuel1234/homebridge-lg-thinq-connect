import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayName, keepOrUpdate, titleCase } from '../src/names';

test('names: what the tile is, in title case, after the appliance\'s own name', () => {
  assert.equal(titleCase('rinse aid low'), 'Rinse Aid Low');
  assert.equal(titleCase('UV nano'), 'UV Nano');
  assert.equal(displayName('Front Load Washer', 'Front Load Washer remote start'), 'Front Load Washer Remote Start');
  assert.equal(displayName('my washer', 'my washer done'), 'my washer Done', 'the ThinQ name stays as it is');
  assert.equal(displayName('Washer', 'Washer'), 'Washer');
});

test('names: a name changed in the Home app is kept; only our old lower-case default is updated', () => {
  assert.equal(keepOrUpdate(undefined, 'Washer Done'), 'Washer Done', 'first use');
  assert.equal(keepOrUpdate('', 'Washer Done'), 'Washer Done');
  assert.equal(keepOrUpdate('Washer done', 'Washer Done'), 'Washer Done', '1.0.x default brought up to date');
  assert.equal(keepOrUpdate('Laundry finished', 'Washer Done'), undefined, 'renamed in the Home app: kept');
  assert.equal(keepOrUpdate('Washer Done', 'Washer Done'), undefined, 'already right');
});
