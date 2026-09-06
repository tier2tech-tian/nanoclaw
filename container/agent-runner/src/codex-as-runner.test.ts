import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runCodexAsQuery,
  mapAsItem,
  asInputContent,
} from './codex-as-runner.js';
import { CodexAsInbox } from './codex-as-inbox.js';
import type { ContainerOutput } from './cli-runner.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

async function run(scenario: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-test-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const inputDir = path.join(root, 'ipc', 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');
const scenario=${JSON.stringify(scenario)},root=${JSON.stringify(root)},inputDir=${JSON.stringify(inputDir)};
fs.writeFileSync(root+'/pid',String(process.pid));
if(scenario==='close'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let turnId='turn-1';
const event=(method,params)=>send({method,params:{threadId:'thread',turnId,...params}});
const reply=(id,result)=>send({id,result});
const done=(status='completed',text='最终回答')=>{event('item/completed',{item:{id:'answer',type:'agentMessage',text}});event('turn/completed',{turn:{id:turnId,status,error:status==='failed'?{message:'真实错误'}:null,items:[]}})};
let starts=0;
rl.createInterface({input:process.stdin}).on('line',l=>{
 const q=JSON.parse(l);fs.appendFileSync(root+'/requests.jsonl',l+'\\n');
 if(q.method==='initialize')reply(q.id,{});
 if(q.method==='thread/start'||q.method==='thread/resume')reply(q.id,{thread:{id:'thread'}});
 if(q.method==='turn/start'){
  starts++;turnId='turn-'+starts;reply(q.id,{turn:{id:turnId,status:'inProgress',items:[]}});
  if(starts>1){event('turn/completed',{turn:{id:'turn-1',status:'failed',items:[]}});event('item/completed',{threadId:'other-thread',item:{id:'noise',type:'agentMessage',text:'串群'}})}
  if(starts>1){setTimeout(()=>done(),60);return}
  if(scenario==='normal'){done();return}
  if(scenario==='failed'||scenario==='interrupted'){done(scenario);return}
  if(scenario==='exit'){process.exit(2);return}
  if(scenario==='no-terminal'||scenario==='close')return;
  event('item/started',{item:{id:'tool',type:'commandExecution',command:'echo 开始',status:'inProgress'}});
  fs.writeFileSync(inputDir+'/followup.json',JSON.stringify({type:'message',text:'补充要求'}));
 }
 if(q.method==='turn/steer'){
  if(q.params.expectedTurnId!==turnId)throw Error('错误轮次');
  if(scenario==='drop'){process.exit(2);return}
  if(scenario==='timeout')return;
  if(scenario==='wrong-ack'){reply(q.id,{turnId:'wrong'});done();return}
  if(scenario==='rpc-error'){send({id:q.id,error:{code:-32603,message:'内部错误'}});return}
  if(scenario==='rejected'||scenario==='failed-rejected'){
   done(scenario==='failed-rejected'?'failed':'completed','旧回答');
   send({id:q.id,error:{code:-32600,message:'no active turn to steer'}});return;
  }
  if(scenario==='late-ack'){done();setTimeout(()=>reply(q.id,{turnId}),40);return}
  reply(q.id,{turnId});done();
 }
});
`,
    { mode: 0o755 },
  );
  const outputs: ContainerOutput[] = [],
    logs: string[] = [];
  await runCodexAsQuery(
    {
      prompt: '开始任务',
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      codexHome: path.join(root, 'home'),
      ipcDir: path.join(root, 'ipc'),
      mcpServerPath: '/unused',
      chatJid: 'test',
      groupFolder: 'test',
      isMain: false,
      rpcTimeoutMs: 1500,
      idleTimeoutMs: 500,
      pollIntervalMs: 5,
      shouldClose: () => scenario === 'close' && logs.some(s => s.includes('turn/start accepted')),
    },
    (o) => outputs.push(o),
    (s) => logs.push(s),
  );
  const requests = fs
    .readFileSync(path.join(root, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(
    requests.some((q) => q.method === 'turn/start'),
    JSON.stringify({ outputs, logs }),
  ).toBe(true);
  return { root, outputs, logs, inbox: new CodexAsInbox(inputDir), requests };
}

describe('App Server 进程边界', () => {
  it('公开思考仅映射 summary，不读取内部 content', () => {
    expect(
      mapAsItem(
        {
          id: 'r',
          type: 'reasoning',
          summary: ['公开摘要'],
          content: ['不可外显'],
        },
        true,
      ).item?.text,
    ).toBe('公开摘要');
  });
  it('MCP 事件保留问题卡授权所需信息', () => {
    const mapped = mapAsItem(
      {
        id: 'tool',
        type: 'mcpToolCall',
        server: 'nanoclaw',
        tool: 'send_question_card',
        arguments: { title: '问题' },
        status: 'inProgress',
      },
      false,
    );
    expect(mapped.item).toMatchObject({
      id: 'tool',
      type: 'mcp_tool_call',
      server: 'nanoclaw',
      tool: 'send_question_card',
      arguments: { title: '问题' },
    });
  });
  it('图片符号链接越界不能被提交', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-image-'));
    roots.push(root);
    const allowed = path.join(root, 'allowed');
    fs.mkdirSync(allowed);
    const outside = path.join(root, 'outside.png');
    fs.writeFileSync(outside, '图片');
    fs.symlinkSync(outside, path.join(allowed, 'link.png'));
    expect(() =>
      asInputContent(
        {
          text: '看图',
          attachments: [
            { type: 'image', path: path.join(allowed, 'link.png') },
          ],
        },
        '看图',
        allowed,
      ),
    ).toThrow('当前群目录');
  });
  it('普通任务仅由 completed 发成功终态', async () => {
    const r = await run('normal');
    expect(r.outputs.filter((o) => o.status !== 'progress')).toEqual([
      expect.objectContaining({ status: 'success', result: '最终回答' }),
    ]);
  });
  it.each(['steer', 'late-ack'])(
    '%s：补充和终态乱序也不重发',
    async (scenario) => {
      const r = await run(scenario);
      expect(r.requests.filter((q) => q.method === 'turn/steer')).toHaveLength(
        1,
      );
      expect(r.requests.filter((q) => q.method === 'turn/start')).toHaveLength(
        1,
      );
      expect(r.outputs.filter((o) => o.status !== 'progress')).toEqual([
        expect.objectContaining({ status: 'success', result: '最终回答' }),
      ]);
      expect(r.inbox.pendingUncertain()).toBe(0);
    },
  );
  it.each(['drop', 'timeout', 'wrong-ack', 'rpc-error'])(
    '%s：回执不明只失败一次且保留原文',
    async (scenario) => {
      const r = await run(scenario);
      expect(r.outputs.filter((o) => o.status !== 'progress')).toEqual([
        expect.objectContaining({ status: 'error' }),
      ]);
      expect(r.requests.filter((q) => q.method === 'turn/steer')).toHaveLength(
        1,
      );
      expect(r.inbox.pendingUncertain()).toBe(1);
      expect(
        fs.readFileSync(
          path.join(r.inbox.uncertainDir, 'followup.json'),
          'utf8',
        ),
      ).toContain('补充要求');
    },
  );
  it('明确拒绝且旧轮成功才接续，旧回答只作进度', async () => {
    const r = await run('rejected');
    expect(r.requests.filter((q) => q.method === 'turn/start')).toHaveLength(2);
    expect(
      r.outputs.some((o) => o.status === 'progress' && o.detail === '旧回答'),
    ).toBe(true);
    expect(r.outputs.filter((o) => o.status !== 'progress')).toEqual([
      expect.objectContaining({ status: 'success', result: '最终回答' }),
    ]);
    expect(JSON.stringify(r.outputs)).not.toContain('串群');
  });

  it('主动关闭只 interrupt 一次，无回执且忽略 SIGTERM 也有界回收', async () => {
    const r = await run('close');
    expect(r.requests.filter(q => q.method === 'turn/interrupt')).toHaveLength(1);
    expect(r.outputs.filter(o => o.status !== 'progress')).toEqual([expect.objectContaining({ status: 'error' })]);
    const pid = Number(fs.readFileSync(path.join(r.root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('失败优先，未接受补充回队且不启动后继', async () => {
    const r = await run('failed-rejected');
    expect(r.requests.filter((q) => q.method === 'turn/start')).toHaveLength(1);
    expect(r.outputs.filter((o) => o.status !== 'progress')).toEqual([
      expect.objectContaining({ status: 'error' }),
    ]);
    expect(fs.existsSync(path.join(r.inbox.inputDir, 'followup.json'))).toBe(
      true,
    );
  });
  it.each(['failed', 'interrupted', 'exit', 'no-terminal'])(
    '%s：不把无终态或失败当成功',
    async (scenario) => {
      const r = await run(scenario);
      expect(r.outputs.filter((o) => o.status !== 'progress')).toEqual([
        expect.objectContaining({ status: 'error' }),
      ]);
    },
  );
});
