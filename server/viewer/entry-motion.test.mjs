import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealProgress } from './entry-motion.js';
test('entry settles fifteen percent before the reading line in either direction',()=>{
 const v={top:0,bottom:1000,line:450};
 assert.equal(revealProgress({top:1000,bottom:1100},v,'bottom'),0);
 assert.equal(revealProgress({top:600,bottom:700},v,'bottom'),1);
 assert.equal(revealProgress({top:650,bottom:750},v,'bottom')<1,true);
 assert.equal(revealProgress({top:150,bottom:300},v,'top'),1);
 assert.equal(revealProgress({top:-100,bottom:0},v,'top'),0);
});
