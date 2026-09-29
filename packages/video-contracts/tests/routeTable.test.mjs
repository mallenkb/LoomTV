/**
 * Binds the frozen canonical route table to the surface the server actually publishes.
 *
 * Clients are only allowed to call `active` routes, and every client in this repository
 * derives its call list from `CANONICAL_ROUTES`. If a route is marked active here but no
 * handler publishes it, every client believes in a route that returns 404; if a route is
 * still `reserved` after its handler lands, clients refuse to use a feature that works.
 * Either drift is silent without this check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_ROLES,
  CANONICAL_API_PREFIX,
  CANONICAL_ROUTES,
  LEGACY_ROUTE_ADAPTERS,
  PROFILE_KINDS,
  canonicalRoute,
} from '../src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicApiPath = path.resolve(here, '..', '..', '..', 'apps', 'server', 'src', 'public-api.js');
const publicApiSource = fs.readFileSync(publicApiPath, 'utf8');

/** The `paths` map of the OpenAPI document the server serves at `/api/v1/openapi.json`. */
function publishedOperations() {
  const start = publicApiSource.indexOf('  paths: {');
  assert.ok(start > 0, 'public-api.js must declare an OpenAPI paths map');
  const operations = new Set();
  for (const line of publicApiSource.slice(start).split('\n')) {
    const route = /^\s*'(\/api\/v1\/[^']*)':/.exec(line);
    if (!route) {
      if (/^\s*},\s*$/.test(line) && operations.size > 0) break;
      continue;
    }
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (new RegExp(`\\b${method}:\\s*\\{`).test(line)) operations.add(`${method.toUpperCase()} ${route[1]}`);
    }
  }
  return operations;
}

test('every route record is well formed', () => {
  const ids = new Set();
  for (const route of CANONICAL_ROUTES) {
    assert.ok(!ids.has(route.id), `duplicate route id ${route.id}`);
    ids.add(route.id);
    assert.ok(route.path.startsWith(CANONICAL_API_PREFIX), `${route.id} must live under ${CANONICAL_API_PREFIX}`);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method), `${route.id} has an unknown method`);
    assert.ok(['active', 'reserved'].includes(route.state), `${route.id} has an unknown state`);
    assert.ok(
      ['public', 'bootstrap', 'account', 'profile', 'capability', 'owner'].includes(route.access),
      `${route.id} has an unknown access class`,
    );
    assert.equal(canonicalRoute(route.id), route);
  }
});

test('every active canonical route is published by the server', () => {
  const published = publishedOperations();
  const missing = CANONICAL_ROUTES
    .filter((route) => route.state === 'active')
    .map((route) => `${route.method} ${route.path}`)
    .filter((operation) => !published.has(operation));
  assert.deepEqual(missing, [], 'active routes with no published operation');
});

test('no reserved route is published as if it were shipped', () => {
  const published = publishedOperations();
  const leaked = CANONICAL_ROUTES
    .filter((route) => route.state === 'reserved')
    .map((route) => `${route.method} ${route.path}`)
    .filter((operation) => published.has(operation));
  assert.deepEqual(leaked, [], 'reserved routes that the server already advertises');
});

test('every legacy adapter names a destination and a removal condition', () => {
  for (const adapter of LEGACY_ROUTE_ADAPTERS) {
    assert.ok(adapter.source.length > 0);
    assert.ok(adapter.destination.length > 0, `${adapter.source} needs a destination`);
    assert.ok(adapter.removal.length > 0, `${adapter.source} needs a removal condition`);
  }
});

test('the canonical vocabularies are the ones clients are told to use', () => {
  assert.deepEqual([...ACCOUNT_ROLES], ['owner', 'admin', 'user', 'viewer']);
  assert.deepEqual([...PROFILE_KINDS], ['adult', 'child', 'guest']);
});
