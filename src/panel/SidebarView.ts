import * as vscode from 'vscode';
import { DeviceManager } from './DeviceManager';
import { SessionStateManager } from './SessionStateManager';
import { Orchestrator } from '../orchestrator/Orchestrator';
import type { SessionState, LogEntry } from '../shared/types';
import type { ExtMsg, WebviewMsg } from '../shared/ipc';
import { captureTrace } from '../orchestrator/traceCapture';

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  deviceManager: DeviceManager; stateManager: SessionStateManager;
  orchestrator: Orchestrator; private currentDeviceId = '';

  constructor(private ctx: vscode.ExtensionContext, secrets: vscode.SecretStorage) {
    this.deviceManager = new DeviceManager(secrets); this.stateManager = new SessionStateManager(); this.orchestrator = new Orchestrator();
    this.orchestrator.setLogCallback((e: LogEntry) => { this.stateManager.log(e.level, e.text); this.post({ type: 'log', entry: e }); });
    this.orchestrator.setSessionsCallback((s: SessionState[]) => { this.stateManager.updateSessions(s); this.post({ type: 'session-update', sessions: s }); });
    this.orchestrator.setConnectionLostCallback(() => { this.post({ type: 'connection-lost', deviceId: '' }); });
    vscode.debug.onDidTerminateDebugSession((s) => { const sm=this.orchestrator.getSessionManager(); if(sm){const name=s.name.replace('OB: ','');const existing=sm.all.find(x=>x.targetName===name);if(existing)sm.update(existing.id,{status:'exited'});this.post({type:'session-update',sessions:sm.all});} });
  }
  private async startDap(name: string, port: number, binaryPath?: string) { const d = this.deviceManager.getAll().find(x=>x.id===this.currentDeviceId)||this.deviceManager.getAll()[0]; if(!d)return; const wsRoot=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath||''; let srcMap:Record<string,string>={'/tmp':wsRoot}; if(binaryPath){const p=require('path');const d1=p.posix.dirname(binaryPath);const d2=p.posix.dirname(d1);if(d2&&d2!=='/'&&d2!=='.')srcMap={[d2]:wsRoot}} const c: vscode.DebugConfiguration = { type:'omnibreak',name:'OB: '+name,request:'launch',targetHost:d.host,targetPort:port,sshUser:d.sshUser,sshPort:d.sshPort,sshPassword:await this.deviceManager.getSshPassword(d.id),gdbPath:d.gdbPath,nonStopMode:true,skipGdbserverStart:true,sourceFileMap:srcMap,binaryPath:binaryPath||'' }; try { await vscode.debug.startDebugging(undefined,c); this.stateManager.log('success','DAP: '+name); } catch(e:any) { this.stateManager.log('error','DAP fail: '+e.message); } }

  async resolveWebviewView(wv: vscode.WebviewView) { this.view=wv; wv.webview.options={enableScripts:true};
    wv.webview.onDidReceiveMessage(async (m: WebviewMsg) => {
      switch(m.type) {
        case 'load-devices':{this.post({type:'devices-loaded',devices:await this.deviceManager.load()});const sm=this.orchestrator.getSessionManager();if(sm?.all.length)this.post({type:'session-update',sessions:sm.all});break;}
        case 'save-device':{const s=await this.deviceManager.save(m.device);if(m.sshPassword)await this.deviceManager.setSshPassword(s.id,m.sshPassword);if(m.sudoPassword)await this.deviceManager.setSudoPassword(s.id,m.sudoPassword);this.post({type:'devices-loaded',devices:await this.deviceManager.load()});break;}
        case 'delete-device':{await this.deviceManager.remove(m.id);this.post({type:'devices-loaded',devices:await this.deviceManager.load()});break;}
        case 'test-connection':{const d=this.deviceManager.get(m.deviceId);if(!d)return;const cr=await this.orchestrator.testConnection(d,await this.deviceManager.getSshPassword(m.deviceId));this.post({type:'connection-test-result',deviceId:m.deviceId,ok:cr.ok,info:cr.info});break;}
        case 'start-debug':{this.currentDeviceId=m.config.deviceId;const d=this.deviceManager.get(m.config.deviceId);if(!d)return;const result=await this.orchestrator.start(m.config,d,await this.deviceManager.getSshPassword(m.config.deviceId),await this.deviceManager.getSudoPassword(m.config.deviceId));if(result){this.stateManager.log('info','DAP sessions to create: '+result.length);for(const s of result){this.stateManager.log('info','DAP: '+s.name+' bin='+(s.binaryPath||'none')+' port='+s.port);await this.startDap(s.name,s.port,s.binaryPath);}}break;}
        case 'disconnect':{await this.orchestrator.stop();break;}
        case 'request-stats':{const stats=await this.orchestrator.collectStats();this.post({type:'stats-update',stats});break;}
        case 'request-leak-scan':{const report=await this.orchestrator.collectLeakReport();this.post({type:'leak-update',report});break;}
        case 'start-leak-monitor':{break;}
        case 'stop-leak-monitor':{break;}
        case 'start-trace':{
          const ssh = this.orchestrator.getSshConnection();
          if(!ssh){this.post({type:'trace-result',result:null,error:'No active SSH connection. Start debugging first.'});break;}
          this.post({type:'log',entry:{level:'info',text:'Starting Perfetto trace capture...',ts:Date.now()}});
          try{
            const result = await captureTrace(ssh,{
              durationSec:m.duration||10,
              useSudo:!!m.useSudo,
              startCmd:m.startCmd,
            },(msg)=>{this.post({type:'log',entry:{level:'info',text:msg,ts:Date.now()}})});
            this.post({type:'trace-result',result});
          }catch(e:any){this.post({type:'trace-result',result:null,error:e.message});}
          break;}
              }
    });
    wv.webview.html=H();
  }
  private post(msg: ExtMsg) { this.view?.webview.postMessage(msg); }
}

function H():string{return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><title>OmniBreak</title><style>
:root{--bg:var(--vscode-sideBar-background);--fg:var(--vscode-foreground);--ac:var(--vscode-button-background);--af:var(--vscode-button-foreground);--bd:var(--vscode-panel-border);--in:var(--vscode-input-background);--if:var(--vscode-input-foreground);--ds:var(--vscode-descriptionForeground);--rd:8px;--sm:6px}
*{box-sizing:border-box;margin:0;padding:0}
body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased}
.tabs{display:flex;gap:4px;padding:8px 8px 6px;position:sticky;top:0;background:var(--bg);z-index:10;border-bottom:1px solid var(--bd)}
.tab{padding:5px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;background:transparent;color:var(--ds);border-radius:6px;transition:all .15s}
.tab:hover{color:var(--fg);background:var(--in)}
.tab.on{color:var(--af);background:var(--ac);font-weight:600}
.content{padding:10px}
.hd{display:flex;align-items:center;justify-content:space-between;margin:12px 0 6px}
.hd span{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--ds)}
.card{background:var(--in);border:1px solid var(--bd);border-radius:var(--rd);padding:10px;margin-bottom:6px;transition:border-color .15s}
.card.sel{border-color:var(--ac);border-width:1.5px}
.card-row{display:flex;align-items:center;gap:6px}
.card-meta{font-size:11px;color:var(--ds);margin-top:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 12px;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:500;transition:opacity .15s;white-space:nowrap;gap:4px}
.btn:hover{opacity:.85}.btn:active{opacity:.7}
.btn-p{background:var(--ac);color:var(--af)}
.btn-d{background:#e5534b;color:#fff}
.btn-g{background:#46954a;color:#fff}
.btn-m{background:#6e7681;color:#fff}
.btn-xs{padding:2px 8px;font-size:10px;border-radius:4px}
.inp{width:100%;padding:6px 10px;margin-bottom:4px;border:1px solid var(--bd);border-radius:5px;background:var(--in);color:var(--if);font-size:12px;outline:none;transition:border-color .15s}
.inp:focus{border-color:var(--ac)}.inp::placeholder{color:var(--ds);opacity:.6}
textarea.inp{min-height:32px;font-family:"SF Mono",Monaco,monospace;font-size:11px;resize:vertical;line-height:1.5}
.lbl{font-size:10px;font-weight:600;color:var(--ds);margin-bottom:3px;display:block;text-transform:uppercase;letter-spacing:.04em}
.row{display:flex;gap:6px;align-items:center}.rw{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pair{display:flex;gap:6px;align-items:center;margin-bottom:3px}
.pair .inp{flex:1;margin-bottom:0}
.pair span{color:var(--ds);font-size:11px;flex-shrink:0}
hr{border:none;border-top:1px solid var(--bd);margin:10px 0}
.log{font-family:"SF Mono",Monaco,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;overflow-y:auto;height:calc(100vh - 56px);padding:4px 0}
.log .li{color:var(--ds)}.log .ls{color:#57ab5a}.log .lw{color:#e3b341}.log .le{color:#e5534b}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;flex-shrink:0}
.dot-on{background:#57ab5a}.dot-off{background:#6e7681}.dot-err{background:#e5534b}
.sess{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--in);border:1px solid var(--bd);border-radius:var(--rd);margin-bottom:4px;font-size:11px}
.sess .name{font-weight:600;flex:1}.sess .info{color:var(--ds);font-size:10px}
[title]{position:relative}[title]:hover::after{content:attr(title);position:fixed;background:var(--in);color:var(--fg);border:1px solid var(--bd);border-radius:5px;padding:5px 10px;font-size:11px;white-space:nowrap;z-index:9999;pointer-events:none;left:var(--mx,0);top:var(--my,0);transform:translate(10px,-100%)}
</style></head><body>
<div id="tabs" class="tabs"><button class="tab on" data-t="config">Config</button><button class="tab" data-t="stats">Stats</button><button class="tab" data-t="leaks">Leaks</button><button class="tab" data-t="trace">Trace</button><button class="tab" data-t="logs">Logs</button></div>
<div id="diag" style="padding:4px 8px;font-size:10px;color:#e5534b;display:none"></div>
<div id="root" class="content">Loading...</div>
<script>
(function(){
var diag=document.getElementById('diag');
function die(m){diag.textContent='Failed to load OmniBreak panel: '+m;diag.style.display='block';console.warn(m)}
try{var v=acquireVsCodeApi(),saved=v.getState()||{};}catch(e){die('acquireVsCodeApi: '+e.message);return}
var devices=[],sessions=[],logs=saved.logs||[],tab='config',sel=saved.sel||'',ed=null,sf=false,conn=saved.conn||'',logView='actions',busy=false,stats=null,statsTimer=null,leak=null,leakTimer=null,traceRes=null,traceBusy=false;
var deploy=[],targets=[],rlogs=saved.rlogs||[];if(saved.deploy&&saved.deploy.length)deploy=saved.deploy;if(saved.targets&&saved.targets.length)targets=saved.targets;
var fs={n:'',h:'',u:'root',p:'22',pw:'',sp:'',g:'/usr/bin/gdb-multiarch'};

function E(t,a,k){var e=document.createElement(t);if(a)Object.keys(a).forEach(function(x){if(x==='T')e.textContent=a[x];else if(x==='S')Object.assign(e.style,a[x]);else if(x==='H')e.innerHTML=a[x];else if(x.startsWith('on'))e.addEventListener(x.slice(2),a[x]);else if(typeof a[x]==='boolean'){e[x]=a[x];if(a[x])e.setAttribute(x,'')}else e.setAttribute(x,a[x])});if(k)k.forEach(function(c){if(typeof c==='string')e.appendChild(document.createTextNode(c));else e.appendChild(c)});return e}

window.addEventListener('message',function(e){var m=e.data;
  if(m.type==='devices-loaded'){devices=m.devices;if(tab==='config')R()}
  else if(m.type==='session-update'){sessions=m.sessions;var hasActive=sessions.some(function(s){return s.status==='running'||s.status==='pending'});if(!hasActive){busy=false;if(statsTimer){clearInterval(statsTimer);statsTimer=null;stats=null}}else if(tab==='stats'&&!statsTimer){v.postMessage({type:'request-stats'});statsTimer=setInterval(function(){v.postMessage({type:'request-stats'})},1000)}if(tab==='config')R()}
  else if(m.type==='log'){logs.push(m.entry);if(logs.length>500)logs=logs.slice(-300);if(tab==='logs')R()}
  else if(m.type==='connection-test-result'){logs.push({level:m.ok?'success':'error',text:m.info,ts:Date.now()});conn=m.ok?m.deviceId:'';if(tab==='config')R()}
  else if(m.type==='connection-lost'){conn='';busy=false;if(tab==='config')R()}
  else if(m.type==='stats-update'){stats=m.stats;if(tab==='stats')R()}
  else if(m.type==='leak-update'){leak=m.report;if(tab==='leaks')R()}
else if(m.type==='trace-result'){traceBusy=false;traceRes=m.result;if(m.error){logs.push({level:'error',text:'Trace: '+m.error,ts:Date.now()})}R()}
});

function R(){var r=document.getElementById('root');r.innerHTML='';if(tab==='config')RC(r);else if(tab==='stats')RS(r);else if(tab==='leaks')RLk(r);else if(tab==='trace')Tr(r);else if(tab==='logs')RL(r);try{v.setState({deploy:deploy,targets:targets,conn:conn,sel:sel,logs:logs.slice(-200),rlogs:rlogs})}catch(e){}}

function RC(r){
  r.appendChild(E('div',{class:'hd'},[E('span',{T:'Devices ('+devices.length+')'})]));
  devices.forEach(function(d){var a=d.id===sel;var c=E('div',{class:'card'+(a?' sel':'')});c.appendChild(E('div',{S:{fontWeight:'600'},T:d.name}));c.appendChild(E('div',{S:{color:'var(--ds)'},T:d.host+':'+d.sshPort+' | '+d.sshUser}));var ro=E('div',{class:'rw',S:{marginTop:'6px'}});
  ro.appendChild(E('input',{type:'checkbox',checked:a,style:'width:auto;margin:0',onchange:function(){sel=a?'':d.id;R()}}));
  ro.appendChild(E('button',{class:'btn btn-xs '+(conn===d.id?'btn-g':'btn-p'),T:conn===d.id?'Connected':'Connect',onclick:function(){if(conn!==d.id)v.postMessage({type:'test-connection',deviceId:d.id})}}));
  ro.appendChild(E('button',{class:'btn btn-xs '+(conn===d.id?'btn-d':'btn-m'),T:'DC',onclick:function(){if(conn===d.id){v.postMessage({type:'disconnect',deviceId:d.id});conn='';busy=false;R()}}}));
  ro.appendChild(E('button',{class:'btn btn-xs '+(busy?'btn-m':'btn-p'),T:busy?'Running...':'Debug',onclick:function(){if(!busy){sel=d.id;sd(d.id);}}}));
  ro.appendChild(E('button',{class:'btn btn-xs btn-m',T:'Edit',onclick:function(){ed=d;fs={n:d.name,h:d.host,u:d.sshUser,p:String(d.sshPort),pw:'',sp:'',g:d.gdbPath};sf=true;R()}}));
  ro.appendChild(E('button',{class:'btn btn-xs btn-d',T:'Del',onclick:function(){v.postMessage({type:'delete-device',id:d.id})}}));c.appendChild(ro);r.appendChild(c)});
  r.appendChild(E('button',{class:'btn btn-p',T:'+ Add Device',onclick:function(){ed=null;fs={n:'',h:'',u:'root',p:'22',pw:'',sp:'',g:'/usr/bin/gdb-multiarch'};sf=true;R()}}));
  if(sf){var fdiv=E('div',{class:'card',S:{marginTop:'8px'}});['n','h','u','p','pw','sp','g'].forEach(function(k){fdiv.appendChild(E('label',{class:'lbl',T:k==='n'?'Name':k==='h'?'Host':k==='u'?'SSH user':k==='p'?'SSH port':k==='pw'?'SSH pw':k==='sp'?'sudo pw':'GDB path'}));fdiv.appendChild(E('input',{class:'inp',id:'df-'+k,type:k==='pw'||k==='sp'?'password':'text',value:fs[k]||''}))});var br=E('div',{class:'rw',S:{marginTop:'6px'}});br.appendChild(E('button',{class:'btn btn-p',T:'Save',onclick:function(){var o={};['n','h','u','p','pw','sp','g'].forEach(function(k){o[k]=document.getElementById('df-'+k).value});var dev={id:ed?ed.id:'',name:o.n,host:o.h,sshPort:parseInt(o.p)||22,sshUser:o.u,sshAuth:'password',gdbPath:o.g,arch:'auto',tags:[],createdAt:ed?ed.createdAt:Date.now(),updatedAt:Date.now()};v.postMessage({type:'save-device',device:dev,sshPassword:o.pw||undefined,sudoPassword:o.sp||undefined});sf=false;ed=null}}));br.appendChild(E('button',{class:'btn btn-m',T:'Cancel',onclick:function(){sf=false;ed=null;R()}}));fdiv.appendChild(br);r.appendChild(fdiv)}
  if(sel){r.appendChild(E('hr',{}));r.appendChild(E('div',{class:'hd'},[E('span',{T:'Debug Config'})]));
    var dfHdr=E('div',{class:'hd',style:{marginBottom:'6px'}});dfHdr.appendChild(E('span',{T:'Deploy files'}));if(deploy.length){var ae=deploy.every(function(f){return f.enabled!==false});var dfBtns=E('span',{style:{marginLeft:'auto',display:'flex',gap:'6px'}});dfBtns.appendChild(E('button',{class:'btn btn-xs btn-p',T:ae?'Disable All':'Enable All',onclick:function(){deploy.forEach(function(f){f.enabled=!ae});R()}}));dfBtns.appendChild(E('button',{class:'btn btn-xs btn-d',S:{marginLeft:'8px'},T:'Delete All',onclick:function(){deploy=[];R()}}));dfHdr.appendChild(dfBtns)}r.appendChild(dfHdr);
    deploy.forEach(function(f,i){var row=E('div',{class:'pair'});row.appendChild(E('input',{type:'checkbox',checked:f.enabled!==false,style:'width:auto;margin:0',onchange:function(){f.enabled=this.checked}}));row.appendChild(E('input',{class:'inp',placeholder:'Source path',value:f.localPath,oninput:function(){f.localPath=this.value}}));row.appendChild(E('span',{T:'→'}));row.appendChild(E('input',{class:'inp',placeholder:'Remote path',value:f.remotePath,oninput:function(){f.remotePath=this.value}}));row.appendChild(E('button',{class:'btn btn-xs btn-d',T:'−',onclick:function(){deploy.splice(i,1);R()}}));r.appendChild(row)});
    r.appendChild(E('button',{class:'btn btn-xs btn-p',T:'+ Add file',onclick:function(){deploy.push({localPath:'',remotePath:'',chmod:true,enabled:true});R()}}));
    var dtHdr=E('div',{class:'hd',style:{marginBottom:'6px'}});dtHdr.appendChild(E('span',{T:'Debug targets'}));if(targets.length){var ae2=targets.every(function(t){return t.debug!==false});var dtBtns=E('span',{style:{marginLeft:'auto',display:'flex',gap:'6px'}});dtBtns.appendChild(E('button',{class:'btn btn-xs btn-p',T:ae2?'Disable All':'Enable All',onclick:function(){targets.forEach(function(t){t.debug=!ae2});R()}}));dtBtns.appendChild(E('button',{class:'btn btn-xs btn-d',S:{marginLeft:'8px'},T:'Delete All',onclick:function(){targets=[];R()}}));dtHdr.appendChild(dtBtns)}r.appendChild(dtHdr);
    targets.forEach(function(t,i){var card=E('div',{class:'card'});var hdr=E('div',{class:'row'});hdr.appendChild(E('input',{type:'checkbox',checked:t.debug!==false,style:'width:auto;margin:0',onchange:function(){t.debug=this.checked}}));hdr.appendChild(E('input',{class:'inp',placeholder:'Process name',value:t.processName,oninput:function(){t.processName=this.value},style:{flex:'1'}}));hdr.appendChild(E('input',{class:'inp',placeholder:'Binary path',value:t.binaryPath||'',oninput:function(){t.binaryPath=this.value},style:{flex:'2'}}));hdr.appendChild(E('button',{class:'btn btn-xs btn-d',T:'−',onclick:function(){targets.splice(i,1);R()}}));card.appendChild(hdr);card.appendChild(E('input',{class:'inp',placeholder:'Start command',value:t.startCommand||'',oninput:function(){t.startCommand=this.value},style:{marginTop:'4px'}}));card.appendChild(E('input',{class:'inp',placeholder:'Env vars (KEY=VALUE per line)',value:t.envVarsStr||'',oninput:function(){t.envVarsStr=this.value}}));r.appendChild(card)});
    r.appendChild(E('button',{class:'btn btn-xs btn-p',T:'+ Add target',onclick:function(){targets.push({processName:'',debug:true,useSudo:false});R()}}));
    var rlHdr=E('div',{class:'hd',style:{marginBottom:'6px'}});rlHdr.appendChild(E('span',{T:'Remote logs'}));if(rlogs.length){rlHdr.appendChild(E('button',{class:'btn btn-xs btn-d',S:{marginLeft:'8px'},T:'Delete All',onclick:function(){rlogs=[];R()}}))}r.appendChild(rlHdr);
    rlogs.forEach(function(p,i){var row=E('div',{class:'pair'});row.appendChild(E('input',{class:'inp',placeholder:'Remote log path, e.g. /var/log/app.log',value:p,oninput:function(){rlogs[i]=this.value}}));row.appendChild(E('button',{class:'btn btn-xs btn-d',T:'−',onclick:function(){rlogs.splice(i,1);R()}}));r.appendChild(row)});
    r.appendChild(E('button',{class:'btn btn-xs btn-p',T:'+ Add log path',onclick:function(){rlogs.push('');R()}}));
  }
  if(sessions.length){r.appendChild(E('hr',{}));r.appendChild(E('div',{class:'hd'},[E('span',{T:'Sessions'})]));sessions.forEach(function(s){var st=s.status;var dot=st==='running'?'dot-on':st==='error'?'dot-err':'dot-off';r.appendChild(E('div',{class:'sess'},[E('span',{class:'dot '+dot}),E('span',{class:'name',T:s.targetName}),E('span',{class:'info',T:st+' | PID:'+(s.pid||'?')+' | bp:'+s.breakpointCount})]))});}
}
function sd(did){if(busy)return;busy=true;R();var tg=targets.filter(function(t){return t.processName&&t.debug!==false}).map(function(t){var ev=undefined;if(t.envVarsStr){ev={};t.envVarsStr.split(/\\n|\\r\\n|\\r/).forEach(function(l){var p=l.indexOf('=');if(p>0)ev[l.slice(0,p).trim()]=l.slice(p+1).trim()})}return{processName:t.processName,debug:!!t.debug,useSudo:!!t.useSudo,binaryPath:t.binaryPath,startCommand:t.startCommand,envVars:ev}});var df=deploy.filter(function(f){return f.localPath&&f.remotePath&&f.enabled!==false});v.postMessage({type:'start-debug',config:{deviceId:did||sel,mode:'restart-and-debug',restartCommand:'',useSudoForRestart:false,targets:tg,envVars:{},timeout:30,preBuildCommand:'',deployFiles:df.map(function(f){return{localPath:f.localPath,remotePath:f.remotePath,chmod:true}}),remoteLogPaths:rlogs.filter(function(p){return p})}});}

function RS(r){
  if(!stats||!stats.processes||!stats.processes.length){
    var noSessions=sessions.filter(function(s){return s.status==='running'||s.status==='pending'}).length===0;
    r.appendChild(E('div',{style:{textAlign:'center',padding:'36px 0',color:'var(--ds)',fontSize:'12px'}},['No active sessions. Start debugging to see process stats.']));return
  }
  stats.processes.forEach(function(p){
    var card=E('div',{class:'card'});
    var hdr=E('div',{class:'card-row',style:{marginBottom:'4px'}});
    hdr.appendChild(E('span',{style:{fontWeight:'600',fontSize:'12px',flex:'1'},T:p.processName}));
    hdr.appendChild(E('span',{style:{fontSize:'10px',color:'var(--ds)'},T:'PID:'+p.pid}));
    card.appendChild(hdr);
    var rows=[['CPU',p.cpuPercent+'%',p.cpuPercent>80?'#e5534b':p.cpuPercent>60?'#e3b341':'#57ab5a'],
              ['RSS',rssStr(p.rssMB),'var(--fg)'],
              ['VSZ',p.vszMB+' MB','var(--fg)'],
              ['Threads',String(p.threadCount),'var(--fg)'],
              ['State',p.state,'var(--fg)']];
    if(p.gpuPercent!==undefined)rows.push(['GPU',p.gpuPercent+'%',p.gpuPercent>80?'#e5534b':p.gpuPercent>60?'#e3b341':'#57ab5a']);
    rows.forEach(function(rr){
      var row=E('div',{class:'rw',style:{marginBottom:'2px',fontSize:'11px'}});
      row.appendChild(E('span',{style:{color:'var(--ds)',minWidth:'56px'},T:rr[0]}));
      row.appendChild(E('span',{style:{color:rr[2],fontWeight:'600'},T:rr[1]}));
      card.appendChild(row);
    });
    r.appendChild(card);
  });
  r.appendChild(E('div',{style:{fontSize:'10px',color:'var(--ds)',textAlign:'center',marginTop:'12px'}},['Updated: '+new Date(stats.ts).toLocaleTimeString()]));
}
function rssStr(mb){return mb<1?(mb*1024).toFixed(0)+' KB':mb<1024?mb.toFixed(1)+' MB':(mb/1024).toFixed(1)+' GB'}
function RLk(r){
  if(!leak||!leak.current){
    r.appendChild(E('div',{style:{textAlign:'center',padding:'36px 0',color:'var(--ds)',fontSize:'12px'}},['No leak data. Start monitoring to establish a baseline.']));return
  }
  var riskColors={none:'#57ab5a',low:'#57ab5a',medium:'#e3b341',high:'#e5534b'};
  var card=E('div',{class:'card'});
  var hdr=E('div',{class:'card-row',style:{marginBottom:'6px'}});
  hdr.appendChild(E('span',{style:{fontWeight:'600',fontSize:'12px',flex:'1'},T:leak.processName}));
  hdr.appendChild(E('span',{style:{fontSize:'10px',color:'var(--ds)'},T:'PID:'+leak.pid}));
  card.appendChild(hdr);
  // Risk indicator
  var rb=E('div',{class:'rw',style:{marginBottom:'8px'}});
  rb.appendChild(E('span',{style:{fontSize:'10px',color:'var(--ds)'},T:'Risk:'}));
  rb.appendChild(E('span',{style:{fontSize:'11px',fontWeight:'700',color:riskColors[leak.risk]},T:leak.risk.toUpperCase()}));
  card.appendChild(rb);
  // Memory breakdown
  var items=[['Heap',leak.current.heapKB+' KB',leak.baseline?(leak.current.heapKB-leak.baseline.heapKB)+' KB':'—'],
             ['Stack',leak.current.stackKB+' KB',''],
             ['Data',leak.current.dataKB+' KB',''],
             ['RSS',leak.current.rssKB+' KB',leak.baseline?(leak.current.rssKB-leak.baseline.rssKB)+' KB':'—'],
             ['VSZ',leak.current.vszKB+' KB',''],
             ['Heap Δ',(leak.heapDeltaKB>0?'+':'')+leak.heapDeltaKB+' KB',''],
             ['RSS Rate',(leak.rssGrowthRate>0?'+':'')+leak.rssGrowthRate.toFixed(1)+' KB/s','']];
  items.forEach(function(it){
    var row=E('div',{class:'rw',style:{marginBottom:'2px',fontSize:'11px'}});
    row.appendChild(E('span',{style:{color:'var(--ds)',minWidth:'56px'},T:it[0]}));
    row.appendChild(E('span',{style:{fontWeight:'600'},T:it[1]}));
    if(it[2])row.appendChild(E('span',{style:{fontSize:'10px',color:'var(--ds)',marginLeft:'6px'},T:'(Δ '+it[2]+')'}));
    card.appendChild(row);
  });
  r.appendChild(card);
  // Guide to locate leak source
  if(leak.risk!=='none'){
    var guide=E('div',{class:'card',style:{marginTop:'8px',background:leak.risk==='high'?'#3d1a1a':'#3d3510'}});
    guide.appendChild(E('div',{style:{fontWeight:'600',fontSize:'11px',marginBottom:'4px',color:leak.risk==='high'?'#e5534b':'#e3b341'},T:'Leak Source Trace'}));
    guide.appendChild(E('div',{style:{fontSize:'10px',color:'var(--fg)',lineHeight:'1.5'},H:'Run these in <b>Debug Console</b>:<br><br><code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">!break malloc</code><br><code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">!commands</code><br><code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">silent</code> &nbsp;<code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">bt 3</code> &nbsp;<code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">continue</code><br><code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">end</code><br><code style=\"background:var(--bg);padding:2px 5px;border-radius:3px\">!continue</code><br><br>Each malloc() call prints filename + line number.'}));
    r.appendChild(guide);
  }
  r.appendChild(E('div',{style:{fontSize:'10px',color:'var(--ds)',textAlign:'center',marginTop:'12px'}},['Samples: '+leak.sampleCount+' | Updated: '+new Date(leak.current.ts).toLocaleTimeString()]));
}
function Tr(r){
  var hd=E('div',{class:'hd'});hd.appendChild(E('span',{T:'Perfetto Trace Capture'}));r.appendChild(hd);
  var card=E('div',{class:'card'});
  card.appendChild(E('label',{class:'lbl',T:'Duration (seconds)'}));
  card.appendChild(E('input',{class:'inp',type:'number',value:'10',id:'trace-dur',style:{marginBottom:'8px'}}));
  card.appendChild(E('label',{class:'lbl',T:'Start command (optional, runs on remote after trace begins)'}));
  card.appendChild(E('input',{class:'inp',placeholder:'Optional: command to run on remote after trace starts',id:'trace-cmd',style:{marginBottom:'8px'}}));
  var row=E('div',{class:'row',style:{alignItems:'center',gap:'8px',marginBottom:'8px'}});
  row.appendChild(E('label',{class:'lbl',style:{display:'flex',alignItems:'center',gap:'4px'}},['Use sudo',E('input',{type:'checkbox',id:'trace-sudo',checked:true})]));
  row.appendChild(E('button',{class:'btn btn-p',T:traceBusy?'Capturing...':'Start Capture',disabled:traceBusy,onclick:function(){
    if(traceBusy)return;traceBusy=true;traceRes=null;R();
    var dur=parseInt(document.getElementById('trace-dur').value)||10;
    var sc=document.getElementById('trace-cmd').value;
    var su=document.getElementById('trace-sudo').checked;
    v.postMessage({type:'start-trace',duration:dur,useSudo:su,startCmd:sc||undefined});
  }}));
  card.appendChild(row);r.appendChild(card);
  if(traceRes){
    var res=E('div',{class:'card',style:{marginTop:'8px',background: traceRes.sizeBytes>0?'#1a3d1a':'#3d1a1a'}});
    res.appendChild(E('div',{style:{fontWeight:'600',fontSize:'11px',marginBottom:'4px',color:'#4caf50'},T:'Capture Complete'}));
    res.appendChild(E('div',{style:{fontSize:'11px',lineHeight:'1.6'},H:'<b>File:</b> '+traceRes.output+'<br><b>Size:</b> '+(traceRes.sizeBytes/1024).toFixed(1)+' KB<br><b>Host:</b> '+traceRes.remoteHost+'<br><b>Duration:</b> '+traceRes.durationSec+'s'}));
    res.appendChild(E('div',{style:{marginTop:'8px',fontSize:'10px',color:'var(--ds)'},T:'Drag .pftrace into https://ui.perfetto.dev to view'}));
    r.appendChild(res);
  }
}
function RL(r){
  var hd=E('div',{class:'hd'});hd.appendChild(E('span',{T:'Logs'}));hd.appendChild(E('button',{class:'btn btn-xs btn-p',T:'Clear',style:{marginLeft:'auto'},onclick:function(){logs=[];R()}}));r.appendChild(hd);
  if(rlogs.length){var sub=E('div',{class:'row',style:{marginBottom:'6px',gap:'2px',flexWrap:'wrap'}});
    sub.appendChild(E('button',{class:'btn btn-xs '+(logView==='actions'?'btn-p':'btn-m'),T:'Actions',onclick:function(){logView='actions';R()}}));
    rlogs.forEach(function(p){var n=p.split('/').pop()||p;sub.appendChild(E('button',{class:'btn btn-xs '+(logView===p?'btn-p':'btn-m'),T:n,onclick:function(){logView=p;R()}}))});
    r.appendChild(sub);if(logView==='actions')logView='actions'}
  var ld=E('div',{class:'log'});
  var rec=logView==='actions'?logs.slice(-200):logs.filter(function(l){return l.text.indexOf('['+logView.split('/').pop()+']')===0}).slice(-200);
  if(!rec.length)ld.appendChild(E('div',{style:{color:'var(--ds)',padding:'12px 0'},T:'No logs yet.'}));
  rec.forEach(function(l){ld.appendChild(E('div',{class:'l'+(l.level==='error'?'e':l.level==='success'?'s':l.level==='warn'?'w':'i'),T:'['+new Date(l.ts).toLocaleTimeString()+'] '+l.text}))});r.appendChild(ld);
}

document.addEventListener('mousemove',function(e){document.documentElement.style.setProperty('--mx',e.clientX+'px');document.documentElement.style.setProperty('--my',e.clientY+'px')});
document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){tab=t.dataset.t;document.querySelectorAll('.tab').forEach(function(x){x.className='tab'+(x===t?' on':'')});if(statsTimer){clearInterval(statsTimer);statsTimer=null}if(leakTimer){clearInterval(leakTimer);leakTimer=null}if(tab==='stats'){v.postMessage({type:'request-stats'});statsTimer=setInterval(function(){v.postMessage({type:'request-stats'})},1000)}if(tab==='leaks'){v.postMessage({type:'start-leak-monitor'});v.postMessage({type:'request-leak-scan'});leakTimer=setInterval(function(){v.postMessage({type:'request-leak-scan'})},2000)}R()}});
if(sessions.some(function(s){return s.status==='running'})&&tab==='leaks'&&!leakTimer){v.postMessage({type:'start-leak-monitor'});v.postMessage({type:'request-leak-scan'});leakTimer=setInterval(function(){v.postMessage({type:'request-leak-scan'})},2000)}
try{R();v.postMessage({type:'load-devices'});}catch(e){die('init: '+e.message)}
})();
</script></body></html>`;}
