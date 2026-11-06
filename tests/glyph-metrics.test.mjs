import test from 'node:test';
import assert from 'node:assert/strict';
import { fontMetrics } from '../src/glyph-metrics.js';

test('loaded-face metrics retain genuinely tall mathematical ink just as vector-path metrics do',()=>{
  for(const [rawAscent,rawDescent] of [[7,205],[320,15],[-12,240]]){
    const font={loadedName:'fixture-math'},character='\uE011',style={ascent:0,descent:0,fontFamily:'serif'};
    const glyphs=new Map([['math',new Map([['i',new Set([character])]])]]);
    const canvasPage={commonObjs:{get:key=>key==='math'?font:undefined,has:()=>false}};
    const document={fonts:[{family:'fixture-math',status:'loaded'}],createElement:()=>({getContext:()=>({
      measureText:()=>({actualBoundingBoxAscent:rawAscent,actualBoundingBoxDescent:rawDescent}),
    })})};
    const canvas=fontMetrics(canvasPage,'math',style,{body:{ascent:.8,descent:-.2,fontFamily:'serif'}},'i',glyphs,document);
    assert.equal(canvas.ascent,Math.max(0,rawAscent/100));assert.equal(canvas.descent,Math.max(0,rawDescent/100));
    const path={path:new Float32Array([0,0,-rawDescent/100,1,.5,rawAscent/100])};
    const vectorPage={commonObjs:{get:key=>key==='math'?font:path,has:()=>true}};
    const vector=fontMetrics(vectorPage,'math',style,{},'i',glyphs,undefined);
    assert.ok(Math.abs(canvas.ascent-vector.ascent)<1e-6);assert.ok(Math.abs(canvas.descent-vector.descent)<1e-6);
  }
});
