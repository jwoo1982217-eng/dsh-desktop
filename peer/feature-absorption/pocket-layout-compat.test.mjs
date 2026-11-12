import test from 'node:test';
import assert from 'node:assert/strict';
import {htmlWithPocketLayout,acquire,css} from './pocket-layout-compat.mjs';
test('injects once and limits the adapter to new Pocket mobile frames',()=>{
 const page='<html><head></head><body>fixture</body></html>',once=htmlWithPocketLayout(page);
 assert.equal(htmlWithPocketLayout(once),once);assert.ok(once.includes('dsh-pocket-layout-compat'));
 assert.ok(css.includes('body[data-dsh-pocket-layout="mobile"]'));assert.ok(css.includes(':has(>[class$="_drawerMask"])'));assert.ok(css.includes('>[class$="_centerCol"]{grid-column:1'));
});
test('two independent lifecycle owners share the tap and release only their own lease',()=>{
 let active=0,released=0,assets=0;const web={register(route){assert.equal(route.kind,"exact");assert.ok(route.path.endsWith("pocket-model-catalog-budget.js"));assets++;return()=>{assets--}},tapIndex(fn){active++;assert.equal(fn,htmlWithPocketLayout);return()=>{active--;released++}}};
 const a=acquire(web),b=acquire(web);assert.equal(active,1);a();assert.equal(active,1);b();assert.equal(active,0);assert.equal(released,1);
 const c=acquire(web);assert.equal(active,1);c();assert.equal(released,2);
});

test('rewrites only the known budget asset and stays idempotent',()=>{
 const html='<html><head><script src="/phone-features/settings/model-catalog-budget.js"></script></head></html>';
 const rewritten=htmlWithPocketLayout(html);assert.ok(rewritten.includes('src="/phone-features/settings/pocket-model-catalog-budget.js"'));assert.equal(htmlWithPocketLayout(rewritten),rewritten);
});
