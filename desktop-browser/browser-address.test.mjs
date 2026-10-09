import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteAddress } from './browser-engine.mjs';

test('website addresses accept explicit URLs, bare domains and local development ports', () => {
  for (const [input, expected] of [
    [' https://example.com/path?q=1 ', 'https://example.com/path?q=1'],
    ['example.com', 'https://example.com/'],
    ['example.com:8443/path', 'https://example.com:8443/path'],
    ['localhost:3080', 'http://localhost:3080/'],
    ['127.0.0.1:3080/', 'http://127.0.0.1:3080/'],
    ['[::1]:3080', 'http://[::1]:3080/'],
    ['https://localhost:3080', 'https://localhost:3080/'],
  ]) assert.equal(websiteAddress(input), expected);
});

test('unsupported protocols, invalid URLs and embedded credentials are rejected', () => {
  for (const input of ['', 'not a URL', 'https://', 'localhost:99999', 'javascript:1234', 'javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'ftp://example.com', 'https://user:password@example.com/']) assert.throws(() => websiteAddress(input));
});
