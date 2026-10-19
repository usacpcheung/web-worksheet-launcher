import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createServerApiClient } from './server-api-client.js';
import { runDeletionFlow } from './deletion-flow.js';
import { runUploadRecoveryFlow } from './upload-recovery-flow.js';

// Use the actual API parser and a local HTTP socket, not a successful mock
// deletion, to check the acceptance report's interrupted-forwarding boundary.
for (const resource of ['worksheet-draft', 'roleplayscene-draft']) {
  for (const outcome of ['confirmed', 'lost-response', 'partial-response', 'rejected', 'refresh-failed']) {
    test(`${resource}: ${outcome} deletion controls slot continuation`, async t => {
      let deletes = 0, uploads = 0, committed = false, deletion;
      const server = createServer((req, res) => {
        assert.equal(req.method, 'DELETE'); deletes++;
        if (outcome === 'rejected') {
          res.writeHead(403, {'content-type':'application/json'});
          res.end(JSON.stringify({ok:false,error:{code:'FORBIDDEN'}})); return;
        }
        committed = true;
        if (outcome === 'lost-response') { req.socket.destroy(); return; }
        if (outcome === 'partial-response') {
          res.writeHead(200, {'content-type':'application/json','content-length':'200'});
          res.write('{"ok":'); setImmediate(()=>res.destroy()); return;
        }
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({ok:true,data:{deleted:true}}));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));});
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', (path, options) => fetch(new URL(path, `http://127.0.0.1:${server.address().port}`), options));
      const client = createServerApiClient();
      const result = await runUploadRecoveryFlow({ resource,
        submit:async()=>++uploads === 1 ? {ok:false,error:{code:resource === 'worksheet-draft'?'DRAFT_SLOT_LIMIT_REACHED':'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED'}} : {ok:true},
        recoverSlots:async()=>{
          deletion = await runDeletionFlow({pending:new Set(),key:'qa-fixture',confirm:async()=>true,
            remove:()=>resource === 'worksheet-draft'?client.deleteUploadedDraft('qa-fixture'):client.deleteRolePlaySceneDraft('qa-fixture'),
            refresh:async()=>outcome === 'refresh-failed'?{ok:false,error:{code:'NETWORK_ERROR'}}:{ok:true},
          });
          return {deleted:deletion.ok};
        },
      });
      const confirmed = ['confirmed','refresh-failed'].includes(outcome);
      assert.equal(deletes,1,'transport must not repeat DELETE');
      assert.equal(committed,outcome !== 'rejected');
      assert.equal(uploads,confirmed?2:1,'only confirmed deletion permits a new upload');
      assert.equal(result.status,confirmed?'completed':'canceled');
      assert.equal(deletion.deletionStatus,confirmed?'confirmed':outcome === 'rejected'?'rejected':'uncertain');
      if (outcome === 'refresh-failed') assert.equal(deletion.refreshStatus,'failed');
      if (['lost-response','partial-response'].includes(outcome)) assert.equal(deletion.error.code,'DELETE_OUTCOME_UNCERTAIN');
    });
  }
}
