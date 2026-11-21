const test = require('node:test');
const assert = require('node:assert');
const { nearFrom } = require('../near');

const req = (headers = {}, query = {}) => ({ headers, query, get: n => headers[n.toLowerCase()] });

test('location comes from the header', () => {
  assert.deepStrictEqual(nearFrom(req({ 'x-foursome-near': '9.93,-84.08' })), { lat: 9.93, lng: -84.08 });
});
test('older apps: location from ?lat=&lng=', () => {
  assert.deepStrictEqual(nearFrom(req({}, { lat: '9.93', lng: '-84.08' })), { lat: 9.93, lng: -84.08 });
});
test('header wins over the query', () => {
  assert.deepStrictEqual(nearFrom(req({ 'x-foursome-near': '1,2' }, { lat: '3', lng: '4' })), { lat: 1, lng: 2 });
});
test('missing or invalid location is null', () => {
  assert.strictEqual(nearFrom(req()), null);
  assert.strictEqual(nearFrom(req({ 'x-foursome-near': 'abc' })), null);
  assert.strictEqual(nearFrom(req({ 'x-foursome-near': '95,10' })), null);
});
