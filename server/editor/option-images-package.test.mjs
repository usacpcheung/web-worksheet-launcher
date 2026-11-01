import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorksheetPackageFromDraft, parseWorksheetPackage } from './worksheet-package.js';
import { createStoredZip, parseStoredZip, decodeUtf8 } from './zip-utils.js';
import { assertAttemptPackage } from '../app/contracts/attempt-package-validator.js';
const draft = () => ({ title: 'Images', blocks: [{ blockId: 'q', kind: 'question', position: 0, prompt: { text: 'Choose', format: 'plain_text' }, responseConfig: { inputType: 'multiple_choice', correctAnswer: 'o1', options: [{ id: 'o1', value: 'o1', label: '', imageDescription: '三角形', mediaRefs: [{ usage: 'option_image', assetId: 'img' }] }, { id: 'o2', value: 'text', label: 'Text' }] } }], assets: [{ assetId: 'img', kind: 'image', usage: 'option_image', mimeType: 'image/png', path: 'media/img.png' }] });
const binaries = new Map([['img', { binary: new Uint8Array([1,2,3]) }]]);
test('image-only worksheet roundtrip retains identity, descriptions and image asset usage', () => {
 const result=createWorksheetPackageFromDraft(draft(),binaries);assert.equal(result.manifest.packageVersion,4);
 const parsed=parseWorksheetPackage(result.bytes);assert.deepEqual(parsed.worksheet.blocks[0].responseConfig,result.worksheet.blocks[0].responseConfig);assert.equal(parsed.assets[0].usage,'option_image');
 const plain=draft();plain.blocks[0].responseConfig.options=[{value:'text',label:'Text'}];assert.equal(createWorksheetPackageFromDraft(plain,binaries).manifest.packageVersion,2);
});
test('image packages reject missing/invalid assets, duplicate identities, oversized descriptions and downgraded envelopes', () => {
 assert.throws(()=>createWorksheetPackageFromDraft(draft(),new Map()),/Missing or invalid/);
 for(const change of [d=>d.assets[0].mimeType='image/svg+xml',d=>d.blocks[0].responseConfig.options[0].imageDescription='x'.repeat(201),d=>d.blocks[0].responseConfig.options[1].value='o1',d=>d.blocks[0].responseConfig.options[1].label='']){
  const d=draft();change(d);assert.throws(()=>createWorksheetPackageFromDraft(d,binaries));
 }
 const pkg=createWorksheetPackageFromDraft(draft(),binaries);const files=parseStoredZip(pkg.bytes);const m=JSON.parse(decodeUtf8(files.get('manifest.json')));m.packageVersion=2;m.schemaVersion=2;files.set('manifest.json',JSON.stringify(m));assert.throws(()=>parseWorksheetPackage(createStoredZip([...files].map(([path,data])=>({path,data})))),/version 4/);
});
test('attempts explicitly version image options and validate their asset references',()=>{
 const d=draft();const m={format:'worksheet-attempt-package',packageVersion:3,schemaVersion:1,assets:d.assets};const a={schemaVersion:1,kind:'worksheet-attempt',status:'in_progress',answers:{q:{value:'o1'}}};
 assert.doesNotThrow(()=>assertAttemptPackage(m,d,a));assert.throws(()=>assertAttemptPackage(m,d,a,{files:new Map()}),/Missing or empty package asset file/);assert.doesNotThrow(()=>assertAttemptPackage(m,d,a,{files:new Map([['media/img.png',new Uint8Array([1,2,3])]])}));assert.throws(()=>assertAttemptPackage({...m,packageVersion:2},d,a),/version 3/);assert.throws(()=>assertAttemptPackage({...m,assets:[]},d,a),/Missing or invalid/);
});

test('worksheet creation and both readers reject empty option image files', () => {
  assert.throws(() => createWorksheetPackageFromDraft(draft(), new Map([['img', { binary: new Uint8Array() }]])), /empty|byteLength/);
  const pkg = createWorksheetPackageFromDraft(draft(), binaries);
  const files = parseStoredZip(pkg.bytes);
  const manifest = JSON.parse(decodeUtf8(files.get('manifest.json')));
  delete manifest.assets[0].byteLength; delete manifest.assets[0].crc32;
  files.set('media/img.png', new Uint8Array()); files.set('manifest.json', JSON.stringify(manifest));
  assert.throws(() => parseWorksheetPackage(createStoredZip([...files].map(([path, data]) => ({ path, data })))), /empty/);
  assert.throws(() => assertAttemptPackage({ ...manifest, format: 'worksheet-attempt-package', packageVersion: 3, schemaVersion: 1 }, pkg.worksheet, {}, { allowLegacyEnvelope: true, files }), /empty/);
});

test('worksheet and attempt readers reject ambiguous or non-media manifests before import', () => {
  for (const mutate of [
    assets => { assets[0].path = 'pictures/image.png'; },
    assets => { assets.push({ ...assets[0], path: 'media/other.png' }); },
    assets => { assets.push({ ...assets[0], assetId: 'other' }); },
  ]) {
    const pkg = createWorksheetPackageFromDraft(draft(), binaries);
    const files = parseStoredZip(pkg.bytes), manifest = structuredClone(pkg.manifest);
    mutate(manifest.assets);
    for (const asset of manifest.assets) files.set(asset.path, new Uint8Array([1,2,3]));
    files.set('manifest.json', JSON.stringify(manifest));
    assert.throws(() => parseWorksheetPackage(createStoredZip([...files].map(([path,data]) => ({path,data})))), /path|assetId/);
    const attemptManifest = { ...manifest, format: 'worksheet-attempt-package', packageVersion: 3, schemaVersion: 1 };
    for (const allowLegacyEnvelope of [true, false]) assert.throws(() => assertAttemptPackage(attemptManifest, pkg.worksheet, {}, { files, allowLegacyEnvelope }), /path|assetId/);
  }
});
