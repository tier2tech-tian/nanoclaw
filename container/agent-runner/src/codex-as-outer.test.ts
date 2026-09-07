import { expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

it('真实外层轮间认领：续接线程、应用 override、start 断连保全原文', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-outer-'));
  const bin = path.join(root, 'bin'),
    group = path.join(root, 'group'),
    ipc = path.join(root, 'ipc');
  fs.mkdirSync(bin);
  fs.mkdirSync(group);
  fs.mkdirSync(path.join(ipc, 'input'), { recursive: true });
  const image = path.join(group, 'sample.png');
  fs.writeFileSync(image, 'test');
  const messages = path.join(root, 'requests.jsonl');
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');let resumed=false;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(messages)},line+'\\n');
if(q.method==='initialize')send({id:q.id,result:{}});
if(q.method==='thread/start'||q.method==='thread/resume'){resumed=q.method==='thread/resume';send({id:q.id,result:{thread:{id:'outer-thread'}}})}
if(q.method==='turn/start'){
 if(resumed){process.exit(2);return}
 send({id:q.id,result:{turn:{id:'first',status:'inProgress',items:[]}}});
 send({method:'item/completed',params:{threadId:'outer-thread',turnId:'first',item:{id:'a',type:'agentMessage',text:'第一轮完成'}}});
 send({method:'turn/completed',params:{threadId:'outer-thread',turn:{id:'first',status:'completed',items:[]}}});
}
});`,
    { mode: 0o755 },
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      require.resolve('tsx/esm'),
      path.resolve('container/agent-runner/src/index.ts'),
    ],
    {
      cwd: path.resolve('.'),
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let stdout = '',
    stderr = '',
    injected = false;
  child.stdout.on('data', (bytes) => {
    stdout += bytes;
    if (!injected && stdout.includes('第一轮完成')) {
      injected = true;
      fs.writeFileSync(
        path.join(ipc, 'input', 'second.json'),
        JSON.stringify({
          type: 'message',
          text: '轮间补充',
          senderId: 'sender-2',
          modelOverride: { model: 'second-model' },
          attachments: [{ type: 'image', path: image, label: '截图' }],
        }),
      );
      fs.writeFileSync(
        path.join(ipc, 'input', 'third.json'),
        JSON.stringify({ type: 'message', text: '不能越序' }),
      );
    }
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {}
  }, 12000);
  child.stdin.end(
    JSON.stringify({
      prompt: '第一轮',
      cliMode: 'codex-as',
      groupFolder: 'outer',
      chatJid: 'outer',
      isMain: false,
      workspacePaths: { group, ipc },
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('close', () => resolve());
      child.on('error', reject);
    });
    const frames = [
      ...stdout.matchAll(
        /---NANOCLAW_OUTPUT_START---\s*([\s\S]*?)\s*---NANOCLAW_OUTPUT_END---/g,
      ),
    ].map((m) => JSON.parse(m[1]));
    expect(
      frames.filter((o) => o.status === 'success'),
      stderr,
    ).toHaveLength(1);
    expect(
      frames.filter((o) => o.status === 'error'),
      stderr,
    ).toHaveLength(1);
    const requests = fs
      .readFileSync(messages, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(
      requests.find((q) => q.method === 'thread/resume')?.params.threadId,
    ).toBe('outer-thread');
    expect(
      requests.filter((q) => q.method === 'turn/start').at(-1)?.params,
    ).toMatchObject({
      model: 'second-model',
      input: [{ type: 'text', text: '轮间补充' }, { type: 'localImage' }],
    });
    const preserved = JSON.parse(
      fs.readFileSync(
        path.join(ipc, 'input', '.codex-as', 'uncertain', 'second.json'),
        'utf8',
      ),
    );
    expect(preserved).toMatchObject({
      text: '轮间补充',
      senderId: 'sender-2',
      modelOverride: { model: 'second-model' },
      attachments: [{ path: image }],
    });
    expect(fs.existsSync(path.join(ipc, 'input', 'third.json'))).toBe(true);
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
