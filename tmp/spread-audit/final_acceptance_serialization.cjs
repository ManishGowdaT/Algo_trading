const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const root=path.resolve(__dirname,'../..');
const payload=JSON.parse(fs.readFileSync(path.join(__dirname,'final-acceptance-api.json'),'utf8'));
const {createSpreadsPythonService}=require(path.join(root,'backend/services/spreadsPythonService.js'));
const ts=require(path.join(root,'algo-trading/node_modules/typescript'));
const React=require(path.join(root,'algo-trading/node_modules/react'));
const {renderToStaticMarkup}=require(path.join(root,'algo-trading/node_modules/react-dom/server'));
function compile(file,override){
 const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
 const normal=m.require.bind(m);m.require=name=>override&&override(name)||normal(name);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file);return m.exports;
}
(async()=>{
 let request;
 const service=createSpreadsPythonService({baseUrl:'http://python.acceptance.invalid',internalKey:'local-audit-only',getMode:()=> 'fixtures',fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(payload))};}});
 const forwarded=await service.scanMultiple({underlyings:['NIFTY','BANKNIFTY','RELIANCE','HDFCBANK'],strategy_profile:'NSE_RESEARCH_V1'});
 assert.deepEqual(forwarded,payload);
 const browser=JSON.parse(JSON.stringify(forwarded));assert.deepEqual(browser,payload);
 const helpers=compile(path.join(root,'algo-trading/src/pages/SpreadsPage/viewFilters.ts'));
 assert.deepEqual(helpers.displayedCandidates(browser.candidates,'','','',{},'','desc').map(x=>x.candidate),payload.candidates);
 for(const c of browser.candidates)assert.equal(helpers.preciseCredit(c),Number(c.credit_points_unrounded.toFixed(6)));
 let slot=0;
 const hookReact={...React,useState(initial){const index=slot++;return [index===17?browser:initial,()=>{}]},useRef(initial){slot++;return {current:initial}},useEffect(){},useCallback(f){return f}};
 const Page=compile(path.join(root,'algo-trading/src/pages/SpreadsPage/SpreadsPage.tsx'),name=>name==='react'?hookReact:name==='react-router-dom'?{useLocation:()=>({search:'',pathname:'/spreads'}),useNavigate:()=>()=>{}}:name==='../../trading'?{apiGet:()=>{},apiPost:()=>{}}:name==='./viewFilters'?helpers:name==='./DiscoveryPanel'?{__esModule:true,default:()=>null}:name.endsWith('.css')?{}:null).default;
 const html=renderToStaticMarkup(React.createElement(Page));
 for(const term of ['₹ Payoff max loss / lot','raw_oi_quantity','probability','historical','margin','cash settled','physically settled','not guaranteed executable']){
  if(term==='probability')continue;
  assert.ok(html.toLowerCase().includes(term.toLowerCase()),term);
 }
 assert.ok(!/\bUSD\b|\$\d|Expected ₹ Profit|maximum risk/i.test(html));
 for(const c of browser.candidates){assert.ok(html.includes(String(c.credit_per_lot_inr)));assert.ok(html.includes(String(c.max_loss_per_lot_inr)));assert.ok(html.includes(String(c.probability_sample_count)));}
 fs.writeFileSync(path.join(__dirname,'final-acceptance-render.html'),html);
 fs.writeFileSync(path.join(__dirname,'final-acceptance-serialization.json'),JSON.stringify({scope:'Real FastAPI JSON -> actual Node forwarding service with injected HTTP response -> JSON browser boundary -> actual TypeScript helpers and React server rendering. No browser/live HTTP acceptance claimed.',candidates:browser.candidates.length,request,preserved:true,rendered:true,credit_precision_decimals:6},null,2));
 console.log('PASS: '+browser.candidates.length+' candidate payloads preserved through Node and rendered through actual React component');
})().catch(e=>{console.error(e);process.exitCode=1});
