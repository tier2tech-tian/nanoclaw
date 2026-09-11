import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, it } from 'vitest';
import { prepareCodexAccount } from './codex-accounts.js';
import { runCodexQuery } from '../container/agent-runner/src/codex-runner.js';
import { runCodexAsQuery } from '../container/agent-runner/src/codex-as-runner.js';

// 真实子进程与文件链路；假Codex协议服务，不冒充OpenAI跨账号验收。
it.each(['codex', 'codex-as'] as const)(
  '%s两份隔离凭据切换后新进程读取新身份并保留thread',
  async (mode) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nano-account-process-'),
    );
    try {
      const home = path.join(root, 'group');
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'codex'),
        `#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');
const identity=JSON.parse(fs.readFileSync(process.env.CODEX_HOME+'/auth.json','utf8')).OPENAI_API_KEY;
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(process.argv.includes('app-server')) {
 rl.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(path.join(root, 'rpc.jsonl'))},line+'\\n');
 if(q.method==='initialize')emit({id:q.id,result:{}});
 if(q.method==='thread/start'||q.method==='thread/resume')emit({id:q.id,result:{thread:{id:'preserved-thread'}}});
 if(q.method==='turn/start'){
 emit({id:q.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});
 emit({method:'item/completed',params:{threadId:'preserved-thread',turnId:'turn',item:{id:'answer',type:'agentMessage',text:identity}}});
 emit({method:'turn/completed',params:{threadId:'preserved-thread',turn:{id:'turn',status:'completed',items:[]}}});
 }
 });
} else {
 fs.appendFileSync(${JSON.stringify(path.join(root, 'args.jsonl'))},JSON.stringify(process.argv)+'\\n');
 process.stdin.resume();process.stdin.on('end',()=>{
 emit({type:'thread.started',thread_id:'preserved-thread'});
 emit({type:'item.completed',item:{type:'agent_message',text:identity}});
 emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
 });
}
`,
        { mode: 0o755 },
      );
      let sessionId: string | undefined;
      for (const name of ['first', 'second']) {
        const file = path.join(root, `${name}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify({ OPENAI_API_KEY: `fake-${name}` }),
        );
        prepareCodexAccount(home, { name, authFile: file }, true);
        const fn = mode === 'codex' ? runCodexQuery : runCodexAsQuery;
        const result = await fn(
          {
            prompt: 'probe',
            sessionId,
            cwd: root,
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
            codexHome: home,
            ipcDir: path.join(root, 'ipc'),
            mcpServerPath: '/unused',
            chatJid: 'test',
            groupFolder: 'test',
            isMain: false,
          },
          () => {},
          () => {},
        );
        expect(result.result).toBe(`fake-${name}`);
        expect(result.newSessionId).toBe('preserved-thread');
        sessionId = result.newSessionId;
      }
      const trace = fs.readFileSync(
        path.join(root, mode === 'codex' ? 'args.jsonl' : 'rpc.jsonl'),
        'utf8',
      );
      expect(trace).toContain(mode === 'codex' ? 'resume' : 'thread/resume');
      expect(trace).toContain('preserved-thread');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
