import assert from 'node:assert/strict';
import { toolCardOpen, bindToolCardState } from '../sidepanel/tool-card-state.js';
function card(item) {
  const events = {};
  const details = {open:toolCardOpen(item),isConnected:true,
    querySelector:()=>({addEventListener:(type,fn)=>{events[type]=fn}}),
    addEventListener:(type,fn)=>{events[type]=fn},
  };
  bindToolCardState(details,item);
  return {details, click(){events.click();details.open=!details.open;}, toggle(){events.toggle();}};
}
const a={id:'1',name:'read_page',status:'running'},b={id:'2',name:'read_page'};
assert.equal(toolCardOpen(a),false);
const first=card(a);first.click();
assert.equal(toolCardOpen(a),true,'records before deferred toggle/stream update');
a.status='ok';assert.equal(card(a).details.open,true);
assert.equal(toolCardOpen(b),false,'same tool name does not share expansion');
const second=card(a);second.click();
assert.equal(toolCardOpen(a),false,'closed state survives output updates');
first.details.isConnected=false;first.toggle();
assert.equal(toolCardOpen(a),false,'detached stale nodes cannot reopen the card');
console.log('PASS tool disclosure state');
