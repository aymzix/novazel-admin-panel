"use strict";
(() => {
  const PAGE_SIZE = 24, MAX_FILE = 10 * 1024 * 1024;
  const config = window.NOVAZEL_ADMIN_CONFIG || {};
  const state = { token:null, email:null, demo:false, offset:0, auditOffset:0, discoverOffset:0, prefix:"", busy:false, previewUrl:null, tags:{ar:new Set(),en:new Set()}, demoAssets:[], demoAudit:[] };
  const $ = id => document.getElementById(id);
  const url = typeof config.supabaseUrl === "string" ? config.supabaseUrl.replace(/\/$/, "") : "";
  const key = typeof config.publishableKey === "string" ? config.publishableKey : "";
  const fn = typeof config.adminFunctionUrl === "string" && config.adminFunctionUrl ? config.adminFunctionUrl.replace(/\/$/, "") : (url ? `${url}/functions/v1/wallpaper-admin` : "");
  const configured = config.enableLive === true && /^https:\/\//.test(url) && key.length > 10 && !/YOUR|PLACEHOLDER|CHANGE_ME/i.test(`${url} ${key}`) && /^https:\/\//.test(fn);
  const imageTypes = new Set(["image/jpeg","image/png","image/webp","image/avif","image/gif"]);
  const statusLabel = {pending:"بانتظار المراجعة",verified:"معتمدة",rejected:"مرفوضة"};
  const normalizeTag = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu," ").trim();
  const now = () => new Date().toISOString();
  function msg(text, kind="info") { $("global-message").textContent=text; $("global-message").className=`message ${kind}`; $("global-message").hidden=!text; }
  function make(tag, cls, text) { const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=String(text ?? ""); return node; }
  function button(text, callback, cls="button button-quiet") { const node=make("button",cls,text); node.type="button"; node.onclick=callback; return node; }
  function empty(host,title,copy) { const node=$("empty-template").content.firstElementChild.cloneNode(true); node.querySelector("strong").textContent=title; node.querySelector("p").textContent=copy; host.replaceChildren(node); }
  function date(value) { const d=new Date(value); return value && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat("ar",{dateStyle:"medium",timeStyle:"short"}).format(d) : "—"; }
  function busy(value) { state.busy=value; document.body.classList.toggle("busy",value); ["refresh","refresh-audit","discover-refresh","upload-button","sign-in-button"].forEach(id=>$(id).disabled=value || (id==="sign-in-button"&&!configured)); }
  async function callAdmin(query="", options={}) {
    if(state.demo || !configured || !state.token)throw Error("الاتصال الحي معطل أو جلسة المشرف غير موثقة؛ لم يُرسل الطلب.");
    const r=await fetch(`${fn}${query}`,{...options,headers:{apikey:key,Authorization:`Bearer ${state.token}`,...(options.headers||{})},cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});
    const body=await r.json().catch(()=>({}));
    if(r.status===401)signOut(false);
    if(!r.ok) {
      const recovery=body.recovery?.objectRetained && typeof body.recovery.path==="string" ? ` احتُفظ بكائن خاص في: ${body.recovery.path}. قد توجد metadata بالفعل؛ اكتشف المسار وافحصه قبل الاستيراد مجددًا. لم يُحذف شيء.` : "";
      throw Error((body.error||`تعذر تنفيذ الطلب (${r.status}).`)+recovery);
    }
    return body;
  }
  const post = body => callAdmin("",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  function demoAudit(action,path,oldValue,newValue) { state.demoAudit.unshift({action,path,actorId:"demo-admin",createdAt:now(),details:{old:oldValue,new:newValue,synthetic:true}}); }
  function setTab(view) { document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===view)); ["review","discover","audit"].forEach(v=>$(v+"-view").hidden=v!==view); if(view==="audit")loadAudit(); if(view==="discover")loadDiscover(); }
  function tagForm(item, tag=null) {
    const form=make("form","tag-propose"), value=make("input");
    value.value=tag?.value||""; value.required=true; value.maxLength=80; value.placeholder=tag ? "تعديل الوسم يعيده pending" : "اقتراح وسم جديد";
    value.setAttribute("aria-label",tag?`تحرير ${tag.value}`:"وسم جديد");
    const submit=make("button","button button-quiet",tag?"إعادة اقتراح الوسم":"اقتراح وسم"); submit.type="submit";
    if(tag)form.append(make("small","asset-path",`المعرف: ${tag.id}`));
    form.append(value,submit);
    form.onsubmit=async event=>{event.preventDefault();await proposeTag(item.path,tag?.id,value.value.trim());};
    return form;
  }
  function assetCard(item) {
    const card=make("article","asset-card"), image=make("div","asset-image"), body=make("div","asset-content");
    if(item.previewUrl) { const img=make("img");img.src=item.previewUrl;img.alt=item.title||item.name||item.path;img.loading="lazy";img.referrerPolicy="no-referrer";image.append(img); }
    else image.textContent="لا معاينة موقعة قبل اعتماد metadata وجميع الوسوم";
    const heading=make("div","asset-title-row");heading.append(make("h3","asset-title",item.title||item.name||item.path),make("span",`status-pill status-${item.metadataStatus}`,statusLabel[item.metadataStatus]||item.metadataStatus));
    body.append(heading,make("div","asset-path",item.path));
    if(item.description)body.append(make("p","asset-description",item.description));
    body.append(make("div","asset-meta",`المقترح: ${item.proposedBy||"—"} · ${date(item.proposedAt)} · المراجع: ${item.reviewedBy||"—"} · ${date(item.reviewedAt)}`));
    const tags=make("div","asset-tags");
    for(const tag of item.tags||[]) {
      const entry=make("div","tag-entry");entry.append(make("span",`tag-chip tag-${tag.status}`,`${tag.value} · ${tag.status}`),make("small","asset-path",tag.id),tagForm(item,tag));
      if(item.metadataStatus==="verified" && tag.status==="pending")entry.append(button("اعتماد الوسم",()=>reviewTag(item.path,tag.id,"verified"),"mini-action"),button("رفض الوسم",()=>reviewTag(item.path,tag.id,"rejected"),"mini-action danger"));
      tags.append(entry);
    }
    if(!(item.tags||[]).length)tags.append(make("span","muted","لا توجد وسوم؛ يلزم اقتراح واعتماد وسم واحد على الأقل."));
    body.append(tags,tagForm(item));
    if(item.metadataStatus==="pending") { const actions=make("div","asset-actions");actions.append(button("اعتماد الصورة",()=>reviewAsset(item.path,"verified"),"button button-primary"),button("رفض الصورة",()=>reviewAsset(item.path,"rejected"),"button button-danger"));body.append(actions); }
    card.append(image,body);return card;
  }
  async function loadList() {
    const host=$("asset-list");
    try {
      let data;
      if(state.demo) { const q=normalizeTag($("search").value),status=$("status-filter").value;const rows=state.demoAssets.filter(a=>(status==="all"||a.metadataStatus===status)&&(!q||normalizeTag([a.path,a.title,...a.tags.map(t=>t.value)].join(" ")).includes(q)));data={items:rows.slice(state.offset,state.offset+PAGE_SIZE),count:rows.length}; }
      else data=await callAdmin(`?view=list&status=${encodeURIComponent($("status-filter").value)}&q=${encodeURIComponent($("search").value.trim())}&limit=${PAGE_SIZE}&offset=${state.offset}`);
      host.replaceChildren(...(data.items||[]).map(assetCard));if(!data.items?.length)empty(host,"لا توجد عناصر","غيّر التصفية أو استورد metadata لملف موجود.");
      $("result-count").textContent=`${data.count||0} عنصر`;$("pending-count").textContent=$("status-filter").value==="pending"?String(data.count||0):"—";
      $("page-label").textContent=`عرض ${data.items?.length?state.offset+1:0}–${Math.min(state.offset+(data.items?.length||0),data.count||0)} من ${data.count||0}`;
      $("previous-page").disabled=state.offset===0;$("next-page").disabled=state.offset+PAGE_SIZE>=(data.count||0)||state.offset>=2000;
    } catch(e) { empty(host,"تعذر تحميل القائمة",e.message);msg(e.message,"error"); }
  }
  const demoFiles = [{path:"archive",name:"archive",kind:"folder"},{path:"archive/synthetic.webp",name:"synthetic.webp",kind:"file",mimeType:"image/webp",size:123456},{path:"archive/readme.txt",name:"readme.txt",kind:"file",mimeType:"text/plain",size:20}];
  async function loadDiscover() {
    try {
      let data;
      if(state.demo) { const rows=demoFiles.filter(i=>(i.path.includes("/")?i.path.slice(0,i.path.lastIndexOf("/")):"")===state.prefix).map(i=>({...i,registered:state.demoAssets.some(a=>a.path===i.path),eligible:i.kind==="file"&&imageTypes.has(i.mimeType)&&!state.demoAssets.some(a=>a.path===i.path),reason:i.kind==="folder"?"folder":state.demoAssets.some(a=>a.path===i.path)?"duplicate_path":"unsupported_image"}));data={items:rows.slice(state.discoverOffset,state.discoverOffset+PAGE_SIZE),offset:state.discoverOffset,hasMore:rows.length>state.discoverOffset+PAGE_SIZE}; }
      else data=await callAdmin(`?view=discover&prefix=${encodeURIComponent(state.prefix)}&limit=${PAGE_SIZE}&offset=${state.discoverOffset}`);
      const rows=(data.items||[]).map(item=>{const row=make("article","discover-row");row.append(make("strong","discover-name",item.name),make("span","asset-path",item.path),make("span","discover-meta",item.kind==="folder"?"مجلد":`${item.mimeType||"—"} · ${item.size??"—"}`));if(item.kind==="folder")row.append(button("فتح المجلد",()=>{state.prefix=item.path;state.discoverOffset=0;loadDiscover();}));else if(item.eligible)row.append(button("استيراد pending بلا وسوم",()=>importAsset(item.path)));else row.append(make("span","muted",item.reason||"غير مؤهل"));return row;});
      $("discover-list").replaceChildren(...rows);$("discover-prefix").textContent=state.prefix||"/";$("discover-up").disabled=!state.prefix;$("discover-page-label").textContent=`${rows.length} عنصر · offset ${data.offset??state.discoverOffset}`;$("discover-prev").disabled=state.discoverOffset===0;$("discover-next").disabled=!data.hasMore;
    } catch(e) { msg(e.message,"error"); }
  }
  async function importAsset(path) {
    if(!window.confirm("تسجيل metadata جديدة pending فقط بلا وسوم، دون تغيير ملف التخزين؟"))return;
    busy(true);
    try {
      if(state.demo) { if(state.demoAssets.some(a=>a.path===path))throw Error("duplicate_path");const item={path,name:path.split("/").pop(),metadataStatus:"pending",tags:[],proposedBy:"demo-admin",proposedAt:now(),reviewedBy:null,reviewedAt:null};state.demoAssets.push(item);demoAudit("asset_imported",path,null,structuredClone(item)); }
      else await post({action:"import_asset",path});
      msg(state.demo?"dummy: أضيفت metadata اصطناعية للذاكرة فقط، بلا وسوم.":"تم تسجيل metadata pending بلا وسوم.","success");await loadDiscover();await loadList();
    } catch(e) { msg(e.message,"error"); } finally { busy(false); }
  }
  async function proposeTag(path,tagId,value) {
    if(!value || value.length>80)return msg("invalid_tag","error");
    busy(true);
    try {
      if(state.demo) {
        const item=state.demoAssets.find(a=>a.path===path);if(!item)throw Error("not_found");
        const old=tagId?item.tags.find(t=>t.id===tagId):null;if(tagId&&!old)throw Error("not_found");
        if(item.tags.some(t=>t.id!==tagId&&normalizeTag(t.value)===normalizeTag(value)))throw Error("duplicate_tag");
        const before=old?structuredClone(old):null;
        const tag=old||{id:`demo-${crypto.randomUUID()}`};Object.assign(tag,{value,status:"pending",proposedBy:"demo-admin",proposedAt:now(),reviewedBy:null,reviewedAt:null});if(!old)item.tags.push(tag);
        demoAudit("tag_proposed",path,before,structuredClone(tag));
      } else await post({action:"propose_tag",path,...(tagId?{tagId}:{}),value});
      msg(state.demo?"dummy: عاد الوسم pending في الذاكرة فقط.":"حُفظ الاقتراح pending، ومُسحت حقول المراجع.","success");await loadList();
    } catch(e) { msg(e.message,"error"); } finally { busy(false); }
  }
  async function reviewAsset(path,status) {
    if(!window.confirm("تسجيل قرار metadata؟ لن يصدر توقيع قبل اعتماد جميع الوسوم أيضًا."))return;
    try { if(state.demo) {const item=state.demoAssets.find(a=>a.path===path);if(!item||item.metadataStatus!=="pending")throw Error("asset_not_pending");const old=structuredClone(item);Object.assign(item,{metadataStatus:status,reviewedBy:"demo-admin",reviewedAt:now()});demoAudit("asset_"+status,path,old,structuredClone(item));}else await post({action:"review_asset",path,status});msg(state.demo?"dummy: سُجل القرار في الذاكرة فقط.":"سُجل قرار metadata.","success");await loadList(); }catch(e){msg(e.message,"error");}
  }
  async function reviewTag(path,tagId,status) {
    if(!window.confirm("تسجيل قرار الوسم؟"))return;
    try {if(state.demo){const item=state.demoAssets.find(a=>a.path===path),tag=item?.tags.find(t=>t.id===tagId);if(item?.metadataStatus!=="verified"||!tag||tag.status!=="pending")throw Error("tag_not_reviewable");const old=structuredClone(tag);Object.assign(tag,{status,reviewedBy:"demo-admin",reviewedAt:now()});demoAudit("tag_"+status,path,old,structuredClone(tag));}else await post({action:"review_tag",path,tagId,status});msg(state.demo?"dummy: قرار وسم في الذاكرة فقط.":"سُجل قرار الوسم.","success");await loadList();}catch(e){msg(e.message,"error");}
  }
  async function loadAudit() {
    try {const data=state.demo?{items:state.demoAudit.slice(state.auditOffset,state.auditOffset+PAGE_SIZE),count:state.demoAudit.length}:await callAdmin(`?view=audit&limit=${PAGE_SIZE}&offset=${state.auditOffset}`);const rows=(data.items||[]).map(entry=>{const row=make("article","audit-row");row.append(make("strong","",entry.action),make("span","",`الفاعل: ${entry.actorId||"النظام"}`),make("span","asset-path",entry.path),make("time","",date(entry.createdAt||entry.at)),make("pre","audit-details",JSON.stringify(entry.details||{},null,2)));return row;});$("audit-list").replaceChildren(...rows);if(!rows.length)empty($("audit-list"),"لا توجد أحداث","سجل التدقيق للقراءة فقط.");$("audit-page-label").textContent=`عرض ${rows.length?state.auditOffset+1:0}–${Math.min(state.auditOffset+rows.length,data.count||0)} من ${data.count||0}`;$("audit-prev").disabled=state.auditOffset===0;$("audit-next").disabled=state.auditOffset+PAGE_SIZE>=(data.count||0)||state.auditOffset>=2000;}catch(e){msg(e.message,"error");}
  }
  function addTags(language) {
    const input=$("tag-"+language), values=input.value.split(/[,،\n]/u).map(v=>v.trim()).filter(Boolean);
    for(const value of values){if(value.length>80||[...state.tags.ar,...state.tags.en].some(t=>normalizeTag(t)===normalizeTag(value)))continue;state.tags[language].add(value);}
    input.value="";$("tags-"+language).replaceChildren(...[...state.tags[language]].map(value=>{const chip=make("span","chip",value);chip.append(button("إزالة من المسودة",()=>{state.tags[language].delete(value);addTags(language);},"chip-remove"));return chip;}));
  }
  function showPreview(file) {if(state.previewUrl)URL.revokeObjectURL(state.previewUrl);state.previewUrl=null;const img=$("local-preview");if(file&&imageTypes.has(file.type)&&file.size<=MAX_FILE){state.previewUrl=URL.createObjectURL(file);img.src=state.previewUrl;img.hidden=false;$("file-label").textContent=file.name;}else{img.removeAttribute("src");img.hidden=true;$("file-label").textContent="اختر صورة من جهازك";}}
  async function upload(event) {
    event.preventDefault();busy(true);
    try {
      if(!state.demo&&(!configured||!state.token))throw Error("الاتصال معطل؛ لم يُرسل أي ملف.");
      const file=$("image-file").files[0];if(!file||!imageTypes.has(file.type)||file.size<1||file.size>MAX_FILE)throw Error("اختر ملف صورة مدعومًا بحجم 1–10 MiB.");
      addTags("ar");addTags("en");const tags=[...state.tags.ar,...state.tags.en];if(tags.length>40)throw Error("الحد 40 وسمًا.");
      if(state.demo){const path=`demo-upload/${file.name}`;if(state.demoAssets.some(a=>a.path===path))throw Error("duplicate_path");const item={path,name:file.name,title:$("asset-title").value,description:$("asset-description").value,metadataStatus:"pending",proposedBy:"demo-admin",proposedAt:now(),reviewedBy:null,reviewedAt:null,tags:tags.map(value=>({id:`demo-${crypto.randomUUID()}`,value,status:"pending",proposedBy:"demo-admin",proposedAt:now(),reviewedBy:null,reviewedAt:null}))};state.demoAssets.push(item);demoAudit("asset_proposed",path,null,structuredClone(item));}
      else {const form=new FormData();form.set("image",file);form.set("title",$("asset-title").value.trim());form.set("description",$("asset-description").value.trim());form.set("tags",JSON.stringify(tags));await callAdmin("",{method:"POST",body:form});}
      msg(state.demo?"dummy: metadata اصطناعية فقط؛ لم يُرفع أي ملف.":"رُفع الملف وسُجل pending.","success");state.offset=0;$("status-filter").value="pending";await loadList();
    }catch(e){msg(e.message,"error");}finally{busy(false);}
  }
  function signOut(show=true){state.token=null;state.email=null;state.demo=false;state.demoAssets=[];state.demoAudit=[];state.offset=state.auditOffset=state.discoverOffset=0;state.prefix="";state.tags={ar:new Set(),en:new Set()};$("password").value="";$("workspace").hidden=true;$("sign-in-panel").hidden=false;$("sign-out").hidden=true;$("admin-identity").hidden=true;$("demo-banner").hidden=true;showPreview(null);if(show)msg("انتهت الجلسة المحلية.");}
  function setDemo(){signOut(false);state.demo=true;state.email="demo-admin";const stamp=now();state.demoAssets=[{path:"demo/synthetic.webp",name:"synthetic.webp",metadataStatus:"verified",proposedBy:"demo-admin",proposedAt:stamp,reviewedBy:"demo-admin",reviewedAt:stamp,tags:[{id:"tone",value:"هادئ",status:"verified",proposedBy:"demo-admin",proposedAt:stamp,reviewedBy:"demo-admin",reviewedAt:stamp}]},{path:"demo/pending.png",name:"pending.png",metadataStatus:"pending",tags:[]}];$("workspace").hidden=false;$("sign-in-panel").hidden=true;$("sign-out").hidden=false;$("admin-identity").hidden=false;$("admin-identity").textContent="dummy محلي";$("demo-banner").hidden=false;$("status-filter").value="all";setTab("review");msg("وضع dummy: كل الإجراءات في ذاكرة الصفحة فقط. لا اتصال ولا صور فعلية.");loadList();}
  async function login(event){event.preventDefault();if(state.demo||!configured){$("password").value="";return msg("الإعداد المحلي مغلق؛ لم تُرسل بيانات.","error");}busy(true);try{const r=await fetch(`${url}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:key,"Content-Type":"application/json"},body:JSON.stringify({email:$("email").value.trim(),password:$("password").value}),cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});const session=await r.json();if(!r.ok||!session.access_token)throw Error("تعذر تسجيل الدخول.");state.token=session.access_token;state.email=session.user?.email||$("email").value.trim();await callAdmin("?view=list&limit=1&offset=0");/* A 200 is proof of the server-side active role check, NOT user_metadata. */$("workspace").hidden=false;$("sign-in-panel").hidden=true;$("sign-out").hidden=false;$("admin-identity").hidden=false;$("admin-identity").textContent=state.email;$("demo-banner").hidden=true;msg("تحقق الخادم من صلاحية المشرف.","success");setTab("review");await loadList();}catch(e){signOut(false);msg(e.message,"error");}finally{$("password").value="";busy(false);}}
  $("sign-in-form").onsubmit=login;$("upload-form").onsubmit=upload;$("image-file").onchange=()=>showPreview($("image-file").files[0]);
  document.querySelectorAll(".add-tag").forEach(b=>b.onclick=()=>addTags(b.dataset.input==="tag-ar"?"ar":"en"));
  $("demo-button").onclick=setDemo;$("sign-out").onclick=()=>signOut();document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>setTab(t.dataset.view));
  $("refresh").onclick=loadList;$("refresh-audit").onclick=loadAudit;$("discover-refresh").onclick=loadDiscover;
  $("discover-up").onclick=()=>{state.prefix=state.prefix.split("/").slice(0,-1).join("/");state.discoverOffset=0;loadDiscover();};
  $("discover-prev").onclick=()=>{state.discoverOffset=Math.max(0,state.discoverOffset-PAGE_SIZE);loadDiscover();};$("discover-next").onclick=()=>{state.discoverOffset+=PAGE_SIZE;loadDiscover();};
  $("previous-page").onclick=()=>{state.offset=Math.max(0,state.offset-PAGE_SIZE);loadList();};$("next-page").onclick=()=>{state.offset=Math.min(2000,state.offset+PAGE_SIZE);loadList();};
  $("audit-prev").onclick=()=>{state.auditOffset=Math.max(0,state.auditOffset-PAGE_SIZE);loadAudit();};$("audit-next").onclick=()=>{state.auditOffset=Math.min(2000,state.auditOffset+PAGE_SIZE);loadAudit();};
  $("status-filter").onchange=()=>{state.offset=0;loadList();};$("search").oninput=()=>{clearTimeout(state.debounce);state.debounce=setTimeout(()=>{state.offset=0;loadList();},300);};
  $("sign-in-button").disabled=!configured;$("config-hint").textContent=configured?"الإعداد مفعّل صراحة؛ لم تُنشأ جلسة بعد.":"dummy غير متصل؛ config فارغ وenableLive=false. لن تُرسل بيانات.";
  $("connection-state").textContent=configured?"إعداد اتصال متاح — لم تُثبت جلسة":"مسودة محلية غير متصلة";
  // Narrow debug hook only in explicitly local/dummy builds. Never contains production credentials.
  if(config.enableLive!==true)window.NovazelAdminTest={state,normalizeTag,normalizePath:normalizeTag,setDemo,signOut,loadList,loadAudit,loadDiscover,proposeTag,reviewTag,reviewAsset,importAsset,upload,login};
})();
