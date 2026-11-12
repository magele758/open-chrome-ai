/**
 * 确定性状态断言分批脚本生成器（支持 @topDialog、标准 ARIA / 原生控件与可插拔 UIAdapter 选择器表）。
 * 零业务语义（不含卡片移除按钮猜测或特定业务页面断言）。
 */

import { DEFAULT_COMPOSITE_ADAPTER_SPEC } from "../ui-adapters/index.js";

export const DEFAULT_ADAPTER_SPEC = DEFAULT_COMPOSITE_ADAPTER_SPEC;

const SELECT_HELPER_KINDS = new Set([
  "select_items_include",
  "cascader_or_select_equals",
  "select_sequence_equals",
  "field_blocks_match",
]);

export const ASSERT_KIND_SNIPPETS = Object.freeze({
  modals_count: `const ms=modals(Number(c.equals)===0?1:0),titles=ms.map(dialogTitle);
if(ms.length!==Number(c.equals))return{pass:false,index:idx,kind:c.kind,expected:"可见对话框数 === "+c.equals,actual:"实读对话框数 === "+ms.length+" ("+JSON.stringify(titles)+")"};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{count:ms.length,titles}});`,

  select_items_include: `const items=readAllSelectedInScope(scope);
const missing=(c.mustInclude||[]).filter(w=>!items.includes(String(w)));
if(missing.length)return{pass:false,index:idx,kind:c.kind,expected:"已选项包含 "+JSON.stringify(c.mustInclude),actual:"缺少 "+JSON.stringify(missing)+"；当前已选: "+JSON.stringify(items.slice(0,20))};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:items});`,

  checked_checkboxes_equal: `const ignore=new Set((c.ignoreLabels||[]).map(norm));
const checked=[...scope.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(cb=>cb.tagName==="INPUT"?cb.checked:cb.getAttribute("aria-checked")==="true").map(cb=>{const l=cb.closest("label")||(cb.id?scope.querySelector('label[for="'+CSS.escape(cb.id)+'"]'):null);return norm(cb.getAttribute("aria-label")||txtOf(l||cb));}).filter(t=>t&&!ignore.has(t));
const want=(c.equals||[]).map(String);
if(JSON.stringify(checked)!==JSON.stringify(want))return{pass:false,index:idx,kind:c.kind,expected:"已勾选复选框 === "+JSON.stringify(want),actual:"实读已勾选 === "+JSON.stringify(checked)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:checked});`,

  cascader_or_select_equals: `const got=readControlSelected(scope,c.inputSelector||c.selector);
if(got!==String(c.equals))return{pass:false,index:idx,kind:c.kind,expected:(c.inputSelector||c.selector)+" 选中值 === "+JSON.stringify(c.equals),actual:"实读选中值 === "+JSON.stringify(got)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:got});`,

  input_equals: `const nth=Number(c.nth)||0,el=scope.querySelectorAll(c.selector)[nth],got=el?String(el.value??""):null;
if(got!==String(c.equals))return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 值 === "+JSON.stringify(c.equals),actual:"实读值 === "+JSON.stringify(got)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:got});`,

  inputs_by_placeholder_equal: `const list=[...scope.querySelectorAll("input, textarea")].filter(inp=>inp.getAttribute("placeholder")===String(c.placeholder)).map(inp=>String(inp.value??""));
if(c.allEqual!==undefined){const w=String(c.allEqual),m=Number(c.minCount??1);if(list.length<m||list.some(v=>v!==w))return{pass:false,index:idx,kind:c.kind,expected:'placeholder="'+c.placeholder+'" 至少 '+m+" 项且全部 === "+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
else{const w=(c.equals||[]).map(String);if(JSON.stringify(list)!==JSON.stringify(w))return{pass:false,index:idx,kind:c.kind,expected:'placeholder="'+c.placeholder+'" 输入值序列 === '+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
evidence.push({index:idx,id:checkId,kind:c.kind,placeholder:c.placeholder,actual:list});`,

  text_matches_regex: `const full=scopeText(scope),m=new RegExp(String(c.pattern),c.flags||"").exec(full);
if(!m)return{pass:false,index:idx,kind:c.kind,expected:"文本匹配正则 /"+c.pattern+"/"+(c.flags||""),actual:"实读片段: "+JSON.stringify(full.slice(0,260))};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:m[0]});`,

  select_sequence_equals: `const list=[...scope.querySelectorAll(c.selector)].map(s=>readSingleRootSelected(s)[0]||"");
if(Array.isArray(c.repeatPattern)&&c.repeatPattern.length>0){const p=c.repeatPattern.map(String),okR=list.length>=p.length&&list.length%p.length===0&&list.every((v,k)=>v===p[k%p.length]);if(!okR)return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 选中序列按周期重复 "+JSON.stringify(p),actual:"实读序列 === "+JSON.stringify(list)};}
else{const w=(c.equals||[]).map(String);if(JSON.stringify(list)!==JSON.stringify(w))return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 选中序列 === "+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
evidence.push({index:idx,id:checkId,kind:c.kind,actual:list});`,

  radio_checked_equals: `const checked=[...scope.querySelectorAll('input[type="radio"], [role="radio"]')].filter(r=>r.tagName==="INPUT"?r.checked:r.getAttribute("aria-checked")==="true").map(r=>{const l=r.closest("label")||(r.id?scope.querySelector('label[for="'+CSS.escape(r.id)+'"]'):null);return normBtn(r.getAttribute("aria-label")||txtOf(l||r));}).filter(Boolean);
if(!checked.includes(normBtn(c.equals)))return{pass:false,index:idx,kind:c.kind,expected:(c.scopeSelector||c.scope||"scope")+" 选中单选 === "+JSON.stringify(c.equals),actual:"实读选中 === "+JSON.stringify(checked)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:checked});`,

  field_blocks_match: `const fSel=c.fieldSelector||ADAPTER.fieldContainerSelector,lSel=c.labelSelector||ADAPTER.fieldLabelSelector;
const blocks=[...scope.querySelectorAll(fSel)].map(b=>({label:norm(txtOf(b.querySelector(lSel))),items:readAllSelectedInScope(b),inputs:[...b.querySelectorAll("input, textarea")].filter(x=>x.type!=="search"&&x.type!=="checkbox"&&x.type!=="radio"&&x.type!=="hidden").map(x=>String(x.value??"")).filter(v=>v!=="")}));
for(const exp of c.expectedFields||[]){const hit=blocks.find(b=>b.label.includes(String(exp.labelIncludes)));if(!hit)return{pass:false,index:idx,kind:c.kind,expected:"存在字段容器包含 "+JSON.stringify(exp.labelIncludes),actual:"当前字段标签: "+JSON.stringify(blocks.map(b=>b.label))};if(exp.items&&JSON.stringify(hit.items)!==JSON.stringify(exp.items))return{pass:false,index:idx,kind:c.kind,expected:hit.label+" 已选项 === "+JSON.stringify(exp.items),actual:"实读已选项 === "+JSON.stringify(hit.items)};if(exp.inputs&&JSON.stringify(hit.inputs)!==JSON.stringify(exp.inputs))return{pass:false,index:idx,kind:c.kind,expected:hit.label+" 输入值 === "+JSON.stringify(exp.inputs),actual:"实读输入值 === "+JSON.stringify(hit.inputs)};}
evidence.push({index:idx,id:checkId,kind:c.kind,actual:blocks});`,

  text_includes: `const full=scopeText(scope),missing=(c.mustInclude||[]).filter(sub=>!full.includes(norm(sub)));
if(missing.length)return{pass:false,index:idx,kind:c.kind,expected:"文本包含 "+JSON.stringify(c.mustInclude),actual:"缺少 "+JSON.stringify(missing)+"；实读片段: "+JSON.stringify(full.slice(0,260))};
const snippets=(c.mustInclude||[]).map(sub=>{const n=norm(sub),p=full.indexOf(n);return p>=0?full.slice(Math.max(0,p-16),p+n.length+64):"";});
evidence.push({index:idx,id:checkId,kind:c.kind,actual:snippets});`,

  text_excludes: `const full=scopeText(scope),found=(c.forbid||[]).find(sub=>sub&&full.includes(norm(sub)));
if(found)return{pass:false,index:idx,kind:c.kind,expected:"文本不包含 "+JSON.stringify(c.forbid),actual:"命中禁止文本: "+JSON.stringify(found)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{excludedAll:c.forbid||[],sample:full.slice(0,180)}});`,

  images_min_count: `const imgs=[...scope.querySelectorAll(c.selector||"img")].filter(img=>{const s=String(img.getAttribute("src")||img.src||"").trim();return Boolean(s)&&!s.startsWith("data:image/svg+xml");});
const min=Number(c.minCount??1);
if(imgs.length<min)return{pass:false,index:idx,kind:c.kind,expected:(c.selector||"img")+" 有效图片数 >= "+min,actual:"实读有效图片数 === "+imgs.length};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{count:imgs.length,samples:imgs.slice(0,4).map(img=>({alt:img.alt||"",w:img.naturalWidth||0,h:img.naturalHeight||0}))}});`,

  elements_count: `const wantTxt=c.text?normBtn(c.text):"";
const nodes=[...scope.querySelectorAll(c.selector||"button, [role='button']")].filter(el=>isBox(el,0)&&(!wantTxt||normBtn(txtOf(el))===wantTxt));
if(c.equals!==undefined&&nodes.length!==Number(c.equals))return{pass:false,index:idx,kind:c.kind,expected:(c.selector||"元素")+(wantTxt?"["+wantTxt+"]":"")+" 数量 === "+c.equals,actual:"实读数量 === "+nodes.length};
if(c.minCount!==undefined&&nodes.length<Number(c.minCount))return{pass:false,index:idx,kind:c.kind,expected:(c.selector||"元素")+(wantTxt?"["+wantTxt+"]":"")+" 数量 >= "+c.minCount,actual:"实读数量 === "+nodes.length};
if(c.maxCount!==undefined&&nodes.length>Number(c.maxCount))return{pass:false,index:idx,kind:c.kind,expected:(c.selector||"元素")+(wantTxt?"["+wantTxt+"]":"")+" 数量 <= "+c.maxCount,actual:"实读数量 === "+nodes.length};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{count:nodes.length}});`,

  row_state: `const rows=[...scope.querySelectorAll(c.rowSelector||"tbody tr, [role='row']")].filter(r=>isBox(r,0));
const allK=c.mustIncludeAll||[],exK=c.excludeSubstrings||[];
const matched=rows.filter(r=>{const t=norm(txtOf(r));return allK.every(k=>t.includes(String(k)))&&!exK.some(ex=>ex&&t.includes(String(ex)));});
const wantC=Number(c.expectedCount??1);
if(matched.length!==wantC)return{pass:false,index:idx,kind:c.kind,expected:"匹配行数 === "+wantC+" ("+JSON.stringify(allK)+")",actual:"实读匹配行数 === "+matched.length};
const btns=matched[0]?[...matched[0].querySelectorAll("button, a, [role='button']")].map(b=>({text:normBtn(txtOf(b)),enabled:!b.disabled&&b.getAttribute("aria-disabled")!=="true"&&b.getBoundingClientRect().width>0})):[];
if(wantC===1&&Array.isArray(c.mustHaveEnabledButtons)){for(const wb of c.mustHaveEnabledButtons){if(!btns.find(b=>b.text===normBtn(wb)&&b.enabled))return{pass:false,index:idx,kind:c.kind,expected:"行内按钮可见且可用（未点击）: "+wb,actual:"实读行内按钮: "+JSON.stringify(btns)};}}
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{rowCount:matched.length,rowText:matched[0]?norm(txtOf(matched[0])).slice(0,500):null,buttons:btns}});`,
});

export function buildSingleAssertScript(
  containerSelector,
  subChecks,
  baseIndex = 0,
  adapterSpec = DEFAULT_ADAPTER_SPEC,
) {
  const kinds = [...new Set(subChecks.map((c) => String(c?.kind || "")))];
  const needsFieldLabel = subChecks.some((c) => Boolean(c?.fieldLabel));
  const needsSelectHelpers = kinds.some((k) => SELECT_HELPER_KINDS.has(k));
  const needsFieldBlocks = kinds.includes("field_blocks_match");

  const slimAdapter = {
    dialogSelector: adapterSpec.dialogSelector,
    dialogTitleSelector: adapterSpec.dialogTitleSelector,
    leaveClassPattern: adapterSpec.leaveClassPattern,
  };
  if (needsFieldLabel || needsFieldBlocks) {
    slimAdapter.fieldContainerSelector = adapterSpec.fieldContainerSelector;
    slimAdapter.fieldLabelSelector = adapterSpec.fieldLabelSelector;
    slimAdapter.comboboxRootSelector = adapterSpec.comboboxRootSelector;
  }
  if (needsSelectHelpers) {
    slimAdapter.comboboxRootSelector = adapterSpec.comboboxRootSelector;
    slimAdapter.selectedItemSelector = adapterSpec.selectedItemSelector;
    slimAdapter.selectedItemContentSelector = adapterSpec.selectedItemContentSelector;
    slimAdapter.selectedItemRemoveSelector = adapterSpec.selectedItemRemoveSelector;
  }

  const branches = kinds
    .map((k, bi) => {
      const body = ASSERT_KIND_SNIPPETS[k];
      const cond = `${bi === 0 ? "if" : "else if"}(c.kind===${JSON.stringify(k)})`;
      if (!body) {
        return `${cond}{return{pass:false,index:idx,kind:c.kind,expected:"已知断言类型",actual:"未知 check.kind: "+c.kind};}`;
      }
      return `${cond}{${body}}`;
    })
    .join("\n");
  const fallback = kinds.length
    ? `else{return{pass:false,index:idx,kind:c.kind,expected:"已知断言类型",actual:"未知 check.kind: "+c.kind};}`
    : "";

  const qSelfSnippet =
    needsFieldLabel || needsSelectHelpers
      ? `const qSelfOrAll=(r,s)=>{if(!r||!s)return[];const o=[];if(r.matches&&r.matches(s))o.push(r);if(r.querySelectorAll)o.push(...r.querySelectorAll(s));return o;};`
      : "";

  const fieldLabelSnippet = needsFieldLabel
    ? `const normL=s=>norm(s).replace(/^\\*\\s*/,"").replace(/\\s*[:：]\\s*$/,"").trim(),stripH=s=>normL(s).replace(/\\s*[（(][^）)]*[）)]\\s*$/,"").trim();
const CTRL_SEL='select,input,textarea,[role="combobox"],[role="checkbox"],[role="radio"],'+(ADAPTER.comboboxRootSelector||"select");
const hasCtrl=e=>Boolean(e&&((e.matches&&e.matches(CTRL_SEL))||(e.querySelector&&e.querySelector(CTRL_SEL))));
const findFieldScope=(root,raw)=>{const w=normL(raw),ws=stripH(raw);if(!w||!root)return null;const pri=[...root.querySelectorAll(ADAPTER.fieldLabelSelector||"label,legend")].filter(e=>!e.closest("th,td,thead")&&isBox(e,0));const sec=[...root.querySelectorAll("div,span,p,dt")].filter(e=>!e.closest("th,td,thead,button,[role='option'],li")&&e.children.length<=3&&isBox(e,0));for(const l of[...pri,...sec]){const t=normL(txtOf(l)),ts=stripH(t);if(t!==w&&ts!==w&&t!==ws)continue;const wp=ADAPTER.fieldContainerSelector?l.closest(ADAPTER.fieldContainerSelector):null;if(wp&&root.contains(wp))return wp;if(hasCtrl(l))return l;if(l.tagName==="LABEL"&&l.htmlFor){const f=document.getElementById(l.htmlFor);if(f)return f.parentElement||f;}for(let s=l.nextElementSibling;s;s=s.nextElementSibling)if(hasCtrl(s))return s;for(let p=l.parentElement,d=0;d<3&&p&&p!==root;d++,p=p.parentElement)if(hasCtrl(p))return p;}return null;};`
    : "";

  const selectHelperSnippet = needsSelectHelpers
    ? `const itemText=el=>{if(!el)return"";const t=norm(el.getAttribute&&el.getAttribute("title")||"");if(t)return t;const sub=ADAPTER.selectedItemContentSelector?el.querySelector(ADAPTER.selectedItemContentSelector):null;if(sub)return norm(sub.textContent);const cl=el.cloneNode(true);if(ADAPTER.selectedItemRemoveSelector)cl.querySelectorAll(ADAPTER.selectedItemRemoveSelector).forEach(x=>x.remove());return norm(cl.textContent);};
const readSingleRootSelected=r=>{if(!r)return[];if(r.tagName==="SELECT")return[...(r.selectedOptions||[])].map(o=>norm(o.label||o.textContent||o.value)).filter(Boolean);const o=[...r.querySelectorAll(ADAPTER.selectedItemSelector)].map(itemText).filter(Boolean);if(o.length)return o;const cid=(r.getAttribute("aria-controls")||r.querySelector("[aria-controls]")?.getAttribute("aria-controls")||"").split(/\\s+/)[0];if(cid){const lb=document.getElementById(cid);if(lb){const ar=[...lb.querySelectorAll('[role="option"][aria-selected="true"]')].map(x=>norm(x.textContent)).filter(Boolean);if(ar.length)return ar;}}if(r.matches&&r.matches('input[role="combobox"],[role="combobox"]')){const v=norm(r.value??"");if(v)return[v];}return[];};
const readAllSelectedInScope=sc=>{const o=[];for(const s of qSelfOrAll(sc,"select"))for(const x of s.selectedOptions||[]){const t=norm(x.label||x.textContent||x.value);if(t)o.push(t);}for(const it of qSelfOrAll(sc,ADAPTER.selectedItemSelector)){const t=itemText(it);if(t)o.push(t);}return o;};
const readControlSelected=(sc,sel)=>{const el=sc.querySelector(sel);if(!el)return"";if(el.tagName==="SELECT")return readSingleRootSelected(el)[0]||"";const r=el.closest(ADAPTER.comboboxRootSelector)||el;return readSingleRootSelected(r)[0]||norm(el.value??"");};`
    : "";

  const pickScopeBody = needsFieldLabel
    ? `return c.fieldLabel?findFieldScope(b,c.fieldLabel):b;`
    : `return b;`;

  return [
    `const ADAPTER=${JSON.stringify(slimAdapter)},containerSel=${JSON.stringify(containerSelector || "")},checks=${JSON.stringify(subChecks)},baseIdx=${Number(baseIndex) || 0};`,
    `const norm=s=>String(s||"").replace(/\\s+/g," ").trim(),txtOf=e=>e?(e.innerText??e.textContent??""):"",normBtn=s=>norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g,"$1");`,
    `const leaveRe=ADAPTER.leaveClassPattern?new RegExp(ADAPTER.leaveClassPattern):null,hasAnim=e=>{try{return typeof e.getAnimations==="function"&&e.getAnimations({subtree:false}).some(a=>a.playState==="running");}catch{return false;}};`,
    `const isBox=(el,al)=>{if(!el)return false;for(let p=el;p&&p.nodeType===1;p=p.parentElement){if(p.hidden||p.getAttribute("aria-hidden")==="true")return false;if(!al&&leaveRe&&leaveRe.test(String(p.className||"")))return false;const s=typeof getComputedStyle==="function"?getComputedStyle(p):null;if(s&&(s.display==="none"||s.visibility==="hidden"||(!al&&Number(s.opacity)===0&&!hasAnim(p))))return false;}if(!el.getBoundingClientRect)return true;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};`,
    `const maxZ=e=>{let b=0;for(let p=e;p&&p!==document.documentElement;p=p.parentElement){const z=parseInt((typeof getComputedStyle==="function"?getComputedStyle(p).zIndex:"0"),10);if(Number.isFinite(z)&&z>b)b=z;}return b;};`,
    `const modals=al=>{const raw=[...document.querySelectorAll(ADAPTER.dialogSelector)].filter(m=>isBox(m,al));return raw.filter(m=>!raw.some(o=>o!==m&&o.contains(m))).map((m,i)=>({m,i,z:maxZ(m)})).sort((a,b)=>a.z!==b.z?a.z-b.z:a.i-b.i).map(x=>x.m);};`,
    `const dialogTitle=m=>{const id=m.getAttribute&&m.getAttribute("aria-labelledby");if(id){const l=document.getElementById(id);if(l)return norm(txtOf(l));}const h=m.querySelector(ADAPTER.dialogTitleSelector);return norm(h?txtOf(h):m.getAttribute("aria-label")||"");};`,
    `const qBox=sel=>{if(sel==="@topDialog")return modals(0).slice(-1)[0]||null;const a=[...document.querySelectorAll(sel)].filter(e=>isBox(e,0));if(a.length)return a.slice(-1)[0];const o=document.querySelector(sel);return isBox(o,0)?o:null;};`,
    `const defaultScope=containerSel?qBox(containerSel):(document.body||document.documentElement||document);`,
    `if(containerSel&&!defaultScope)return{pass:false,failedCheck:"container",expected:"容器存在: "+containerSel,actual:"容器不存在或正处于关闭离场动画"};`,
    qSelfSnippet,
    fieldLabelSnippet,
    selectHelperSnippet,
    `const pickScope=c=>{const b=(c.topmostModal||c.scope==="@topDialog"||c.scopeSelector==="@topDialog")?(modals(0).slice(-1)[0]||null):((c.scopeSelector||c.scope)?qBox(c.scopeSelector||c.scope):defaultScope);if(!b)return null;${pickScopeBody}};`,
    `const scopeText=s=>{const el=(s===document?(document.body||document.documentElement):s);return norm(txtOf(el));};`,
    `const evidence=[];`,
    `for(let i=0;i<checks.length;i+=1){const c=checks[i]||{},idx=baseIdx+i,checkId=c.id?String(c.id):(c.kind+"_"+idx),scope=pickScope(c);if(!scope&&c.kind!=="modals_count")return{pass:false,index:idx,kind:c.kind,expected:"作用域存在: "+(c.scopeSelector||c.scope||"@topDialog"),actual:"作用域不存在"};`,
    branches,
    fallback,
    `}`,
    `return{pass:true,checkedCount:checks.length,evidence};`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAssertStateBatches(
  containerSelector,
  checks = [],
  maxCodeLen = 6000,
  adapterSpec = DEFAULT_ADAPTER_SPEC,
) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return [{ baseIndex: 0, count: 0, code: buildSingleAssertScript(containerSelector, [], 0, adapterSpec) }];
  }
  const batches = [];
  let start = 0;
  while (start < checks.length) {
    let end = start + 1;
    let bestCode = buildSingleAssertScript(containerSelector, checks.slice(start, end), start, adapterSpec);
    while (end < checks.length) {
      const candidate = buildSingleAssertScript(containerSelector, checks.slice(start, end + 1), start, adapterSpec);
      if (candidate.length > maxCodeLen) break;
      bestCode = candidate;
      end += 1;
    }
    batches.push({ baseIndex: start, count: end - start, code: bestCode });
    start = end;
  }
  return batches;
}
