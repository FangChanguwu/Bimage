import {test} from 'node:test';import assert from 'node:assert/strict';import {resolveChoice} from '../frontend/src/defaults.ts';
test('stale saved form falls back to explicit accessible default before singleton',()=>{const p={id:'a',models:[{id:'i',types:['image']}]};assert.deepEqual(resolveChoice([p,{...p,id:'b'}],'image','gone','x',{providerId:'b',model:'i'}),{providerId:'b',model:'i'});});
