import test from 'node:test';
import assert from 'node:assert/strict';
import { createPollingRegistry } from '../src/actions/polling.js';
import { createManagedCache, createCacheRegistry } from '../src/actions/cache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('轮询：降级按 factor 拉长间隔，恢复后还原', async () => {
  const registry = createPollingRegistry();
  let count = 0;
  const handle = registry.register(async () => {
    count += 1;
  }, 30);

  await sleep(120);
  const baseCount = count;
  assert.ok(baseCount >= 2, `基线应有多次轮询，实际 ${baseCount}`);

  registry.apply(4); // 降级：间隔 ×4 => 120ms
  assert.equal(handle.interval, 120);
  await sleep(200);
  const duringDegraded = count;
  await sleep(140);
  const slowedTicks = count - duringDegraded;
  assert.ok(slowedTicks <= 1, `降级后 140ms 内至多再跑 1 次，实际 ${slowedTicks}`);

  registry.apply(1); // 恢复
  assert.equal(handle.interval, 30);
  handle.unregister();
});

test('缓存：LRU 语义 + trim 释放最旧一半 + purge 全清', () => {
  const cache = createManagedCache('t', { maxEntries: 4 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a'); // a 变最新
  cache.set('d', 4);
  cache.set('e', 5); // 超出上限，淘汰最旧的 b
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.size, 4);

  const removed = cache.trim(0.5);
  assert.equal(removed.length, 2);
  assert.equal(cache.size, 2);

  const purged = cache.purge();
  assert.equal(purged, 2);
  assert.equal(cache.size, 0);
});

test('缓存集合：级别动作 trim/purge 自动广播释放事件', () => {
  const registry = createCacheRegistry();
  const cache = createManagedCache('x');
  for (let i = 0; i < 10; i += 1) cache.set(`k${i}`, i);
  registry.register(cache);

  const events = [];
  registry.onRelease((e) => events.push(e));

  registry.apply('trim');
  assert.equal(cache.size, 5);
  assert.equal(events[0].released[0].count, 5);

  registry.apply('purge');
  assert.equal(cache.size, 0);
  assert.equal(events.length, 2);

  // keep 不产生释放事件
  registry.apply('keep');
  assert.equal(events.length, 2);
});
