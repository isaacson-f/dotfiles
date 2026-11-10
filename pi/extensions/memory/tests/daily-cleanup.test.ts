import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config.ts';
import { mutateMemory, readTargetSnapshot, loadSnapshot } from '../store.ts';
import { GenerationFailure, runDailyCleanup } from '../daily-cleanup.ts';
import { runDailyMaintenance, type SummaryModel } from '../daily-summary.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'memory-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const pin = 'Prefer merge commits.';
  const config = parseConfig({enabled:true,vaultRoot:join(root,'vault'),injection:{pins:{user:[pin]}}});
  for (const entry of [pin, 'Prefer merges.', 'Job queued; CI pending.', 'Prefer direct implementation.']) {
    await mutateMemory(config, repo, 'user', 'add', entry);
  }
  return {root,repo,config,pin};
}
const model = (value: unknown): SummaryModel => ({complete:async()=>JSON.stringify(value)});
const plan = {remove:[{id:'2',reason:'duplicate',retained:['1']},{id:'3',reason:'transient',retained:[]}]};

test('one unattended run removes clutter, backs up exact source, indexes fresh content, and is repeatable', async t => {
  const x=await fixture(t);
  const before=await readTargetSnapshot(x.config,x.repo,'user');
  let cleanupCalls=0;
  const generator:SummaryModel={complete:async ({systemPrompt,text})=>{
    if(systemPrompt.startsWith('Clean durable memory')) {cleanupCalls++; return JSON.stringify(cleanupCalls===1?plan:{remove:[]});}
    const data=JSON.parse(text);
    assert.deepEqual(data.entries,[x.pin,'Prefer direct implementation.']);
    return JSON.stringify([{name:'Preferences',description:'Implementation preferences',keywords:['prefer']}]);
  }};
  const result=await runDailyMaintenance(x.config,generator);
  assert.equal(result.failed,0); assert.equal(result.removed,2); assert.equal(result.updated,1);
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'user')).entries,[x.pin,'Prefer direct implementation.']);
  const backupDir=join(x.config.vaultRoot,'memory','.cleanup-backups');
  const files=await readdir(backupDir); assert.equal(files.length,1);
  const backup=JSON.parse(await readFile(join(backupDir,files[0]!), 'utf8'));
  assert.equal(backup.serialized,before.serialized);
  assert.deepEqual(backup.pins,[x.pin]);
  assert.match((await loadSnapshot(x.config,x.repo)).text,/Preferences/);
  const again=await runDailyMaintenance(x.config,generator);
  assert.equal(again.removed,0); assert.equal(again.updated,0);
  assert.equal((await readdir(backupDir)).length,1);
});

// Each of these operations would lose pins, invent source IDs, or erase deduplication evidence: it is skipped alone.
for(const [name,remove] of [
  ['pin removal',[{id:'1',reason:'transient',retained:[]}]],
  ['unknown ID',[{id:'99',reason:'transient',retained:[]}]],
  ['unsupported reason',[{id:'2',reason:'bad',retained:[]}]],
  ['missing evidence',[{id:'2',reason:'duplicate',retained:[]}]],
  ['invalid source type',[{id:2,reason:'transient',retained:[]}]],
  ['unknown retained ID',[{id:'2',reason:'duplicate',retained:['secret-source-text']}]],
  ['self evidence',[{id:'2',reason:'duplicate',retained:['2']}]],
  ['invalid retained array',[{id:'2',reason:'duplicate',retained:'secret-source-text'}]],
] as const) {
  test(`skips ${name} without changing any source bytes`,async t=>{
    const x=await fixture(t); const before=await readTargetSnapshot(x.config,x.repo,'user');
    const result=await runDailyCleanup(x.config,model({remove}));
    assert.equal(result.failed,0);
    assert.equal((await readTargetSnapshot(x.config,x.repo,'user')).serialized,before.serialized);
    assert.deepEqual(result.messages,['user: cleanup unchanged; skipped 1 invalid operation']);
    assert.doesNotMatch(JSON.stringify(result),/secret-source-text/);
  });
}

test('one invalid operation does not discard the valid rest of the plan',async t=>{
  const x=await fixture(t);
  const result=await runDailyCleanup(x.config,model({remove:[
    {id:'1',reason:'transient',retained:[]},
    {id:'3',reason:'transient',retained:[]},
    {id:'2',reason:'duplicate',retained:['3']},
    {id:'3',reason:'transient',retained:[]},
  ]}));
  assert.equal(result.failed,0); assert.equal(result.removed,1);
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'user')).entries,[x.pin,'Prefer merges.','Prefer direct implementation.']);
  assert.match(result.messages[0]!,/; backup saved; skipped 3 invalid operations$/);
});

test('a removal citing a later-removed entry keeps its evidence',async t=>{
  const x=await fixture(t);
  await runDailyCleanup(x.config,model({remove:[{id:'2',reason:'duplicate',retained:['4']},{id:'4',reason:'transient',retained:[]}]}));
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'user')).entries,[x.pin,'Job queued; CI pending.','Prefer direct implementation.']);
});

for (const [raw,code] of [['{"secret-source-text":', 'invalid_json'], ['{"private":"secret-source-text"}', 'invalid_root_shape'], ['{"remove":null}', 'invalid_remove_array']] as const) {
  test(`reports ${code} without echoing model output`,async t=>{
    const x=await fixture(t); const before=await readTargetSnapshot(x.config,x.repo,'user');
    const result=await runDailyCleanup(x.config,{complete:async()=>raw});
    assert.deepEqual(result.messages,[`user: cleanup invalid_plan/${code}; source preserved`]);
    assert.equal((await readTargetSnapshot(x.config,x.repo,'user')).serialized,before.serialized);
  });
}

test('merges related entries into one compact entry at the first source position, with a backup',async t=>{
  const x=await fixture(t);
  const before=await readTargetSnapshot(x.config,x.repo,'user');
  const merged='Prefer merges and direct implementation.';
  const result=await runDailyCleanup(x.config,model({remove:[{id:'3',reason:'transient',retained:[]}],merge:[{sources:['2','4'],content:merged}]}));
  assert.equal(result.failed,0); assert.equal(result.removed,1); assert.equal(result.merged,2);
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'user')).entries,[x.pin,merged]);
  assert.match(result.messages[0]!,/^user: cleanup removed 1, merged 2 into 1; \d+->\d+ chars; backup saved$/);
  const backupDir=join(x.config.vaultRoot,'memory','.cleanup-backups');
  const backup=JSON.parse(await readFile(join(backupDir,(await readdir(backupDir))[0]!),'utf8'));
  assert.equal(backup.serialized,before.serialized);
  assert.deepEqual(backup.merge,[{sources:['2','4'],content:merged}]);
});

for(const [name,value] of [
  ['merging a pin',{merge:[{sources:['1','2'],content:'Prefer merges.'}]}],
  ['merging a removed entry',{merge:[{sources:['2','4'],content:'Short.'},{sources:['2','3'],content:'Other.'}]}],
  ['an invalid merge shape',{merge:[{sources:'2',content:'secret-source-text'}]}],
  ['merge content colliding with an entry',{merge:[{sources:['2','3'],content:'Prefer direct implementation.'}]}],
] as const) {
  test(`skips ${name}`,async t=>{
    const x=await fixture(t);
    const result=await runDailyCleanup(x.config,model(value));
    assert.equal(result.failed,0);
    assert.match(result.messages[0]!,/skipped 1 invalid operation$/);
    assert.doesNotMatch(JSON.stringify(result),/secret-source-text/);
  });
}

test('merges apply before removals, so a removal citing merged evidence is skipped',async t=>{
  const x=await fixture(t);
  await runDailyCleanup(x.config,model({remove:[{id:'3',reason:'duplicate',retained:['2']}],merge:[{sources:['2','4'],content:'Short.'}]}));
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'user')).entries,[x.pin,'Short.','Job queued; CI pending.']);
});

test('cleanup input reports usage against the limit so the model can size its consolidation',async t=>{
  const x=await fixture(t); let seen: any;
  await runDailyCleanup(x.config,{complete:async(input)=>{seen={...JSON.parse(input.text),input};return '{"remove":[]}';}});
  assert.equal(seen.limit,x.config.limits.user); assert.ok(seen.usage>0); assert.equal("maxTokens" in seen.input,false,"cleanup must not cap model output");
});

test('reports store-emptying rejection explicitly',async t=>{
  const x=await fixture(t);
  await mutateMemory(x.config,x.repo,'global','add','Job queued.');
  const result=await runDailyCleanup(x.config,{complete:async({text})=>JSON.stringify(JSON.parse(text).scope==='global'?{remove:[{id:'1',reason:'transient',retained:[]}]}:{remove:[]})});
  assert.ok(result.messages.includes('global: cleanup invalid_plan/would_empty_store; source preserved'));
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'global')).entries,['Job queued.']);
});

test('provider failure is redacted and preserves the store',async t=>{
  const x=await fixture(t); const before=await readTargetSnapshot(x.config,x.repo,'user');
  const result=await runDailyCleanup(x.config,{complete:async()=>{throw new Error('private source and secret');}});
  assert.equal(result.failed,1); assert.doesNotMatch(JSON.stringify(result),/private source|secret/);
  assert.equal((await readTargetSnapshot(x.config,x.repo,'user')).serialized,before.serialized);
});

test('allowlisted provider diagnostics identify generation failure without exposing provider details',async t=>{
  const x=await fixture(t); const before=await readTargetSnapshot(x.config,x.repo,'user');
  const result=await runDailyCleanup(x.config,{complete:async()=>{throw new GenerationFailure('provider_request_failed');}});
  assert.deepEqual(result.messages,['user: cleanup provider_request_failed; source preserved']);
  assert.equal((await readTargetSnapshot(x.config,x.repo,'user')).serialized,before.serialized);
});

test('concurrent writes are retained rather than overwritten by a stale cleanup plan',async t=>{
  const x=await fixture(t);
  const result=await runDailyCleanup(x.config,{complete:async()=>{
    await mutateMemory(x.config,x.repo,'user','add','Concurrent durable preference.');
    return JSON.stringify(plan);
  }});
  assert.equal(result.failed,1); assert.match(result.messages.join('\n'),/external_drift/);
  const after=await readTargetSnapshot(x.config,x.repo,'user');
  assert.equal(after.entries.length,5); assert.ok(after.entries.includes('Concurrent durable preference.'));
});

test('cancellation after generation cannot mutate source',async t=>{
  const x=await fixture(t); const before=await readTargetSnapshot(x.config,x.repo,'user');
  const controller=new AbortController();
  const result=await runDailyCleanup(x.config,{complete:async()=>{controller.abort();return JSON.stringify(plan);}},controller.signal);
  assert.equal(result.removed,0); assert.equal(result.failed,1);
  assert.equal((await readTargetSnapshot(x.config,x.repo,'user')).serialized,before.serialized);
});

test('registered repository cleanup preserves other scopes and repository provenance',async t=>{
  const x=await fixture(t);
  await mutateMemory(x.config,x.repo,'repository','add','Deploy uses canary releases.');
  await mutateMemory(x.config,x.repo,'repository','add','The deployment job is queued.');
  const before=await readTargetSnapshot(x.config,x.repo,'user');
  const result=await runDailyCleanup(x.config,{complete:async({text})=>{
    const data=JSON.parse(text);
    return JSON.stringify(data.scope==='repository'?{remove:[{id:'2',reason:'transient',retained:[]}]}:{remove:[]});
  }});
  assert.equal(result.removed,1);
  assert.equal((await readTargetSnapshot(x.config,x.repo,'user')).serialized,before.serialized);
  assert.deepEqual((await readTargetSnapshot(x.config,x.repo,'repository')).entries,['Deploy uses canary releases.']);
});
