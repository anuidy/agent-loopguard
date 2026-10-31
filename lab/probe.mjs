import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, guardVersion, hostVersion, hostDependencies, guardSchemaVersion } from './native-harness.mjs';

const results = [];
const fixture = fileURLToPath(new URL('../fixtures/failing_test.py', import.meta.url));
const save = async (caseName, data) => {
  const record = { case: caseName, ...data };
  results.push(record);
  console.log(JSON.stringify({ case: caseName, ...data.summary }));
};

async function readEditRead(bridgeResult) {
  const h = await createHarness({ bridgeResult });
  const workDir = new URL(`../results/work-read-edit-${guardVersion}-${hostVersion}-${bridgeResult ? 'bridge' : 'stock'}/`, import.meta.url);
  await mkdir(workDir, { recursive: true });
  const sourcePath = new URL('config.py', workDir);
  await writeFile(sourcePath, 'before', 'utf8');
  h.register('read_file', () => readFile(sourcePath, 'utf8'), { path: { type: 'string' } });
  h.register('write_file', async args => { await writeFile(sourcePath, args.text, 'utf8'); return 'written'; }, { path: { type: 'string' }, text: { type: 'string' } });
  try {
    const calls = [
      await h.call('read_file', { path: 'config.py' }),
      await h.call('write_file', { path: 'config.py', text: 'after' }),
      await h.call('read_file', { path: 'config.py' }),
    ];
    const last = calls.at(-1);
    assert.equal(last.denial === null, bridgeResult);
    if (bridgeResult) assert.equal(last.value, 'after');
    assert(h.logs.every(x => !x.executionContainsResult));
    await save(`read-edit-read-${bridgeResult ? 'result-bridge' : 'stock'}`, {
      summary: { bridgeResult, deniedCall: last.denial ? 3 : null, denial: last.denial, finalValue: last.value },
      calls, events: h.logs,
    });
  } finally { await h.dispose(); }
}

async function polling(bridgeResult, loosenDuplicate = false) {
  const h = await createHarness({ bridgeResult,
    config: loosenDuplicate ? { blockExactDuplicates: false } : {},
    message: 'Wait for this background evaluation to finish and collect its result.',
  });
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 700)'], { stdio: 'ignore' });
  let workerDone = false;
  const finished = once(worker, 'exit').then(([code]) => { workerDone = true; return code; });
  h.register('job_output', async () => {
    await sleep(25);
    return { text: workerDone ? 'completed' : '(no new output)', job: { id: 'eval-1', status: workerDone ? 'completed' : 'running' } };
  }, { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'number' } });
  try {
    const calls=[];
    let blockedWhileRunning=false;
    for (let i=0;i<9;i++) {
      const result=await h.call('job_output', { job_id:'eval-1',wait:true,timeout_ms:25 });
      calls.push(result);
      if (result.denial) { blockedWhileRunning=!workerDone;break; }
      if (workerDone) break;
    }
    const exitCode=await finished;
    assert(blockedWhileRunning);
    const expected = !bridgeResult ? 2 : loosenDuplicate ? 7 : 3;
    assert.equal(calls.length,expected);
    await save(`async-poll-${bridgeResult ? 'result-bridge' : 'stock'}${loosenDuplicate ? '-duplicates-off' : ''}`, {
      summary: { bridgeResult, loosenDuplicate, deniedCall:calls.length, denial:calls.at(-1).denial,
        blockedWhileRunning, workerEventuallyCompleted:exitCode===0 },
      calls, events:h.logs,
    });
  } finally { await finished;await h.dispose(); }
}

function actualFailedTest() {
  const p=spawnSync('python',[fixture],{ encoding:'utf8' });
  if (p.error) throw p.error;
  assert.equal(p.status,1);
  // Shell success is distinct from the invoked program's exit code. This
  // fixture uses that same canonical convention as DSH's bash tool.
  return { kind:'foreground',cwd:'audit-fixture',exitCode:p.status,signal:null,timedOut:false,aborted:false,
    stdout:{text:p.stdout,truncated:false},stderr:{text:p.stderr,truncated:false} };
}

async function failingTests(bridgeResult, fixedResult = false) {
  const h=await createHarness({bridgeResult});
  const first=actualFailedTest();
  h.register('bash',()=>fixedResult ? first : actualFailedTest(),{
    command:{type:'string'},description:{type:'string'},
  });
  try {
    const calls=[];
    for (let i=0;i<8;i++) {
      const result=await h.call('bash',{command:'python failing_test.py',description:'Run the test suite'});
      calls.push(result);
      if(result.denial)break;
    }
    if(!bridgeResult) assert.equal(calls.length,2);
    else if(fixedResult)assert.equal(calls.length,3);
    else assert.equal(calls.filter(x=>x.denial).length,0);
    await save(`unchanged-failing-tests-${bridgeResult ? 'result-bridge' : 'stock'}${fixedResult ? '-fixed-output-control' : ''}`,{
      summary:{bridgeResult,fixedResult,calls:calls.length,executions:h.bodyCounts.get('bash'),
        deniedCall:calls.at(-1).denial ? calls.length : null,
        allExecutedTestsFailed:calls.filter(x=>!x.denial).every(x=>x.value.exitCode===1)},
      calls,events:h.logs,
    });
  }finally{await h.dispose();}
}

async function changedDescription(bridgeResult, changeDescription) {
  const h=await createHarness({bridgeResult});
  h.register('bash',()=> ({kind:'foreground',exitCode:1,signal:null,timedOut:false,aborted:false,
    cwd:'audit-fixture',stdout:{text:'same failed test',truncated:false},stderr:{text:'',truncated:false}}),
  {command:{type:'string'},description:{type:'string'}});
  try {
    const calls=[];
    for(let i=0;i<8;i++) {
      const result=await h.call('bash',{command:'python failing_test.py',description:changeDescription ? `Retry tests attempt ${i+1}` : 'Run tests'});
      calls.push(result);if(result.denial)break;
    }
    if(changeDescription) assert(calls.every(x=>x.denial===null));
    else assert.equal(calls.length,bridgeResult ? 3 : 2);
    await save(`description-${changeDescription ? 'varies' : 'fixed'}-${bridgeResult ? 'result-bridge' : 'stock'}`,{
      summary:{bridgeResult,changeDescription,calls:calls.length,executions:h.bodyCounts.get('bash'),
        deniedCall:calls.at(-1).denial ? calls.length : null},calls,
    });
  }finally{await h.dispose();}
}

async function stopWords(message, shouldBlock) {
  const h=await createHarness({message});h.register('read_file',()=> 'read',{});
  try {
    const result=await h.call('read_file');assert.equal(result.denial!==null,shouldBlock);
    await save(`user-message-${message}`,{summary:{message,denial:result.denial,executions:h.bodyCounts.get('read_file')??0},calls:[result]});
  }finally{await h.dispose();}
}

async function outputCase(kind) {
  const h=await createHarness({config:{assistantOutputGuard:true},message:'Return the requested structured output.'});
  const fullText = kind==='nested-json' ? JSON.stringify({a:{b:{c:{d:{e:{f:{answer:42}}}}}}},null,2)+'\n'
    : kind==='repeated-prose' ? Array(7).fill('I will perform the same action again.').join('\n')+'\n'
    : ['first distinct line','second distinct line','third distinct line','fourth distinct line','fifth distinct line'].join('\n')+'\n';
  if(kind==='nested-json') assert.equal(JSON.parse(fullText).a.b.c.d.e.f.answer,42);
  try {
    let delivered='';
    for(const line of fullText.split(/(?<=\n)/)) {
      delivered+=line;
      h.ctx.emit('session/event',h.agent.session,{type:'assistant/chunk',data:{turn:1,step:0,chunk:{type:'text-delta',index:0,text:line}}});
      if(h.cancellations.length)break;
    }
    assert.equal(h.cancellations.length>0,kind!=='distinct-prose');
    let deliveredJsonValid=null;
    if(kind==='nested-json') {try{JSON.parse(delivered);deliveredJsonValid=true;}catch{deliveredJsonValid=false;}assert.equal(deliveredJsonValid,false);}
    await save(`output-${kind}`,{summary:{canceled:h.cancellations.length>0,deliveredJsonValid,
      deliveredChars:delivered.length,fullChars:fullText.length},fullText,delivered,cancellations:h.cancellations});
  }finally{await h.dispose();}
}

await readEditRead(false);await readEditRead(true);
await polling(false);await polling(true);await polling(true,true);
await failingTests(false);await failingTests(true);await failingTests(true,true);
for(const bridge of [false,true]){await changedDescription(bridge,true);await changedDescription(bridge,false);}
await stopWords('Implement a cancel button for the training page.',true);
await stopWords('Do not stop until all tests pass.',true);
await stopWords('Stop now.',true);
await stopWords('Read the configuration file.',false);
await outputCase('nested-json');await outputCase('repeated-prose');await outputCase('distinct-prose');

const report={
  guard:guardVersion === '0.2.18'
    ? {version:guardVersion,commit:'b6943ab0d9a319e32ed64e151ab9aed09682ecc9',schemastery:guardSchemaVersion}
    : {version:guardVersion,releaseCommit:'d1d75e3395b09e6acd84246578626c27b33581a5',source:'npm published tarball, SHA-512 verified against metadata/guard-npm-latest.json',schemastery:guardSchemaVersion},
  host:{...hostDependencies,node:process.version,platform:process.platform},
  scope:'Real Cordis kernel, real DSH ToolRuntime, original plugin registration. Tools and agent handle are controlled fixtures; no model/API/UI/full Agent loop.',
  bridge:'Result bridge is an explicit diagnostic control only; upstream source is not edited.',
  cases:results,
};
await mkdir(new URL('../results/',import.meta.url),{recursive:true});
const reportPath = `../results/reproductions-${guardVersion}-host-${hostVersion}.json`;
await writeFile(new URL(reportPath,import.meta.url),JSON.stringify(report,null,2),'utf8');
console.log(`Saved ${results.length} cases to ${reportPath}`);
