// Opt-in acceptance of an existing task in the installed desktop runtime.
// Only normal chat/Stop messages are sent. Model/tool orchestration belongs to
// the desktop Agent; this driver reads checkpoints and verifies preservation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import YAML from 'yaml';
const root=resolve(process.env.REVIEW_ACCEPTANCE_ROOT??'/private/tmp/literature-flex-20261023');
const baseline=JSON.parse(await fs.readFile(join(root,'preserved.json'),'utf8'));
const path=process.env.REVIEW_ACCEPTANCE_TASK??join(homedir(),'Library/Application Support/Memmy/plugin-data/literature-review/tasks',baseline.taskId,'task.json');
const config=YAML.parse(await fs.readFile(process.env.MEMMY_CONFIG??join(homedir(),'.memmy/config.yaml'),'utf8'));
const base=`http://127.0.0.1:${config.channels.websocket.port}`;
const boot=await fetch(base+'/webui/bootstrap',{headers:{'X-Memmy-Agent-Auth':config.channels.websocket.tokenIssueSecret||config.channels.websocket.token}}).then(r=>r.json());
const u=new URL(boot.ws_path,base);u.protocol='ws:';u.searchParams.set('token',boot.token);u.searchParams.set('client_surface','gui');u.searchParams.set('client_id','flexible-review-acceptance');
const expectedSections=(function leaves(nodes){return nodes.flatMap(node=>node.children?.length?leaves(node.children):[node]);})(baseline.outline).length;
const chatId=baseline.chatId;const socket=new WebSocket(u);let ended=false,started=false,model,modelPreset,finalText='';const tools=[];
const log=async e=>{const x={at:new Date().toISOString(),...e};await fs.appendFile(join(root,'resume-events.jsonl'),JSON.stringify(x)+'\n');console.log(JSON.stringify(x));};
socket.onmessage=m=>{
 const e=JSON.parse(String(m.data));
 if(e.event==='ready'){socket.send(JSON.stringify({type:'attach',chat_id:chatId}));return;}
 if(e.event==='attached'&&!started){started=true;model=e.model;modelPreset=e.model_preset;assert.notEqual(model,'agent_chat');socket.send(JSON.stringify({type:'message',chat_id:chatId,content:`继续原具身智能文献综述任务 ${baseline.taskId}，这是用户已授权的插件更新和正文断点续跑验收。插件已更新至0.5.46：篇幅现在为弹性建议，旧长度失败候选会重新校验后复用。先检查当前状态，再只完成原大纲全部叶子小节的正文，直到没有待完成正文。
已知 outline-4-2 旧检查点因未授权引用 jena2024embodiedcity 耗尽修复。不要反复读取源码或日志。该节没有保存的合格段落，允许通过正常 review_refine 工具仅定向恢复此节：target={type:"section",id:"outline-4-2"},continuityScope="target-only"，要求只用本节提供证据和 allowedCitations，正文简洁、删除无证据事实。成功后用 review_get_status/review_generate_sections 正常推进。剩余还包括 outline-4-3、outline-5-1、section-ui-mvkdtbpn-1，必须检查这些叶子的正文。不要将“已处理10节”等同于13叶子全部完成。所有已保存55段禁止重写。
保持现有主题、目标篇幅 ${baseline.spec.targetLength??'默认值'} 和已确认大纲（实际叶子数以工具状态为准）。保留全部已生成段落和完成章节，不能重新生成它们，不要改目标字数来绕过旧限制。使用已注册文献综述插件工具推进；不要通过exec、源码修改或直接改task.json重置状态/重试计数，也不要手写正文代替插件。不重新检索、不重新生成大纲。正常分批、局部校验修复或相同参数推进检查点都应继续，不需要再次询问“继续”。当前仅验收正文，正文完成后汇报并停在这里，暂不进行图表、参考文献、审计、摘要、渲染或交付。保持当前 deepseek-v4.1-flash-1017 会话模型。`,webui:true,language:'zh-CN',client_request_id:randomUUID(),model_preset:modelPreset}));void log({event:'resume-sent',model,taskId:baseline.taskId});return;}
 if(e.chat_id&&e.chat_id!==chatId)return;
 for(const t of e.tool_events??[])tools.push({name:t.name,status:t.status});
 if(e.event==='stream_end'&&e.text)finalText=e.text;
 if(e.event==='message'&&e.kind!=='progress')finalText=String(e.text??e.content??'');
 if(e.event==='turn_end'||e.event==='error')ended=true;
 if(['turn_end','error','message_accepted'].includes(e.event)||e.tool_events?.length)void log({event:e.event,reason:e.reason,detail:e.event==='error'?e.detail:undefined,tools:e.tool_events?.map(t=>({name:t.name,status:t.status}))});
};
let signature='',complete=false;
try{
 for(let i=0;i<480;i++){
  await new Promise(r=>setTimeout(r,5000));
  const task=JSON.parse(await fs.readFile(path,'utf8'));const g=task.values.sectionGeneration??{};const paragraphs=Object.values(g.paragraphSections??{}).flatMap(c=>c.paragraphs.filter(p=>p.markdown));
  assert.deepEqual(task.spec,baseline.spec,'Resume must not change scope or target length');assert.deepEqual(task.values.outline,baseline.outline,'Resume must not change confirmed outline');
  for(const old of baseline.saved){const p=paragraphs.find(p=>p.id===old.id);assert.equal(p?.markdown,old.markdown,`Saved prose changed: ${old.id}`);assert.equal(p.attempts,old.attempts,`Saved paragraph regenerated: ${old.id}`);}
  const metrics={mode:g.mode,sections:g.completedOutlineNodeIds?.length??0,paragraphs:paragraphs.length,lengthFailures:Object.values(g.paragraphSections??{}).flatMap(c=>c.paragraphs).filter(p=>p.error?.startsWith('Paragraph length ')).length,exhausted:g.exhaustedFallbackOutlineNodeIds??[]};
  if(JSON.stringify(metrics)!==signature){signature=JSON.stringify(metrics);await log({event:'checkpoint-progress',...metrics});}
  if(ended){complete=g.mode==='host-model'&&g.completedOutlineNodeIds.length===expectedSections;const report={result:complete?'passed':'incomplete',finishedAt:new Date().toISOString(),taskId:task.taskId,chatId,model,pluginVersion:'0.5.46',preservedParagraphs:baseline.saved.length,specAndOutlineUnchanged:true,...metrics,tools,finalText};await fs.writeFile(join(root,'runtime-report.json'),JSON.stringify(report,null,2));if(complete)await fs.writeFile(join(root,'body.md'),task.values.sections.map(s=>s.markdown).join('\n\n'));break;}
 }
 if(!ended)socket.send(JSON.stringify({type:'stop',chat_id:chatId}));
 assert.ok(complete,'Inspect runtime-report.json: real Agent ended before body completion');
 await log({event:'existing-task-resume-passed',preservedParagraphs:baseline.saved.length});
}catch(error){socket.send(JSON.stringify({type:'stop',chat_id:chatId}));throw error;}finally{socket.close();}
