import test from 'node:test';
import assert from 'node:assert/strict';
import { PackageLoadProgress, packageLoadLabel } from './package-load-progress.js';

test('load progress uses real percentages and drops unavailable or inconsistent totals', () => {
  const model = new PackageLoadProgress();
  const token = model.start('a');
  for (const [event, expected] of [
    [{loaded:42,total:100,lengthComputable:true},42],
    [{loaded:42,total:0,lengthComputable:false},null],
    [{loaded:101,total:100,lengthComputable:true},null],
    [{loaded:42,total:NaN,lengthComputable:true},null],
  ]) { model.update(token,'downloading',event); assert.equal(model.current.percent,expected); }
  model.update(token,'opening'); assert.equal(model.current.percent,null);
});

test('finished and superseded operations cannot change a newer load; unsubscribed views receive nothing', () => {
  const model = new PackageLoadProgress(); const events=[];
  const off=model.subscribe(value=>events.push(value?.stage));
  const old=model.start('a'); model.finish(old);
  const next=model.start('b'); off(); const count=events.length;
  model.update(old,'downloading',{loaded:99,total:100,lengthComputable:true});
  model.finish(old); assert.equal(model.current,next);
  model.update(next,'opening'); assert.equal(events.length,count);
});

test('announcements describe stages without announcing every percentage', () => {
  const t=(key,values)=>key+':'+values.percent;
  const progress={stage:'downloading',percent:42};
  assert.match(packageLoadLabel(progress,t),/downloadingPercent/);
  assert.doesNotMatch(packageLoadLabel(progress,t,{announce:true}),/downloadingPercent/);
});
