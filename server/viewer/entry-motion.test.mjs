import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealProgress } from './entry-motion.js';
test('entry settles ten percent before the reading line in either direction',()=>{
 const v={top:0,bottom:1000,line:450};
 assert.equal(revealProgress({top:1000,bottom:1100},v,'bottom'),0);
 assert.equal(revealProgress({top:550,bottom:650},v,'bottom'),1);
 assert.equal(revealProgress({top:600,bottom:700},v,'bottom')<1,true);
 assert.equal(revealProgress({top:200,bottom:350},v,'top'),1);
 assert.equal(revealProgress({top:-100,bottom:0},v,'top'),0);
});

test('completion uses the usable viewport offset and height',()=>{
 const v={top:100,bottom:900,line:460};
 assert.equal(revealProgress({top:540,bottom:640},v,'bottom'),1);
 assert.ok(revealProgress({top:580,bottom:680},v,'bottom')<1);
 assert.equal(revealProgress({top:280,bottom:380},v,'top'),1);
 assert.ok(revealProgress({top:240,bottom:340},v,'top')<1);
});
