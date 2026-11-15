// Profile photos: only real JPEGs, size limit, old file deleted on change,
// and removal (by the person or the owner).
const test = require('node:test');
const assert = require('node:assert');
const { makePhotos } = require('../photos');
const { makeFakeSupabase } = require('./fakeSupabase');

const jpeg = (n = 1000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n), Buffer.from([0xff, 0xd9])]);

test('upload, replace and remove a photo', async () => {
  const db = { users: [{ user_id: 'ana', photo_url: null }] };
  const supabase = makeFakeSupabase(db);
  const photos = makePhotos({ supabase });
  const bucket = () => supabase.storage._files['profile-photos'];

  assert.strictEqual((await photos.upload('ana', 'aGVsbG8=')).status, 400, 'not a JPEG');
  assert.strictEqual((await photos.upload('ana', jpeg(700 * 1024).toString('base64'))).status, 400, 'too big');

  const first = await photos.upload('ana', jpeg().toString('base64'));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(photos.photoOf('ana'), first.photoUrl);
  assert.strictEqual(db.users[0].photo_url, first.photoUrl);
  assert.strictEqual(bucket().size, 1);

  const second = await photos.upload('ana', 'data:image/jpeg;base64,' + jpeg(2000).toString('base64'));
  assert.strictEqual(second.status, 200);
  assert.notStrictEqual(second.photoUrl, first.photoUrl);
  assert.strictEqual(bucket().size, 1, 'old file deleted');

  await photos.remove('ana');
  assert.strictEqual(photos.photoOf('ana'), null);
  assert.strictEqual(db.users[0].photo_url, null);
  assert.strictEqual(bucket().size, 0);
});
