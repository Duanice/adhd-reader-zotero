import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import * as sharedGlyphMetrics from '../src/glyph-metrics.js';

const source = await readFile(new URL('../addon/bootstrap.js', import.meta.url), 'utf8');
const host = { initializationPromise: Promise.resolve(), Prefs: { get() { return undefined; } }, Reader: { registerEventListener() {}, unregisterEventListener() {} }, logError: console.error };
const context = vm.createContext({ Zotero: host, console, sharedGlyphMetrics });
vm.runInContext(source, context);
vm.runInContext('glyphMetrics = sharedGlyphMetrics', context);
const { makeRows, makePageLayout, classifyReadingRows, focusBox, closestRow, GuideSession } = vm.runInContext('({makeRows, makePageLayout, classifyReadingRows, focusBox, closestRow, GuideSession})', context);
const viewport = { transform: [1, 0, 0, -1, 0, 800], scale: 1, rotation: 0, width: 600, height: 800, convertToPdfPoint: (x, y) => [x, 800 - y] };
const item = (str, x, y, width = 180) => ({ str, transform: [12, 0, 0, 12, x, y], width });
const columnContent = () => ['first', 'second', 'third'].flatMap((ordinal, index) => [
  item(`Left ${ordinal} paragraph sentence`, 50, 700 - index * 20),
  item(`Right ${ordinal} paragraph sentence`, 350, 700 - index * 20),
]);

test('two-column text proceeds down one column before the next', () => {
  const rows = makeRows([item('Title', 50, 760, 500), ...columnContent()], viewport);
  assert.deepEqual(Array.from(rows, r => r.text), ['Title', ...['Left', 'Right'].flatMap(side =>
    ['first', 'second', 'third'].map(ordinal => `${side} ${ordinal} paragraph sentence`))]);
});

test('click hit testing uses both axes and picks the clicked column', () => {
  const rows = makeRows(columnContent(), viewport);
  assert.equal(rows[closestRow(rows, 420, 96)].text, 'Right first paragraph sentence');
  assert.equal(rows[closestRow(rows, 80, 96)].text, 'Left first paragraph sentence');
});

test('three continuous paragraph columns remain separate before physical-row grouping', () => {
  const content = [0, 1, 2].flatMap(row => [50, 240, 430].map((x, column) => ({
    str: `Column ${column + 1} paragraph sentence ${row + 1}`, width: 120,
    transform: [10, 0, 0, 10, x, 700 - row * 20],
  })));
  const expected = [1, 2, 3].flatMap(column => [1, 2, 3].map(row => `Column ${column} paragraph sentence ${row}`));
  for (const scale of [.6, 1.35, 2.07]) {
    const transforms = [[scale, 0, 0, -scale, 0, 800 * scale], [0, scale, scale, 0, 0, 0],
      [-scale, 0, 0, scale, 600 * scale, 0], [0, -scale, -scale, 0, 800 * scale, 600 * scale]];
    for (const [rotation, transform] of transforms.entries()) {
      const view = { ...viewport, width: (rotation % 2 ? 800 : 600) * scale,
        height: (rotation % 2 ? 600 : 800) * scale, transform };
      const rows = makeRows(content, view);
      assert.deepEqual(Array.from(rows, row => row.text), expected, `three columns at rotation ${rotation * 90}, scale ${scale}`);
    }
  }
});

test('text chunks in the same line merge; whitespace is ignored', () => {
  const rows = makeRows([item('one', 50, 700, 30), item('two', 85, 700, 30), item(' ', 120, 700, 4)], viewport);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'one two');
});

function navigationHarness(pageLines = [[40, 100, 300], [40, 100, 300]], { cached = true, pageHeight = 400, motion = false } = {}) {
  const selection = { isCollapsed:true, toString:()=>'', removeAllRanges() { throw Error('Guide must not change selections'); } };
  const handlers = new Map(), viewport = { width:600,height:pageHeight,scale:1,rotation:0,transform:[1,0,0,-1,0,pageHeight],convertToPdfPoint:(x,y)=>[x,pageHeight-y] };
  const all = pageLines.map((lines,page) => makeRows(lines.map((y,index)=>item(`Page ${page} row ${index}`,50,pageHeight-y,300)),viewport));
  const scrolls = [], hostNavigation = [];
  const container = { scrollTop:0,scrollLeft:0,clientWidth:600,clientHeight:180,scrollWidth:600,scrollHeight:pageLines.length*(pageHeight+40),clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:0,top:0,right:600,bottom:180}),
    scrollTo({top=this.scrollTop,left=this.scrollLeft}) {this.scrollTop=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));this.scrollLeft=left;scrolls.push({top:this.scrollTop,left});queueMicrotask(()=>session.onViewportChange());} };
  let actualTop = 0;
  Object.defineProperty(container, 'scrollTop', { get:()=>actualTop, set:value=>{actualTop=value;queueMicrotask(()=>session.onViewportChange());} });
  const pageViews = pageLines.map((_,page)=>({viewport,pdfPage:{pageNumber:page+1},div:{clientWidth:600,clientHeight:pageHeight,clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:0,top:page*(pageHeight+40)-container.scrollTop,right:600,bottom:(page+1)*pageHeight+page*40-container.scrollTop})}}));
  const app = { pdfDocument:{numPages:pageLines.length}, eventBus:{on(name,fn){handlers.set(`bus:${name}`,fn);},off(){}}, pdfViewer:{container,currentPageNumber:1,getPageView:index=>pageViews[index],
    _getVisiblePages:()=>({views:pageViews.flatMap((view,index)=>{const r=view.div.getBoundingClientRect();return r.bottom>0&&r.top<180?[{id:index+1,view}]:[];})}),
    scrollPageIntoView(){throw Error('Must not use PDFViewer page-number navigation');} } };
  const doc={getSelection:()=>selection,getElementById:name=>name==='viewerContainer'?container:null,
    createElement:()=>({style:{},setAttribute(){},remove(){}}),body:{append(){}},addEventListener:(name,fn)=>handlers.set(`doc:${name}`,fn),removeEventListener(){}};
  let clock=0, frameID=0;const frames=new Map();
  const win={document:doc,innerWidth:600,innerHeight:180,PDFViewerApplication:app,focus(){win.focusCount=(win.focusCount||0)+1;},
    performance:{now:()=>clock},matchMedia:()=>({matches:!motion}),
    requestAnimationFrame(callback){frames.set(++frameID,callback);return frameID;},cancelAnimationFrame(id){frames.delete(id);},
    addEventListener:(name,fn)=>handlers.set(`win:${name}`,fn),removeEventListener(){}};
  const view={_iframeWindow:win,_selectionRanges:[],navigateToPosition(position){hostNavigation.push(position);throw Error('Native page wrapper may be unrendered');}};
  const core={_primaryView:view,_state:{tool:{type:'pointer'},selectedAnnotationIDs:[],colorScheme:'auto'},setColorScheme(value){core._state.colorScheme=value;}};
  const session=new GuideSession({_internalReader:core},doc);session.win=win;session.app=app;session.overlay={style:{},remove(){this.removed=true;}};session.enabled=true;
  session.pageData=new Map();
  if(cached)all.forEach((rows,index)=>session.pageData.set(index,{rows,viewport,excludedRows:[]}));
  const load=async page=>{const rows=all[page]||[];session.pageData.set(page,{rows,viewport,excludedRows:[]});return rows;};session.rows=load;
  session.selectFocus(all[0].length?{page:0,index:0}:null);
  session.lastScrollPosition=session.scrollPosition();
  const event=(key,overrides={})=>({key,target:{closest:()=>null},prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...overrides});
  const frame=async(dt=16)=>{clock+=dt;const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(clock);await flush();};
  const settle=async()=>{for(let i=0;i<100&&frames.size;i++)await frame();assert.equal(frames.size,0,'animation settles within bounded frames');};
  return {session,container,pageViews,all,load,scrolls,hostNavigation,selection,view,core,win,doc,handlers,event,viewport,frame,settle,frames};
}
const flush = async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('native guide crosses page boundaries using actual container geometry and keeps the whole unit visible', async()=>{
  const h=navigationHarness();h.session.selectFocus({page:0,index:2});h.container.scrollTop=240;h.session.lastScrollPosition=h.session.scrollPosition();
  assert.equal(await h.session.move(1),true);
  assert.deepEqual({...h.session.current},{page:1,index:0});
  assert.ok(h.container.scrollTop>240);assert.ok(h.session.fullyVisible(h.session.screenBox()));
  const entered = h.session.screenBox();
  assert.ok(Math.abs((entered.top + entered.bottom) / 2 - h.container.clientHeight * .43) < .5, 'page entry leaves readable context below the guide');
  assert.equal(h.session.overlay.style.display,'block');assert.equal(h.hostNavigation.length,0);
  await h.session.move(-1);assert.deepEqual({...h.session.current},{page:0,index:2});assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('a next row that is already fully visible does not reposition the PDF',async()=>{
  const h=navigationHarness();await h.session.move(1);
  assert.equal(h.session.current.index,1);assert.equal(h.container.scrollTop,0);assert.equal(h.scrolls.length,0);
});

test('rapid keyboard input is queued without dropping steps or cancelling on its own scroll events',async()=>{
  const h=navigationHarness([[40,100,300],[40,100,300],[40,100,300]]);
  let release;const gate=new Promise(resolve=>{release=resolve;});let first=true;
  h.session.rows=async page=>{if(first){first=false;await gate;}return h.load(page);};
  const requests=Array.from({length:8},()=>h.session.move(1));
  release();assert.ok((await Promise.all(requests)).every(Boolean));
  assert.deepEqual({...h.session.current},{page:2,index:2});
  const position=h.container.scrollTop;assert.equal(await h.session.move(1),false);assert.equal(h.container.scrollTop,position);
});

test('same-page automatic scrolling starts near the lower safe zone and eases by a small distance',async()=>{
  const h=navigationHarness([[40,150,300]],{motion:true});
  await h.session.move(1);
  assert.equal(h.session.current.index,1);assert.equal(h.container.scrollTop,0);
  assert.equal(h.session.scrollMotion.active,true);
  const target=h.session.scrollMotion.target.top;
  assert.ok(target>0&&target<h.container.clientHeight*.4,'same-page follow uses a short motion');
  await h.frame(80);
  assert.ok(h.container.scrollTop>0&&h.container.scrollTop<target,'the PDF moves through an intermediate position');
  assert.equal(h.session.current.index,1);assert.equal(h.session.overlay.style.display,'block');
  await h.settle();assert.equal(h.session.scrollMotion.active,false);
  assert.ok(Math.abs(h.container.scrollTop-target)<1);assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('native continuous reading stays near the middle with multi-line pauses between scrolls',async()=>{
  const h=navigationHarness([Array.from({length:40},(_,index)=>200+index*10)],{pageHeight:900,motion:true});
  const center=()=>{const r=h.session.screenBox();return(r.top+r.bottom)/2/h.container.clientHeight;};
  const records=[];
  for(const [index,direction]of [[8,1],[30,-1]]){
    h.session.selectFocus({page:0,index});const r=h.session.screenBox();h.container.scrollTop+=(r.top+r.bottom)/2-h.container.clientHeight*.5;await flush();
    const samples=[];let prior=h.container.scrollTop;
    for(let step=0;step<16;step++){
      await h.session.move(direction);await h.settle();samples.push({ratio:center(),moved:Math.abs(h.container.scrollTop-prior)>1});prior=h.container.scrollTop;
    }
    records.push(samples);
    assert.ok(samples.every(s=>s.ratio>=.35&&s.ratio<=.57),'every completed step remains in the earlier middle comfort band');
    assert.ok(samples.filter(s=>s.moved).length<=8,'the page does not move on each line');
    assert.ok(samples.some((s,i)=>i&&!s.moved&&!samples[i-1].moved),'several consecutive rows are read in a stationary viewport');
    assert.ok(Math.max(...samples.map(s=>s.ratio))-Math.min(...samples.map(s=>s.ratio))>.1,'reading is not pinned to a single height');
  }
  assert.ok(records[0].filter(s=>s.moved).every(s=>Math.abs(s.ratio-.43)<.02));
  assert.ok(records[1].filter(s=>s.moved).every(s=>Math.abs(s.ratio-.49)<.02));
});

test('native same-page column transitions use reading direction rather than geometric vertical direction',async()=>{
  const h=navigationHarness([[]],{pageHeight:900,motion:true});
  const content=Array.from({length:8},(_,index)=>['Left','Right'].map((side,column)=>item(`${side} column paragraph sentence ${index}`,50+column*300,800-index*45,180))).flat();
  const rows=makeRows(content,h.viewport);assert.equal(rows.length,16);h.all[0]=rows;await h.load(0);
  h.session.selectFocus({page:0,index:7});const old=h.session.screenBox();h.container.scrollTop+=(old.top+old.bottom)/2-h.container.clientHeight*.43;await flush();
  await h.session.move(1);await h.settle();assert.equal(h.session.current.index,8);
  let box=h.session.screenBox();assert.ok(Math.abs((box.top+box.bottom)/2/h.container.clientHeight-.43)<.01,'forward column entry returns to the forward reading height');
  await h.session.move(-1);await h.settle();assert.equal(h.session.current.index,7);
  box=h.session.screenBox();assert.ok(Math.abs((box.top+box.bottom)/2/h.container.clientHeight-.49)<.01,'backward column entry returns to the backward reading height');
});

test('animated cross-page movement retains its logical cursor until the target becomes visible',async()=>{
  const h=navigationHarness(undefined,{motion:true});h.session.selectFocus({page:0,index:2});h.container.scrollTop=240;h.session.lastScrollPosition=h.session.scrollPosition();
  await h.session.move(1);
  assert.deepEqual({...h.session.current},{page:1,index:0});assert.equal(h.container.scrollTop,240);
  assert.equal(h.session.scrollMotion.active,true);assert.equal(h.session.overlay.style.display,'block');
  await h.frame(32);await h.session.followVisible();
  assert.deepEqual({...h.session.current},{page:1,index:0},'an intermediate viewport cannot replace the destination');
  await h.settle();const box=h.session.screenBox();
  assert.ok(h.session.fullyVisible(box));assert.ok(Math.abs((box.top+box.bottom)/2-h.container.clientHeight*.43)<1);
});

test('rapid keys retarget one animation without waiting, dropping steps or following an old visible line',async()=>{
  const h=navigationHarness([[40,100,300],[40,100,300],[40,100,300]],{motion:true});
  const results=await Promise.all(Array.from({length:8},()=>h.session.move(1)));
  assert.ok(results.every(Boolean));assert.deepEqual({...h.session.current},{page:2,index:2});
  assert.equal(h.container.scrollTop,0,'logical key handling does not wait for animation');
  assert.equal(h.frames.size,1,'only one animation loop remains scheduled');
  const owner=h.session.operation;await h.frame(64);await h.session.followVisible();
  assert.equal(h.session.operation,owner,'the animation scroll event does not cancel navigation');
  assert.deepEqual({...h.session.current},{page:2,index:2});
  await h.settle();assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('reverse input retargets the future viewport so the previous distant destination cannot hide the new line',async()=>{
  const h=navigationHarness(undefined,{motion:true});
  await h.session.move(1);await h.session.move(1);assert.equal(h.session.scrollMotion.active,true);
  const distant=h.session.scrollMotion.target.top;
  await h.session.move(-1);
  assert.equal(h.session.current.index,1);
  assert.ok((h.session.scrollMotion.target?.top??h.container.scrollTop)<distant,'reversal replaces or cancels the distant destination');
  await h.settle();assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('a forward key preserves an in-flight destination when the new line fits its future safe zone',async()=>{
  const h=navigationHarness([[40,150,165,300]],{motion:true});
  await h.session.move(1);const target=h.session.scrollMotion.target.top;await h.frame(80);
  await h.session.move(1);
  assert.equal(h.session.current.index,2);assert.equal(h.session.scrollMotion.target.top,target);
  await h.settle();assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('manual scroll during animation stops its future frames and preserves the user position',async()=>{
  const h=navigationHarness(undefined,{motion:true});await h.session.move(1);await h.session.move(1);await h.frame(80);
  h.container.scrollTop=25;h.session.onViewportChange();await flush();
  assert.equal(h.session.scrollMotion.active,false);
  await h.settle();assert.equal(h.container.scrollTop,25);assert.equal(h.session.overlay.style.display,'block');
});

test('wheel, touch, pointer and resize listeners cancel animation before further programmatic movement',async()=>{
  for(const name of ['win:wheel','win:touchstart','doc:pointerdown','win:resize']){
    const h=navigationHarness(undefined,{motion:true});h.session.win=null;await h.session.attach();
    h.session.selectFocus({page:0,index:0});await h.load(0);await h.session.move(1);await h.session.move(1);await h.frame(64);
    const position=h.container.scrollTop;h.handlers.get(name)({button:0,clientX:50,clientY:100});await flush();
    assert.equal(h.session.scrollMotion.active,false,name);await h.settle();assert.equal(h.container.scrollTop,position,name);
  }
});

test('cancel, scale invalidation, hidden tabs and unload prevent already queued animation callbacks from writing',async()=>{
  for(const change of ['cancel','scale','hidden','unload']){
    const h=navigationHarness(undefined,{motion:true});await h.session.move(1);await h.session.move(1);
    const stale=[...h.frames.values()];
    if(change==='cancel')h.session.cancelNavigation();
    if(change==='scale'){h.session.layoutEpoch++;h.session.cancelNavigation();}
    if(change==='hidden'){h.session.reader.tabID='one';h.session.reader._window={Zotero_Tabs:{selectedID:'other'}};}
    if(change==='unload')h.session.dispose();
    for(const callback of stale)callback(100);await h.settle();
    assert.equal(h.container.scrollTop,0,change);assert.equal(h.win.focusCount,2,change);
  }
});

test('reduced-motion preference completes automatic movement without scheduling animation frames',async()=>{
  const h=navigationHarness();await h.session.move(1);await h.session.move(1);
  assert.equal(h.session.current.index,2);assert.equal(h.frames.size,0);assert.equal(h.session.scrollMotion.active,false);
  assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('manual browsing preserves the locked row offscreen and reveals that same aperture on return',async()=>{
  const h=navigationHarness();h.session.paint();h.container.scrollTop=20;h.session.onViewportChange();await flush();
  assert.equal(h.session.current.index,0);assert.equal(h.scrolls.length,0);
  h.container.scrollTop=70;h.session.onViewportChange();await flush();
  assert.equal(h.session.current.index,0);assert.equal(h.container.scrollTop,70);assert.equal(h.scrolls.length,0);
  assert.equal(h.session.overlay.style.height,'0px');
  for(const top of [240,470,30]){
    h.container.scrollTop=top;h.session.onViewportChange();await flush();
    assert.equal(h.session.current.index,0);assert.equal(h.container.scrollTop,top);
  }
  assert.ok(parseFloat(h.session.overlay.style.height)>0);
  assert.equal(h.session.overlay.style.display,'block');
});

test('manual scrolling keeps the active column when another column has a slightly higher visible row',async()=>{
  const h=navigationHarness();
  const left=makeRows([40,70,100].map((y,index)=>item(`Left column row ${index}`,50,400-y,180)),h.viewport);
  const right=makeRows([40,60,90].map((y,index)=>item(`Right column row ${index}`,350,400-y,180)),h.viewport);
  for(const row of left){row.regionId='left-flow';row.flowId='left-flow';row.regionBounds={x:50,y:20,width:180,height:100};}
  for(const row of right){row.regionId='right-flow';row.flowId='right-flow';row.regionBounds={x:350,y:20,width:180,height:100};}
  const rows=[...left,...right];h.session.pageData.set(0,{rows,viewport:h.viewport,excludedRows:[]});h.session.rows=async()=>rows;
  h.session.selectFocus({page:0,index:0});h.session.paint();h.container.scrollTop=46;h.session.onViewportChange();await flush();
  assert.equal(h.session.current.index,0,'the original left row remains locked even after leaving the viewport');
  assert.equal(h.container.scrollTop,46,'manual scrolling is not repositioned');
  h.session.selectFocus({page:0,index:3});h.session.paint();h.container.scrollTop=76;h.session.onViewportChange();await flush();
  assert.equal(h.session.current.index,3,'browsing also preserves the exact selected right row');
});

test('pending visible-page text and empty pages keep the dimming mask without pulling the scroll position',async()=>{
  const h=navigationHarness([[40,100],[],[40,100]],{cached:false});await h.load(0);h.session.paint();
  h.container.scrollTop=470;
  let loads=0;h.session.rows=async page=>{loads++;return h.load(page);};
  await h.session.followVisible();
  assert.equal(h.session.overlay.style.display,'block');assert.equal(h.session.overlay.style.width,'0px');
  assert.equal(loads,0,'browsing does not request a replacement reading row');
  assert.deepEqual({...h.session.current},{page:0,index:0});
  assert.equal(h.container.scrollTop,470);assert.equal(h.scrolls.length,0);assert.equal(h.session.overlay.style.display,'block');
});

test('keys resume the locked row after browsing a blank page, while a new session can initialize there',async()=>{
  for(const current of [{page:0,index:0},null])for(const delta of [1,-1]){
    const h=navigationHarness([[40,100],[],[40,100]]);h.session.selectFocus(current);h.container.scrollTop=470;h.session.lastScrollPosition=h.session.scrollPosition();
    await h.session.followVisible();await h.session.move(delta);
    const expected=current?{page:0,index:delta>0?1:0}:delta>0?{page:2,index:0}:{page:0,index:1};
    assert.deepEqual({...h.session.current},expected);assert.ok(h.session.fullyVisible(h.session.screenBox()));
  }
});

test('Enter after browsing resumes the locked source row without waiting for unrelated visible-page text',async()=>{
  const h=navigationHarness([[40,100],[40,100],[40,100]],{cached:false});await h.load(0);h.container.scrollTop=470;h.session.lastScrollPosition=h.session.scrollPosition();
  let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{if(page===1)await gate;return h.load(page);};
  const follow=h.session.followVisible(), move=h.session.move(1);release();await Promise.all([follow,move]);
  assert.deepEqual({...h.session.current},{page:0,index:1});assert.ok(h.container.scrollTop<440);assert.ok(h.session.intersects(h.session.screenBox()));
});

test('navigation skips empty pages and stops at the document boundaries',async()=>{
  const h=navigationHarness([[40],[],[],[40]]);
  await h.session.move(1);assert.deepEqual({...h.session.current},{page:3,index:0});
  assert.equal(await h.session.move(1),false);
  await h.session.move(-1);assert.deepEqual({...h.session.current},{page:0,index:0});assert.equal(await h.session.move(-1),false);
});

test('manual scrolling cancels an in-flight page transition and its queued keys',async()=>{
  const h=navigationHarness();h.session.selectFocus({page:0,index:2});h.container.scrollTop=240;h.session.lastScrollPosition=h.session.scrollPosition();
  let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{if(page===1)await gate;return h.load(page);};
  const first=h.session.move(1),second=h.session.move(1);await flush();
  h.session.cancelNavigation();h.container.scrollTop=40;h.session.onViewportChange();await flush();
  const position={...h.session.current};release();assert.deepEqual(await Promise.all([first,second]),[false,false]);await flush();
  assert.deepEqual({...h.session.current},position);assert.equal(h.container.scrollTop,40);assert.equal(h.scrolls.length,0);
});

test('a delayed click is discarded if its screen coordinates move before text resolves',async()=>{
  const h=navigationHarness();let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{await gate;return h.load(page);};
  const click=h.session.chooseAt(0,80,96);h.container.scrollTop=20;h.session.onViewportChange();release();
  assert.equal(await click,false);assert.equal(h.session.current.index,0);
});

test('a delayed click is discarded when resize moves a centered page without scrolling',async()=>{
  const h=navigationHarness();let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{await gate;return h.load(page);};
  const click=h.session.chooseAt(0,80,96), original=h.pageViews[0].div.getBoundingClientRect;
  h.pageViews[0].div.getBoundingClientRect=()=>({...original(),left:35,right:635});release();
  assert.equal(await click,false);assert.equal(h.session.current.index,0);
});

test('excluded table whitespace cannot capture a nearby caption or replace the locked source',async()=>{
  const h=navigationHarness();const data=h.session.pageData.get(0),caption=data.rows[1];
  const region={x:caption.x,y:caption.bottom+1,width:caption.right-caption.x,height:35};
  data.tableRegions=[region];data.excludedRegions=[region];
  h.session.rows=async()=>data.rows;
  h.session.selectFocus({page:0,index:0});const anchor={...h.session.lockedFocus()};
  const x=region.x+10,y=region.y+.5;
  assert.equal(closestRow(data.rows,x,y),1,'the point overlaps only the caption guide padding');
  assert.equal(await h.session.chooseAt(0,x,y),false);
  assert.deepEqual({...h.session.lockedFocus()},anchor);assert.equal(h.session.current.index,0);
});

test('an empty figure area navigates toward visible-page text instead of the offscreen previous row',async()=>{
  for(const delta of [1,-1]){
    const h=navigationHarness([[40,700]],{pageHeight:800});h.container.scrollTop=300;h.session.lastScrollPosition=h.session.scrollPosition();
    await h.session.followVisible();assert.equal(h.session.overlay.style.width,'0px');
    await h.session.move(delta);assert.equal(h.session.current.index,delta>0?1:0);assert.ok(h.session.fullyVisible(h.session.screenBox()));
  }
});

test('selected PDF text keeps Enter and arrow keys for native plugins, including legacy selection ranges',async()=>{
  for(const legacy of [false,true]){
    const h=navigationHarness();if(legacy)h.view._selectionRanges=[{collapsed:false,text:'stochastic'}];else h.selection.isCollapsed=false;
    for(const key of ['Enter','ArrowUp','ArrowDown']){const event=h.event(key);await h.session.handleKeyDown(event);assert.equal(event.prevented,false);}
    assert.equal(h.session.current.index,0);assert.equal(h.scrolls.length,0);
  }
});

test('guide navigation preserves input fields, dialogs, modifiers, composition and native annotations',async()=>{
  const h=navigationHarness();
  const protectedEvents=[{target:{isContentEditable:true}},...['input','textarea','button','summary','dialog','[role=textbox]'].map(selector=>({target:{closest:selectors=>selectors.split(',').includes(selector)?{}:null}})),...['altKey','ctrlKey','metaKey','shiftKey','isComposing','defaultPrevented'].map(key=>({[key]:true})),{keyCode:229}];
  for(const overrides of protectedEvents){const event=h.event('Enter',overrides);await h.session.handleKeyDown(event);assert.equal(event.prevented,false);}
  h.core._state.selectedAnnotationIDs=['annotation'];await h.session.handleKeyDown(h.event('Enter'));assert.equal(h.session.current.index,0);
});

test('inactive tabs and unload prevent delayed navigation from changing current or focusing a reader',async()=>{
  for(const unload of [false,true]){
    const h=navigationHarness();let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{await gate;return h.load(page);};
    const pending=h.session.move(1);
    if(unload)h.session.dispose();else{h.session.reader.tabID='one';h.session.reader._window={Zotero_Tabs:{selectedID:'other'}};}
    release();assert.equal(await pending,false);assert.equal(h.win.focusCount||0,0);assert.equal(h.scrolls.length,0);
    if(unload)assert.equal(h.session.current,null);else assert.equal(h.session.current.index,0);
  }
});

test('metadata for an unrendered page supplies its real dimensions before reading layout',async()=>{
  const h=navigationHarness();const pv=h.pageViews[1];pv.pdfPage=null;
  const actual={...h.viewport,width:900,height:700,transform:[1,0,0,-1,0,700]};
  const page={getViewport:()=>actual,getTextContent:async()=>({items:[item('Different page size',50,600)],styles:{}})};
  let metadata=0;pv.setPdfPage=value=>{metadata++;pv.pdfPage=value;pv.viewport=actual;};
  h.session.app.pdfDocument.getPage=async()=>page;h.session.rows=GuideSession.prototype.rows;
  const rows=await h.session.rows(1);assert.equal(rows.length,1);assert.equal(metadata,1);assert.equal(h.session.pageData.get(1).viewport.height,700);
});

test('canonical viewport options are cloned into the reader realm before calling its PDF API',async()=>{
  const session=new GuideSession({},{}), readerWindow={};let cloned=0;
  context.Components={utils:{waiveXrays:value=>value,cloneInto:(value,win)=>{assert.equal(win,readerWindow);cloned++;return {...value,inReaderRealm:true};}}};
  const page={rotate:0,getViewport(options){assert.equal(options.inReaderRealm,true);assert.equal(options.rotation,90);assert.equal(options.scale,1);return viewport;},getTextContent:async()=>({items:[item('Reader realm',50,700)],styles:{}})};
  session.win=readerWindow;session.app={pdfDocument:{getPage:async()=>page},pdfViewer:{currentScale:1,pagesRotation:90,getPageView:()=>null}};
  try{assert.equal((await session.rows(0)).length,1);assert.equal(cloned,1);}finally{delete context.Components;}
});

test('old text extraction cannot replace a newer canonical page layout',async()=>{
  const h=navigationHarness();let release;let calls=0;
  const page={getViewport:()=>h.viewport,getTextContent:()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({items:[item('Current text',50,300)],styles:{}})};
  h.app=h.session.app;h.app.pdfDocument.getPage=async()=>page;h.session.rows=GuideSession.prototype.rows;
  const old=h.session.rows(0);await flush();
  h.pageViews[0].viewport={...h.viewport,scale:2,width:1200,height:800,transform:[2,0,0,-2,0,800]};
  const refresh=h.session.refreshLayout();await refresh;
  release({items:[item('Old geometry',50,300)],styles:{}});await old;
  assert.equal(h.session.pageData.get(0).viewport.scale,1);assert.match(h.session.pageData.get(0).rows[0].text,/Current/);
});

test('repeated zoom keeps the canonical layout, source anchor and a nonempty focus aperture on every frame',async()=>{
  const h=navigationHarness();let extractions=0;
  const content={items:[item('First row',50,360),item('Focused row',50,300),item('Last row',50,100)],styles:{}};
  const page={getViewport:({scale,rotation})=>{assert.equal(scale,1);return {...h.viewport,rotation};},getTextContent:async()=>{extractions++;return content;}};
  h.session.app.pdfDocument.getPage=async()=>page;h.session.rows=GuideSession.prototype.rows;
  await h.session.rows(0);h.session.selectFocus({page:0,index:1});const original=h.session.pageData.get(0);
  const div=h.pageViews[0].div;div.getBoundingClientRect=()=>({left:0,top:-h.container.scrollTop,right:div.clientWidth,bottom:div.clientHeight-h.container.scrollTop});
  const anchor=original.rows[1].items[0].index;
  for(const scale of [1.6,.85,2,.7,1]){
    h.session.onScaleChange();
    div.clientWidth=600*scale;div.clientHeight=400*scale;
    h.pageViews[0].viewport={...h.viewport,scale,width:600*scale,height:400*scale,transform:[scale,0,0,-scale,0,400*scale]};
    h.container.scrollTop=Math.max(0,100*scale-80);h.session.onViewportChange();
    for(let i=0;i<4;i++){
      h.session.paint();assert.ok(parseFloat(h.session.overlay.style.width)>0);assert.ok(parseFloat(h.session.overlay.style.height)>0);
      assert.equal(h.session.pageData.get(0),original);assert.equal(original.rows[h.session.current.index].items[0].index,anchor);
      await h.frame();
    }
    assert.equal(h.session.geometrySettling,null);assert.equal(await h.session.rows(0),original.rows);
  }
  assert.equal(extractions,1,'zoom never clears or reextracts canonical text geometry');
});

test('zoom settling does not reanchor through transient offscreen geometry and manual input cancels its pending frames',async()=>{
  const h=navigationHarness();h.session.selectFocus({page:0,index:1});h.session.onScaleChange();
  h.container.scrollTop=260;h.session.onViewportChange();await h.frame();
  assert.equal(h.session.current.index,1,'an intermediate host zoom scroll cannot change the reading unit');
  h.container.scrollTop=30;h.session.onViewportChange();await h.settle();assert.equal(h.session.current.index,1);
  h.session.onScaleChange();const callbacks=[...h.frames.values()];h.session.cancelNavigation();h.container.scrollTop=240;h.session.onViewportChange();await flush();
  for(const callback of callbacks)callback(999);await h.settle();
  assert.equal(h.container.scrollTop,240);assert.equal(h.session.current.index,1);assert.equal(h.session.geometrySettling,null);
});

test('an early updateviewarea before scalechanging preserves the source row and screen ratio through a large zoom',async()=>{
  const h=navigationHarness([[40,300,700]],{pageHeight:800});
  const div=h.pageViews[0].div;div.getBoundingClientRect=()=>({left:0,top:-h.container.scrollTop,right:div.clientWidth,bottom:div.clientHeight-h.container.scrollTop});
  h.pageViews[0].viewport={...h.viewport,scale:.6};h.session.app.pdfViewer.currentScale=.6;
  div.clientWidth=360;div.clientHeight=480;h.container.scrollHeight=520;
  h.session.selectFocus({page:0,index:1});h.container.scrollTop=100;h.session.lastScrollPosition=h.session.scrollPosition();h.session.paint();
  const before=h.session.screenBox(),ratio=(before.top+before.bottom)/2/h.container.clientHeight,source=h.session.stableFocus.item;
  // The host updates layout/scroll and publishes updateviewarea synchronously,
  // before it dispatches the separate scalechanging notification.
  h.session.app.pdfViewer.currentScale=1.6;h.pageViews[0].viewport={...h.viewport,scale:1.6};
  div.clientWidth=960;div.clientHeight=1280;h.container.scrollHeight=1320;h.container.scrollTop=20;
  h.session.onViewportChange();
  assert.equal(h.session.current.index,1);assert.ok(h.session.geometrySettling);
  assert.ok(parseFloat(h.session.overlay.style.height)>0);
  const anchor=h.session.geometrySettling.anchor;
  h.session.onScaleChange();assert.equal(h.session.geometrySettling.anchor,anchor,'late scale event inherits the same transaction');
  for(let i=0;i<4;i++){await h.frame();assert.equal(h.session.current.index,1);assert.ok(parseFloat(h.session.overlay.style.height)>0);}
  const after=h.session.screenBox();assert.ok(Math.abs((after.top+after.bottom)/2/h.container.clientHeight-ratio)<.01);
  assert.equal(h.session.stableFocus.item,source);assert.equal(h.session.geometrySettling,null);
});

test('manual cancellation followed by old callbacks and more viewport events cannot revive the previous zoom anchor',async()=>{
  const h=navigationHarness();h.session.win=null;await h.session.attach();await h.load(0);h.session.selectFocus({page:0,index:0});h.session.paint();
  h.pageViews[0].viewport={...h.viewport,scale:2};h.session.app.pdfViewer.currentScale=2;h.session.onViewportChange();
  const stale=[...h.frames.values()];assert.ok(h.session.geometrySettling);
  h.handlers.get('win:wheel')({ctrlKey:false,metaKey:false});h.container.scrollTop=240;h.session.onViewportChange();await flush();
  const manual={...h.session.current};
  for(const callback of stale)callback(999);h.session.onViewportChange();await h.settle();
  assert.equal(h.container.scrollTop,240);assert.deepEqual({...h.session.current},manual);assert.equal(h.session.geometrySettling,null);
  assert.equal(h.session.stableFocus,null,'an offscreen source has no screen-position compensation anchor');
  assert.equal(h.session.lockedFocus().item,0,'the reading source is retained independently of its screen position');
});

test('repeated zoom wheels retain the same transaction anchor across early viewport notifications',async()=>{
  const h=navigationHarness();h.session.win=null;await h.session.attach();await h.load(0);h.session.selectFocus({page:0,index:1});h.session.paint();
  const anchor=h.session.stableFocus.item,ratio=h.session.stableFocus.ratio;
  for(const scale of [1.4,2,.7,1.6]){
    h.handlers.get('win:wheel')({ctrlKey:true});
    h.pageViews[0].viewport={...h.viewport,scale};h.session.app.pdfViewer.currentScale=scale;
    h.session.onViewportChange();assert.equal(h.session.geometrySettling.anchor.item,anchor);
    assert.equal(h.session.geometrySettling.anchor.ratio,ratio);
    await h.frame();h.session.onScaleChange();
  }
  await h.settle();assert.equal(h.session.stableFocus.item,anchor);assert.equal(h.session.current.index,1);
});

test('a late scale event after manual scrolling cannot invent an anchor from an offscreen old page',async()=>{
  const h=navigationHarness(undefined,{cached:false});await h.load(0);h.session.paint();h.session.onScaleChange();
  h.session.cancelNavigation();h.container.scrollTop=470;
  let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{if(page===1)await gate;return h.load(page);};
  h.session.onViewportChange();await flush();assert.equal(h.session.current.page,0);
  h.session.onScaleChange();assert.equal(h.session.geometrySettling.anchor,null);
  assert.equal(h.container.scrollTop,470);release();await h.settle();await flush();
  assert.equal(h.container.scrollTop,470);assert.deepEqual({...h.session.current},{page:0,index:0});
  assert.equal(h.session.overlay.style.height,'0px');
});

test('keyboard navigation during zoom owns the new reading row and stale zoom frames cannot restore the old one',async()=>{
  const h=navigationHarness();h.session.paint();h.session.onScaleChange();const stale=[...h.frames.values()];
  await h.session.handleKeyDown(h.event('ArrowDown'));
  assert.equal(h.session.current.index,1);assert.equal(h.session.geometrySettling,null);
  for(const callback of stale)callback(999);await h.settle();assert.equal(h.session.current.index,1);
  for(const key of ['PageDown','PageUp','Home','End',' ']){
    h.session.onScaleChange();const event=h.event(key);await h.session.handleKeyDown(event);
    assert.equal(event.prevented,false);assert.equal(h.session.geometrySettling,null,key);
  }
});

test('rotation retains and transforms the old aperture until new canonical geometry and its source anchor commit together',async()=>{
  const h=navigationHarness();h.container.clientHeight=1000;h.container.clientWidth=1000;
  const content={items:[item('First row',50,360),item('Focused row',50,300)],styles:{}};
  let release, extracts=0;
  const rotated={...h.viewport,width:400,height:600,rotation:90,transform:[0,1,1,0,0,0]};
  const page={getViewport:({rotation})=>rotation===90?rotated:h.viewport,getTextContent:()=>++extracts===1?Promise.resolve(content):new Promise(resolve=>{release=()=>resolve(content);})};
  h.session.app.pdfDocument.getPage=async()=>page;h.session.rows=GuideSession.prototype.rows;
  await h.session.rows(0);h.session.selectFocus({page:0,index:1});const old=h.session.pageData.get(0),anchor=old.rows[1].items[0].index;
  h.pageViews[0].viewport=rotated;h.pageViews[0].div.clientWidth=400;h.pageViews[0].div.clientHeight=600;
  const refreshing=h.session.refreshLayout();await flush();
  assert.equal(h.session.pageData.get(0),old);assert.equal(h.session.current.index,1);
  h.session.paint();assert.ok(parseFloat(h.session.overlay.style.width)>0);assert.ok(parseFloat(h.session.overlay.style.height)>0);
  const interim=h.session.screenBox();assert.ok(interim.height>interim.width,'old horizontal text is projected into the rotated display');
  release();await refreshing;
  const data=h.session.pageData.get(0);assert.notEqual(data,old);assert.equal(data.viewport.rotation,90);
  assert.equal(data.rows[h.session.current.index].items[0].index,anchor);assert.equal(h.session.layoutRefreshOwner,null);
  assert.ok(parseFloat(h.session.overlay.style.width)>0);
});

test('rotation notification uses committed reader rotation even before page-view dimensions and fit scale update',async()=>{
  const h=navigationHarness();h.container.clientHeight=1000;h.container.clientWidth=1000;
  const content={items:[item('First row',50,360),item('Current row',50,300)],styles:{}};
  const turns={0:h.viewport,90:{...h.viewport,width:400,height:600,rotation:90,transform:[0,1,1,0,0,0]},
    180:{...h.viewport,rotation:180,transform:[-1,0,0,1,600,0]},270:{...h.viewport,width:400,height:600,rotation:270,transform:[0,-1,-1,0,400,600]}};
  const page={rotate:0,getViewport:({rotation})=>turns[rotation],getTextContent:async()=>content};
  h.session.app.pdfDocument.getPage=async()=>page;h.session.rows=GuideSession.prototype.rows;h.session.app.pdfViewer.pagesRotation=0;
  await h.session.rows(0);h.session.selectFocus({page:0,index:1});
  for(const rotation of [90,180,270,0]){
    h.session.app.pdfViewer.pagesRotation=rotation;
    await h.session.refreshLayout();
    assert.equal(h.session.pageData.get(0).viewport.rotation,rotation,'canonical geometry follows the committed model before display catches up');
    h.pageViews[0].viewport=turns[rotation];h.pageViews[0].div.clientWidth=turns[rotation].width;h.pageViews[0].div.clientHeight=turns[rotation].height;
    h.session.onScaleChange();await h.settle();assert.equal(h.session.pageData.get(0).viewport.rotation,rotation);
  }
});

function orientationHarness(){
  const h=navigationHarness();h.container.clientHeight=1000;h.container.clientWidth=1000;
  const turns={0:h.viewport,90:{...h.viewport,width:400,height:600,rotation:90,transform:[0,1,1,0,0,0]},180:{...h.viewport,rotation:180,transform:[-1,0,0,1,600,0]}};
  const content={items:[item('First row',50,360),item('Second row',50,300)],styles:{}};
  const page={rotate:0,getViewport:({rotation})=>turns[rotation],getTextContent:async()=>content};
  h.session.app.pdfDocument.getPage=async()=>page;h.session.rows=GuideSession.prototype.rows;h.session.app.pdfViewer.pagesRotation=0;
  const display=rotation=>{h.pageViews[0].viewport=turns[rotation];h.pageViews[0].div.clientWidth=turns[rotation].width;h.pageViews[0].div.clientHeight=turns[rotation].height;};
  return{...h,page,content,turns,display};
}

test('viewport model changes refresh canonical rotation without a rotation event and survive interleaved fit zoom',async()=>{
  const h=orientationHarness();let calls=0,release;
  h.page.getTextContent=()=>++calls===2?new Promise(resolve=>{release=()=>resolve(h.content);}):Promise.resolve(h.content);
  await h.session.rows(0);h.session.app.pdfViewer.pagesRotation=90;h.session.onViewportChange();await flush();
  const pending=h.session.orientationRefresh.promise;
  h.session.onScaleChange();for(let i=0;i<8;i++)h.session.onViewportChange();
  assert.equal(calls,2,'the same orientation request is deduplicated across viewport notifications');
  h.display(90);release();await pending;await h.settle();
  assert.equal(h.session.pageData.get(0).viewport.rotation,90);assert.equal(h.session.orientationRefresh,null);
});

test('rapid committed rotations invalidate old asynchronous rows even when the display viewport lags',async()=>{
  const h=orientationHarness();let calls=0,release;
  h.page.getTextContent=()=>++calls===2?new Promise(resolve=>{release=()=>resolve(h.content);}):Promise.resolve(h.content);
  await h.session.rows(0);h.session.app.pdfViewer.pagesRotation=90;h.session.onViewportChange();await flush();
  const old=h.session.orientationRefresh.promise;
  h.session.app.pdfViewer.pagesRotation=180;h.session.onViewportChange();await h.session.orientationRefresh.promise;
  const latest=h.session.pageData.get(0);assert.equal(latest.viewport.rotation,180);
  h.display(180);release();await old;await flush();assert.equal(h.session.pageData.get(0),latest);
});

test('late rows cannot publish an obsolete rotation even when no rotation event advanced the layout epoch',async()=>{
  const h=orientationHarness();let calls=0,release;
  h.page.getTextContent=()=>++calls===2?new Promise(resolve=>{release=()=>resolve(h.content);}):Promise.resolve(h.content);
  await h.session.rows(0);const epoch=h.session.layoutEpoch;
  h.session.app.pdfViewer.pagesRotation=90;const old=h.session.rows(0);await flush();
  h.session.app.pdfViewer.pagesRotation=180;await h.session.rows(0);const latest=h.session.pageData.get(0);
  release();await old;assert.equal(h.session.layoutEpoch,epoch);assert.equal(h.session.pageData.get(0),latest);assert.equal(latest.viewport.rotation,180);
});

test('browsing a neighboring stale page does not replace the locked row or load a substitute layout',async()=>{
  const h=orientationHarness();await h.session.rows(0);h.session.app.pdfViewer.pagesRotation=90;
  await h.session.rows(0);h.display(90);
  h.pageViews[1].viewport=h.turns[90];h.pageViews[1].div.clientWidth=400;h.pageViews[1].div.clientHeight=600;
  assert.equal(h.session.pageData.get(1).viewport.rotation,0,'neighbor starts with retained old display geometry');
  let loads=0;const rows=h.session.rows;h.session.rows=function(page){if(page===1)loads++;return rows.call(this,page);};
  h.session.selectFocus({page:0,index:0});h.container.clientHeight=180;h.container.scrollTop=470;h.session.lastScrollPosition={top:0,left:0};
  h.session.onViewportChange();await flush();
  assert.equal(loads,0);assert.equal(h.session.current.page,0);assert.equal(h.session.pageData.get(1).viewport.rotation,0);
  assert.equal(h.container.scrollTop,470);assert.equal(h.session.overlay.style.height,'0px');
});

test('manual key and click takeover during rotation cannot be overwritten by the old refresh anchor',async()=>{
  for(const input of ['key','click']){
    const h=orientationHarness();let calls=0,release;
    h.page.getTextContent=()=>++calls===2?new Promise(resolve=>{release=()=>resolve(h.content);}):Promise.resolve(h.content);
    await h.session.rows(0);h.session.selectFocus({page:0,index:0});h.session.app.pdfViewer.pagesRotation=90;h.session.onViewportChange();await flush();
    const old=h.session.orientationRefresh.promise;h.display(90);
    const action=input==='key'?h.session.handleKeyDown(h.event('ArrowDown')):h.session.chooseAt(0,300,140);
    release();await action;await old;await h.settle();
    assert.equal(h.session.current.index,1,input);assert.equal(h.session.pageData.get(0).viewport.rotation,90);
  }
});

test('a rapid enable-disable pair cannot turn the guide back on after initialization',async()=>{
  const h=navigationHarness();h.session.enabled=false;
  let release;h.session.attach=()=>new Promise(resolve=>{release=resolve;});
  const enable=h.session.toggle(),disable=h.session.toggle();await disable;release();await enable;
  assert.equal(h.session.enabled,false);assert.equal(h.session.overlay.style.display,'none');
});

test('offscreen browsing, late scale and rendered-page events, and disable-enable retain one source without scrolling back',async()=>{
  const h=navigationHarness();h.session.selectFocus({page:0,index:1});h.session.paint();
  const source={...h.session.lockedFocus()};h.container.scrollTop=470;
  // A queued host notification can arrive before the ordinary scroll listener.
  h.session.onScaleChange();assert.equal(h.session.geometrySettling.anchor,null);
  await h.settle();h.session.onViewportChange();await flush();
  assert.equal(h.container.scrollTop,470);assert.deepEqual({...h.session.lockedFocus()},source);
  assert.equal(h.session.overlay.style.height,'0px');
  await h.session.toggle();await h.session.toggle();
  assert.equal(h.session.enabled,true);assert.equal(h.container.scrollTop,470);
  assert.deepEqual({...h.session.lockedFocus()},source);assert.equal(h.session.overlay.style.height,'0px');
  await h.session.handleKeyDown(h.event('Enter'));await h.settle();
  assert.deepEqual({...h.session.current},{page:0,index:2});assert.ok(h.session.fullyVisible(h.session.screenBox()));
});

test('offscreen rotation changes only the locked source geometry, never its viewport or reading identity',async()=>{
  const h=orientationHarness();await h.session.rows(0);h.session.selectFocus({page:0,index:0});
  h.container.clientHeight=180;h.session.paint();const source=h.session.lockedFocus().item;
  h.session.cancelNavigation();h.container.scrollTop=700;h.session.onViewportChange();await flush();
  for(const rotation of [90,180,0]){
    h.session.app.pdfViewer.pagesRotation=rotation;h.display(rotation);h.session.onViewportChange();
    if(h.session.orientationRefresh)await h.session.orientationRefresh.promise;
    h.session.onScaleChange();await h.settle();h.session.onViewportChange();await flush();
    assert.equal(h.container.scrollTop,700);assert.equal(h.session.lockedFocus().item,source);
    assert.equal(h.session.current.page,0);assert.equal(h.session.overlay.style.height,'0px');
  }
});

test('a temporarily missing source item cannot become the row at its former numeric index',async()=>{
  const h=orientationHarness();await h.session.rows(0);h.session.selectFocus({page:0,index:1});
  const source={...h.session.lockedFocus()},original=h.content.items;
  h.content.items=[original[0]];await h.session.refreshLayout();
  assert.equal(h.session.current,null);assert.deepEqual({...h.session.lockedFocus()},source);
  const top=h.container.scrollTop;assert.equal(await h.session.move(1),false);assert.equal(h.container.scrollTop,top);
  assert.equal(h.session.overlay.style.height,'0px');
  h.content.items=original;await h.session.refreshLayout();
  assert.deepEqual({...h.session.current},{page:0,index:1});assert.deepEqual({...h.session.lockedFocus()},source);
});

test('only an explicit key can migrate an exact formerly readable table source to its shared reading neighbor',async()=>{
  for(const delta of [-1,1]){
    const h=navigationHarness();h.session.selectFocus({page:0,index:1});const source={...h.session.lockedFocus()},old=h.session.pageData.get(0).rows;
    const rows=[old[0],old[2]],excluded={...old[1],readingRole:'table',tableRegionId:'table-example'};
    const layout={rows,excludedRows:[excluded],tableRegions:[{id:'table-example',readingNeighbors:{previous:[old[0].items[0].index],next:[old[2].items[0].index]}}],viewport:h.viewport};
    h.session.pageData.set(0,layout);h.session.remapFocus(source,rows);h.session.rows=async()=>rows;
    h.session.onViewportChange();await flush();assert.equal(h.session.current,null);assert.deepEqual({...h.session.lockedFocus()},source);
    assert.equal(await h.session.move(delta),true);await h.settle();
    assert.equal(h.session.lockedFocus().item,old[delta<0?0:2].items[0].index);assert.ok(h.session.fullyVisible(h.session.screenBox()));
  }
});

test('table reading-neighbor metadata cannot move an unrelated or unknown source',async()=>{
  for(const sourceItem of [1,999]){
    const h=navigationHarness();h.session.selectFocus({page:0,index:1});const old=h.session.pageData.get(0).rows,source={...h.session.lockedFocus(),item:sourceItem};
    const rows=[old[0],old[2]],layout={rows,excludedRows:[{...old[1],items:[{...old[1].items[0],index:88}],readingRole:'table',tableRegionId:'table-other'}],tableRegions:[{id:'table-other',readingNeighbors:{previous:[0],next:[2]}}],viewport:h.viewport};
    h.session.pageData.set(0,layout);h.session.remapFocus(source,rows);h.session.rows=async()=>rows;
    const before=h.container.scrollTop;assert.equal(await h.session.move(1),false);assert.equal(h.container.scrollTop,before);assert.deepEqual({...h.session.lockedFocus()},source);
  }
});

test('an explicit key can leave a known full-table source across empty pages without selecting another cell',async()=>{
  const h=navigationHarness([[40],[],[],[40]]),old=h.session.pageData.get(0).rows[0];h.session.selectFocus({page:0,index:0});const source={...h.session.lockedFocus()};
  const layout={rows:[],excludedRows:[{...old,readingRole:'table',tableRegionId:'table-only'}],tableRegions:[{id:'table-only',readingNeighbors:{previous:null,next:null}}],viewport:h.viewport};
  h.session.pageData.set(0,layout);h.session.remapFocus(source,[]);h.session.rows=async page=>page===0?layout.rows:h.load(page);
  assert.equal(await h.session.move(1),true);await h.settle();assert.deepEqual({...h.session.current},{page:3,index:0});
});

test('zoom preserves the original source when a remapped unit contains a different leading fragment',async()=>{
  const h=navigationHarness();h.session.selectFocus({page:0,index:1});const source={...h.session.lockedFocus()};
  const data=h.session.pageData.get(0),row=data.rows[1];
  row.items.unshift({...row.items[0],index:99,str:'Additional inline fragment'});
  h.session.remapFocus(source,data.rows);h.session.paint();h.session.onScaleChange();await h.settle();
  assert.deepEqual({...h.session.lockedFocus()},source);
});

test('passive notifications never initialize a reading anchor in an unpositioned session',async()=>{
  const h=navigationHarness();h.session.selectFocus(null);h.session.onViewportChange();await flush();
  assert.equal(h.session.lockedFocus(),null);assert.equal(h.session.current,null);
  assert.equal(h.session.overlay.style.height,'0px');
  await h.session.followVisible({initialize:true});assert.ok(h.session.lockedFocus());
});

test('a delayed browsing notification cannot cancel a later reading key, including after re-enabling',async()=>{
  for(const disabled of [false,true]){
    const h=navigationHarness();h.session.selectFocus({page:0,index:0});
    if(disabled)await h.session.toggle();
    h.container.scrollTop=470;
    if(disabled)await h.session.toggle();
    let release;const gate=new Promise(resolve=>{release=resolve;});h.session.rows=async page=>{await gate;return h.load(page);};
    const pending=h.session.move(1);h.session.onViewportChange();release();
    assert.equal(await pending,true);await h.settle();
    assert.deepEqual({...h.session.current},{page:0,index:1});assert.ok(h.session.fullyVisible(h.session.screenBox()));
  }
});

test('a failed first activation can retry on the very next click',async()=>{
  const h=navigationHarness();h.session.enabled=false;let attempts=0;
  h.session.attach=async()=>{if(++attempts===1)throw Error('PDF is still loading');};
  await assert.rejects(h.session.toggle(),/still loading/);await h.session.toggle();assert.equal(h.session.enabled,true);
});

test('native settings close on outside pointer or Escape while keeping controls interactive',async()=>{
  const session=new GuideSession({},{}),listeners=new Map();let focus=0;
  session.win={focus(){focus++;}};
  const doc={addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name){listeners.delete(name);}};
  const control={},outside={},menu={isConnected:true,open:true,contains:target=>target===control};
  session.registerMenu(menu,doc);
  listeners.get('pointerdown')({target:control});assert.equal(menu.open,true,'slider and other menu interactions remain open');
  listeners.get('pointerdown')({target:outside});assert.equal(menu.open,false);assert.equal(focus,0,'pointer destination keeps its own focus');
  menu.open=true;let prevented=false,stopped=false;
  listeners.get('keydown')({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.equal(menu.open,false);assert.equal(focus,1);assert.equal(prevented&&stopped,true);
  menu.open=true;await session.handleKeyDown({key:'Escape',target:{},preventDefault(){},stopImmediatePropagation(){}});
  assert.equal(menu.open,false,'Escape from the nested PDF window also closes the toolbar menu');assert.equal(focus,2);
  session.dispose();assert.equal(listeners.size,0);assert.equal(session.menus.size,0);
});

test('settings document listeners are registered once and detached with the session',()=>{
  const session=new GuideSession({},{});let added=0,removed=0;
  const doc={addEventListener(){added++;},removeEventListener(){removed++;}};
  const old={isConnected:false,open:true},next={isConnected:true,open:true};
  session.registerMenu(old,doc);session.registerMenu(next,doc);
  assert.equal(added,2);session.closeMenus();assert.equal(session.menus.has(old),false);assert.equal(next.open,false);
  session.dispose();assert.equal(removed,2);assert.equal(session.toolbarDocuments.size,0);
});

test('the shared glyph metrics bundle loads into the Zotero subscript scope', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: [new URL('../src/glyph-metrics.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], write: false, bundle: true, format: 'iife', globalName: 'ADHDGlyphMetrics', target: 'firefox115', minify: true });
  const scope = vm.createContext({});
  vm.runInContext(bundle.outputFiles[0].text, scope);
  const api = scope.ADHDGlyphMetrics;
  assert.equal(typeof api.glyphMapForPage, 'function');
  assert.equal(typeof api.attachScriptFragments, 'function');
  assert.equal(typeof api.orderReadingLines, 'function');
  assert.equal(typeof api.extractDrawingStructures, 'function');
  assert.equal(typeof api.buildReadingUnits, 'function');
  assert.equal(api.ordinaryMetrics({ ascent: .775, descent: -.96 }), false);
  const styles = { body: { ascent: .72, descent: -.2, fontFamily: 'serif' }, damaged: { ascent: 0, descent: 0, fontFamily: 'serif' } };
  const value = api.fontMetrics({}, 'damaged', styles.damaged, styles, 'x');
  assert.equal(value.ascent, .72);
  assert.equal(value.descent, .2);
});

function toolbarDocument() {
  const element = tagName => ({
    tagName, className: '', children: [], parent: null, style: {}, attributes: {}, listeners: new Map(),
    get isConnected() { return this.root || Boolean(this.parent?.isConnected); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    append(...nodes) { for (const node of nodes) { node.remove?.(); node.parent = this; this.children.push(node); } },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; },
    replaceChildren() { for (const node of [...this.children]) node.remove(); },
    closest(selector) { return this.className.split(' ').includes(selector.slice(1)) ? this : this.parent?.closest(selector); },
    querySelectorAll(selector) {
      const className = selector.trim().split(/\s+/).at(-1).slice(1);
      return this.children.flatMap(node => [...(node.className.split(' ').includes(className) ? [node] : []), ...node.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  });
  const body = element('body'); body.root = true;
  const toolbar = element('div'); toolbar.className = 'toolbar';
  const end = element('div'); end.className = 'end';
  const slot = element('div'); slot.className = 'custom-sections';
  body.append(toolbar); toolbar.append(end); end.append(slot);
  return { doc: { createElement: element, querySelector: selector => body.querySelector(selector), body }, slot };
}

function lifecycleContext(readers) {
  const registered = new Map(), errors = [];
  const runtime = vm.createContext({
    Zotero: { initializationPromise: Promise.resolve(), Prefs: { get() { return undefined; } }, logError: error => errors.push(error),
      Reader: { _readers: readers, registerEventListener: (name, handler) => registered.set(name, handler),
        unregisterEventListener: name => registered.delete(name) } },
    Services: { scriptloader: { loadSubScript: (name, scope) => Object.assign(scope, name.endsWith('/language-detector.js')
      ? {} : { ADHDGlyphMetrics: sharedGlyphMetrics }) } },
  });
  vm.runInContext(source, runtime);
  return { runtime, registered, errors, data: { id: 'linea-reader@local.linea', version: '0.1.8', rootURI: 'jar:file:///isolated/adhd-reader.xpi!/' } };
}

test('Zotero loads only reading geometry, without translation resources or selection hooks', async () => {
  const h = lifecycleContext([]), loaded = [];
  const loader = h.runtime.Services.scriptloader.loadSubScript;
  h.runtime.Services.scriptloader.loadSubScript = (url, scope) => { loaded.push(url); loader(url, scope); };
  h.runtime.Zotero.File = { async getResourceAsync() { throw Error('No dictionary resources'); } };
  h.runtime.Zotero.HTTP = { request() { throw Error('No translation network'); } };
  await h.runtime.startup(h.data);
  assert.deepEqual(loaded, [h.data.rootURI + 'glyph-metrics.js']);
  assert.deepEqual([...h.registered.keys()], ['renderToolbar']);
  assert.equal(typeof GuideSession.prototype.translate, 'undefined');
  h.runtime.shutdown();
});

test('hot installation fills an existing PDF toolbar once and cleans it on shutdown', async () => {
  const { doc, slot } = toolbarDocument();
  const reader = { type: 'pdf', _initPromise: Promise.resolve(), _iframeWindow: { document: doc } };
  const h = lifecycleContext([reader, { type: 'epub', _iframeWindow: { document: doc } }]);
  await h.runtime.startup(h.data); await Promise.resolve();
  assert.equal(slot.querySelectorAll('.linea-toolbar').length, 1);
  assert.equal(slot.querySelectorAll('.linea-toolbar-section').length, 1);
  assert.equal(h.registered.size, 1);
  await h.runtime.mountExistingReader(reader, vm.runInContext('startupGeneration', h.runtime));
  assert.equal(slot.querySelectorAll('.linea-toolbar').length, 1, 'late reader mount cannot duplicate the event toolbar');
  slot.replaceChildren();
  h.registered.get('renderToolbar')({ reader, doc, append: node => slot.append(node) });
  assert.equal(slot.querySelectorAll('.linea-toolbar').length, 1, 'native rerender recreates the toolbar normally');
  h.runtime.shutdown();
  assert.equal(slot.querySelectorAll('.linea-toolbar').length, 0);
  assert.equal(slot.querySelectorAll('.linea-toolbar-section').length, 0);
  assert.equal(h.registered.size, 0);
  assert.deepEqual(h.errors, []);
});

test('a previous startup cannot mount a toolbar after shutdown or a later restart', async () => {
  const { doc, slot } = toolbarDocument();
  let firstReady, nextReady;
  const reader = { type: 'pdf', _initPromise: new Promise(resolve => { firstReady = resolve; }), _iframeWindow: { document: doc } };
  const h = lifecycleContext([reader]);
  await h.runtime.startup(h.data);
  h.runtime.shutdown();
  reader._initPromise = new Promise(resolve => { nextReady = resolve; });
  await h.runtime.startup(h.data);
  firstReady(); await Promise.resolve(); await Promise.resolve();
  assert.equal(slot.querySelectorAll('.linea-toolbar').length, 0, 'old initialization cannot attach during a later generation');
  nextReady(); await Promise.resolve(); await Promise.resolve();
  assert.equal(slot.querySelectorAll('.linea-toolbar').length, 1);
  h.runtime.shutdown();
  assert.equal(slot.querySelectorAll('.linea-toolbar-section').length, 0, 'fallback wrappers are removed too');
  assert.deepEqual(h.errors, []);
});
