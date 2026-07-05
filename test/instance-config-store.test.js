import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstanceConfigStore } from '../src/lib/instance-config-store.js';

test('InstanceConfigStore.fromObject accepts a valid config', () => {
  const store = InstanceConfigStore.fromObject({
    instances: {
      acme: {
        subdomain: 'acme',
        email: 'a@b.com',
        token: 't',
        env: 'prod',
      },
    },
  });
  assert.equal(store.listInstances().length, 1);
  assert.equal(store.getInstance('acme').env, 'prod');
});

test('InstanceConfigStore rejects malformed root', () => {
  assert.throws(() => InstanceConfigStore.fromObject(null), /must be an object/);
  assert.throws(() => InstanceConfigStore.fromObject([]), /must be an object/);
  assert.throws(
    () => InstanceConfigStore.fromObject({}),
    /"instances" must be an object/,
  );
});

test('InstanceConfigStore rejects missing required fields', () => {
  assert.throws(
    () =>
      InstanceConfigStore.fromObject({
        instances: { x: { subdomain: 'x', email: 'a@b' } }, // no token
      }),
    /missing required field "token"/,
  );
});

test('InstanceConfigStore normalizes env case and rejects invalid env', () => {
  const store = InstanceConfigStore.fromObject({
    instances: {
      x: { subdomain: 's', email: 'e', token: 't', env: 'PROD' },
    },
  });
  assert.equal(store.getInstance('x').env, 'prod');

  assert.throws(
    () =>
      InstanceConfigStore.fromObject({
        instances: { x: { subdomain: 's', email: 'e', token: 't', env: 'staging' } },
      }),
    /env must be "prod" or "sandbox"/,
  );
});

test('InstanceConfigStore defaults env to prod when omitted', () => {
  const store = InstanceConfigStore.fromObject({
    instances: { x: { subdomain: 's', email: 'e', token: 't' } },
  });
  assert.equal(store.getInstance('x').env, 'prod');
});

test('InstanceConfigStore.getInstance returns null on unknown', () => {
  const store = InstanceConfigStore.fromObject({
    instances: { x: { subdomain: 's', email: 'e', token: 't' } },
  });
  assert.equal(store.getInstance('nope'), null);
});

test('InstanceConfigStore.load uses fallback path when XDG missing', async () => {
  const dir = await mkdirTemp('icstore');
  const xdg = path.join(dir, 'xdg', 'instances.json');
  const fallback = path.join(dir, 'fallback', 'instances.json');
  await mkdir(path.dirname(fallback), { recursive: true });
  await writeFile(
    fallback,
    JSON.stringify({
      instances: { y: { subdomain: 's', email: 'e', token: 't', env: 'sandbox' } },
    }),
  );
  const store = await InstanceConfigStore.load({ paths: [xdg, fallback] });
  assert.equal(store.sourcePath, fallback);
  assert.equal(store.getInstance('y').env, 'sandbox');
  await rm(dir, { recursive: true, force: true });
});

test('InstanceConfigStore.load returns empty store when no file exists', async () => {
  const dir = await mkdirTemp('icstore');
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const store = await InstanceConfigStore.load({ paths: [a, b] });
  assert.equal(store.listInstances().length, 0);
  assert.equal(store.sourcePath, null);
  await rm(dir, { recursive: true, force: true });
});

test('InstanceConfigStore.load throws on malformed JSON', async () => {
  const dir = await mkdirTemp('icstore');
  const file = path.join(dir, 'bad.json');
  await writeFile(file, '{not json');
  await assert.rejects(
    () => InstanceConfigStore.load({ paths: [file] }),
    /failed to parse/,
  );
  await rm(dir, { recursive: true, force: true });
});

async function mkdirTemp(prefix) {
  const dir = path.join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}
