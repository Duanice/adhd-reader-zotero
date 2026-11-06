import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionTableContent} from '../src/table-regions.js';

const view={width:600,height:800,transform:[1,0,0,1,0,0]};
const cell=(index,str,x,y,width=55,fontName='body')=>({index,str,x,y,width,height:10,fontHeight:10,fontName,angle:0});
const lines=items=>items.map(item=>({items:[item],angle:0}));
const rule=(x1,y1,x2,y2)=>({x1,y1,x2,y2,thickness:.5});
const detect=(items,structures={})=>partitionTableContent({items,baselineLines:lines(items),structures,viewport:view});
const inside=(box,x,y)=>x>=box.x&&x<=box.x+box.width&&y>=box.y&&y<=box.y+box.height;
test('a fully numeric ruled grid is a table while the same unruled numeric matrix remains readable',()=>{
  const items=Array.from({length:9},(_,i)=>cell(i,String(i+1),60+i%3*80,110+Math.floor(i/3)*30,12));
  const rules=[...Array.from({length:4},(_,i)=>rule(50,100+i*30,290,100+i*30)),...Array.from({length:4},(_,i)=>rule(50+i*80,100,50+i*80,190))];
  assert.equal(detect(items,{rules}).excludedItems.length,9);
  assert.equal(detect(items).excludedItems.length,0);
});

test('Source and Note labels inside data columns are cells, not protected notes',()=>{
  const items=['Field','Value','Source:','Survey','Note:','Stable'].map((value,i)=>cell(i,value,60+i%2*150,110+Math.floor(i/2)*25));
  const result=detect(items,{rules:[rule(50,100,300,100),rule(50,130,300,130),rule(50,185,300,185)]});
  assert.equal(result.excludedItems.length,6);assert.equal(result.items.length,0);
});

test('captions wider than two consecutive tables separate their hit areas and internal notes remain clickable',()=>{
  let index=0;const items=[];
  for(const y of[110,135,160,260,285,310])for(const x of[80,220,350])items.push(cell(index++,x===80?'Method':'82.3',x,y));
  const captionItem=cell(index++,'Table 2: This caption extends beyond the table border.',30,210,500);
  const note=cell(index++,'Note: This explanation belongs to the retained prose.',60,345,430);
  const continuation=cell(index++,'Its wrapped continuation must remain available to readers.',60,360,430);
  items.push(captionItem,note,continuation);
  const result=detect(items,{rules:[100,125,180,250,275,335,385].map(y=>rule(70,y,430,y))});
  assert.equal(result.regions.length,2);
  assert.deepEqual(result.items.map(i=>i.index),[captionItem.index,note.index,continuation.index]);
  for(const item of result.items)for(const fraction of[.05,.5,.95])assert.ok(!result.regions.some(r=>inside(r,item.x+item.width*fraction,item.y+5)));
});

test('ruled and captioned unruled definition tables include wrapped value cells',()=>{
  for(const ruled of[true,false]){
    const items=[cell(0,'Table 1: Definitions used in this report.',40,70,380),
      cell(1,'Term',50,110,60,'bold'),cell(2,'Meaning',160,110,75,'bold'),
      cell(3,'Reference',50,140),cell(4,'A complete description with enough words to wrap.',160,140,300),
      cell(5,'The continuation remains inside the same value cell.',160,154,300),
      cell(6,'Control',50,180),cell(7,'Another detailed explanation for this category.',160,180,300),
      cell(8,'Final',50,220),cell(9,'A final definition with several ordinary words.',160,220,300),
      cell(10,'Its last wrapped line stays with the table.',160,234,270),
      cell(11,'Note: Ordinary prose resumes below the definitions.',40,270,400)];
    const result=detect(items,{rules:ruled?[rule(40,100,480,100),rule(40,130,480,130),rule(40,254,480,254)]:[]});
    assert.deepEqual(result.items.map(i=>i.index),[0,11],ruled?'ruled definitions':'borderless definitions');
  }
});

test('bare panel letters belong to the adjacent confirmed table while descriptive panel captions remain prose',()=>{
  const items=Array.from({length:9},(_,i)=>cell(i,i%3?'42.5':'Control',60+i%3*80,110+Math.floor(i/3)*25,40));
  items.push(cell(9,'(b)',163,185,14),cell(10,'(a) This explanatory panel description remains readable.',40,210,450));
  const result=detect(items,{rules:[100,130,180].map(y=>rule(50,y,290,y))});
  assert.ok(result.excludedItems.some(({item})=>item.index===9));
  assert.deepEqual(result.items.map(item=>item.index),[10]);
});

test('aligned derivations, algorithms, contents lists and paragraph columns are not tables',()=>{
  const examples=[
    ['x = y + z','f = g','a = b + c','u = v','q = r + s','m = n'],
    ['1:','Initialize the current state','2:','Update the next state','3:','Return the final value'],
    ['Introduction','1','Related research','4','Methods','9'],
    ['Left text continues its ordinary paragraph','Right text continues its own paragraph','Left prose resumes on this next line','Right prose resumes on this next line','Left prose reaches its final sentence','Right prose reaches its final sentence'],
  ];
  for(const strings of examples){const items=strings.map((str,i)=>cell(i,str,40+i%2*280,100+Math.floor(i/2)*20,i%2?210:200));assert.equal(detect(items).regions.length,0);}
});

test('table membership is independent of whole-cell, word and glyph text runs',()=>{
  const base=Array.from({length:12},(_,i)=>cell(i,i<3?['Group','Score','Status'][i]:['Reference','82.4','Stable'][i%3],50+i%3*160,100+Math.floor(i/3)*25,i%3===1?30:70,i<3?'bold':'body'));
  for(const mode of['cell','word','glyph']){
    let index=0;const items=base.flatMap(original=>{
      const parts=mode==='cell'?[original.str]:mode==='word'?original.str.split(' '):[...original.str];let offset=0;
      return parts.map(str=>{const size=str.length/original.str.length*original.width,result={...original,index:index++,str,x:original.x+offset,width:size};offset+=size;return result;});
    });
    const result=partitionTableContent({items,baselineLines:base.map(original=>({angle:0,items:items.filter(item=>item.y===original.y&&item.x>=original.x&&item.x<original.x+original.width)})),viewport:view});
    assert.equal(result.excludedItems.length,items.length,mode);
  }
});

