import {test} from 'node:test';import assert from 'node:assert/strict';
import {resolveChoice} from '../frontend/src/defaults.ts';
const p={id:'one',models:[{id:'img',types:['image']},{id:'txt',types:['text']}]};
test('singleton uses applicable catalog models and removes stale selections',()=>{assert.deepEqual(resolveChoice([p],'image','old','gone'),{providerId:'one',model:'img'});assert.deepEqual(resolveChoice([p],'text'),{providerId:'one',model:'txt'});assert.deepEqual(resolveChoice([{...p,models:[]}],'image'),{providerId:'one',model:''});});
test('explicit valid default wins; multiple providers do not invent a default',()=>{assert.deepEqual(resolveChoice([p,{...p,id:'two'}],'image','two','img'),{providerId:'two',model:'img'});assert.deepEqual(resolveChoice([p,{...p,id:'two'}],'image'),{providerId:'',model:''});});
