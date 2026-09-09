import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ENTRY = 'container/agent-runner/src/index.ts';
const SESSION = '11111111-1111-4111-8111-111111111111';
const MAIN = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';
const MAIN_LATER = '44444444-4444-4444-8444-444444444444';

// 真runner + 真SDK协议客户端；仅CLI替身产生已由真实SDK探针确认的消息信封。
// 跨三次query检查实际CLI argv，覆盖消息归属和外层恢复位置生命周期。
async function runScenario(order: 'child_last' | 'main_last' | 'child_only') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-resume-anchor-'));
  const group = path.join(root, 'group'), ipc = path.join(root, 'ipc');
  const inputDir = path.join(ipc, 'input'), capture = path.join(root, 'argv.jsonl');
  const fakeDir = path.join(root, 'fake-runner');
  const sdkDir = path.join(fakeDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(group, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'cli.js'), `
const fs=require('fs');
const capture=${JSON.stringify(capture)},inputDir=${JSON.stringify(inputDir)},order=${JSON.stringify(order)};
const session=${JSON.stringify(SESSION)},main=${JSON.stringify(MAIN)},child=${JSON.stringify(CHILD)},later=${JSON.stringify(MAIN_LATER)};
const round=fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\\n').length+1:1;
fs.appendFileSync(capture,JSON.stringify({round,args:process.argv.slice(2)})+'\\n');
let buffer='',handled=false;
function emit(m){process.stdout.write(JSON.stringify(m)+'\\n');}
function assistant(uuid,parent){emit({type:'assistant',session_id:session,uuid,parent_tool_use_id:parent,message:{id:'msg-'+uuid,model:'fake-model',role:'assistant',type:'message',content:[{type:'text',text:'probe-'+uuid}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});}
function handle(line){if(!line.trim())return;const m=JSON.parse(line);
 if(m.type==='control_request'){emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});return;}
 if(m.type!=='user'||handled)return;handled=true;
 emit({type:'system',subtype:'init',session_id:session});
 if(round===1){if(order!=='child_only')assistant(main,null);assistant(child,'toolu_child');if(order==='main_last')assistant(later,null);}
 if(round===3){assistant(later,null);fs.writeFileSync(inputDir+'/_close','');}
 if(round===2)emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['No message found with message.uuid of: '+main],session_id:session,duration_ms:1,duration_api_ms:1,num_turns:0,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}});
 else emit({type:'result',subtype:'success',is_error:false,result:'round-'+round,session_id:session,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
 setTimeout(()=>process.exit(0),100);
}
process.stdin.on('data',b=>{buffer+=b.toString();let i;while((i=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,i);buffer=buffer.slice(i+1);handle(line);}});
`);
  // NanoClaw的native SDK不读取AGENT_RUNNER_DIR；只在测试加载器里替换CLI路径，保留真实SDK客户端。
  const sdk = path.resolve('container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  const proxy = path.join(root, 'sdk-proxy.mjs'), loader = path.join(root, 'loader.mjs'), register = path.join(root, 'register.mjs');
  fs.writeFileSync(proxy, `export * from ${JSON.stringify(sdk)}; import {query as realQuery} from ${JSON.stringify(sdk)}; export function query(p){return realQuery({...p,options:{...p.options,pathToClaudeCodeExecutable:${JSON.stringify(path.join(sdkDir,'cli.js'))},executable:'node'}});}`);
  fs.writeFileSync(loader, `export function resolve(s,c,n){if(s==='@anthropic-ai/claude-agent-sdk')return {url:${JSON.stringify('file://'+proxy)},shortCircuit:true};return n(s,c);}`);
  fs.writeFileSync(register, `import {register} from 'node:module';register(${JSON.stringify('file://'+loader)});`);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '--import '+register, AGENT_RUNNER_DIR: fakeDir, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), ANTHROPIC_API_KEY: 'local-test-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' };
  for(const key of ['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX'])delete env[key];
  delete env.CLAUDECODE;
  const child = spawn(path.resolve('node_modules/.bin/tsx'), [ENTRY], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sent = 0, ended = false;
  child.stdout.on('data', b => { stdout += b.toString(); });
  child.stderr.on('data', b => {
    stderr += b.toString();
    if (/Close sentinel (?:consumed|received).*exiting/.test(stderr)) { ended = true; child.kill('SIGTERM'); }
    const boundaries = [...stderr.matchAll(/Query ended, waiting for next IPC message/g)].length;
    while (sent < Math.min(boundaries, 2)) {
      sent++;
      fs.writeFileSync(path.join(inputDir, `next-${sent}.json`), JSON.stringify({ type: 'message', text: `用户主动下一条-${sent}` }));
    }
  });
  child.stdin.end(JSON.stringify({ prompt: '第一轮', groupFolder: 'resume-probe', chatJid: 'fs:oc_test', isMain: false, cliMode: 'sdk', workspacePaths: { group, ipc }, runtimeContext: { conversation_id: 'resume-probe' } }));
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`runner超时: ${stderr.slice(-1800)}`)); }, 25000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const calls: Array<{round:number,args:string[]}> = fs.readFileSync(capture, 'utf8').trim().split('\n').map(line=>JSON.parse(line));
    return { exit, calls, stdout, stderr, sent, ended };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function flag(args: string[], name: string) { const joined=args.find(a=>a.startsWith(name+'='));if(joined)return joined.slice(name.length+1);const i=args.indexOf(name);return i<0?undefined:args[i+1]; }

describe('主对话恢复位置与子代理隔离', () => {
  for (const order of ['child_last', 'main_last', 'child_only'] as const) {
    it(`${order}：实际下一轮参数只引用主历史，零assistant失败后按原session最新位置继续`, async () => {
      const r=await runScenario(order), debug=JSON.stringify(r.calls)+r.stderr.slice(-1800);
      expect(r.ended,debug).toBe(true);
      expect(r.calls,debug).toHaveLength(3); // 只能是三条主动输入，不能自动重放失败业务。
      expect(r.sent).toBe(2);
      expect(flag(r.calls[1].args,'--resume'),debug).toBe(SESSION);
      expect(flag(r.calls[1].args,'--resume-session-at')).toBe(order==='child_only'?undefined:order==='main_last'?MAIN_LATER:MAIN);
      expect(flag(r.calls[2].args,'--resume')).toBe(SESSION);
      expect(flag(r.calls[2].args,'--resume-session-at')).toBeUndefined();
    }, 30000);
  }
});
