import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDocFromServer, onSnapshot, runTransaction, setDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
// Keep the old v4 browser keys for one-time migration into the raid tab.
const KEY = 'arc-planner-v1', BUILDS_KEY = 'arc-planner-builds-v1';
const STASH_KEY = 'arc-planner-stash-v5', STASH_BUILDS_KEY = 'arc-planner-stash-builds-v5';
const RAID_KEY = 'arc-planner-raid-v5', RAID_BUILDS_KEY = 'arc-planner-raid-builds-v5';
const STASH_MAX = 600, RAID_MAX = 120;
// Augment statistics from arcraiders.wiki/wiki/Augments (verified Oct 2026).
// Special category slots are additional to backpack, Quick Use and Safe Pocket.
const AUGMENTS = [
  ['free','Free Loadout Augment',14,4,0,35,['Light'],null,0],
  ['looting1','Looting Mk. 1',18,4,1,50,['Light'],null,0],
  ['combat1','Combat Mk. 1',16,4,1,45,['Light','Medium'],null,0],
  ['tactical1','Tactical Mk. 1',15,5,1,40,['Light','Medium'],null,0],
  ['looting2','Looting Mk. 2',22,4,2,60,['Light'],'Trinket',3],
  ['combat2','Combat Mk. 2',18,4,1,55,['Light','Medium','Heavy'],'Grenade',1],
  ['tactical2','Tactical Mk. 2',17,5,1,45,['Light','Medium'],'Utility',1],
  ['looting3c','Looting Mk. 3 (Cautious)',24,5,2,70,['Light'],null,0,'Binoculars'],
  ['looting3s','Looting Mk. 3 (Survivor)',20,5,3,80,['Light','Medium'],'Utility',1],
  ['looting3sk','Looting Mk. 3 (Safekeeper)',18,4,1,65,['Light','Medium','Heavy'],'Trinket',2],
  ['combat3a','Combat Mk. 3 (Aggressive)',18,4,1,65,['Light','Medium','Heavy'],'Grenade',2],
  ['combat3f','Combat Mk. 3 (Flanking)',20,5,2,60,['Light'],'Utility',3],
  ['tactical3d','Tactical Mk. 3 (Defensive)',20,5,1,60,['Light','Medium','Heavy'],null,0,'Shield Recharger'],
  ['tactical3h','Tactical Mk. 3 (Healing)',16,4,3,55,['Light','Medium'],'Healing',3],
  ['tactical3r','Tactical Mk. 3 (Revival)',16,5,2,65,['Light'],null,0,'Defibrillator'],
  ['tactical3s','Tactical Mk. 3 (Smoke)',19,5,2,50,['Light','Medium'],'Utility',2]
].map(([id,name,backpack,quick,safe,weight,shields,extraType,extraCount,integrated])=>({id,name,backpack,quick,safe,weight,shields,extraType,extraCount,integrated:integrated||''}));
const augmentById=id=>AUGMENTS.find(x=>x.id===id)||AUGMENTS[1];
const createGear=(id='looting1')=>{const a=augmentById(id);return {augmentId:a.id,shield:null,weapons:[null,null],quick:Array(a.quick).fill(null),safe:Array(a.safe).fill(null),augmented:Array(a.extraCount).fill(null),overflow:[]}};
function normalizeGear(x,legacyExtra=[]){
 const a=augmentById(x?.augmentId),base=createGear(a.id),overflow=Array.isArray(x?.overflow)?x.overflow.map(normSlot).filter(Boolean).slice(0,350):[];
 const fit=(source,count)=>{const xs=Array.isArray(source)?source.map(normSlot):[];overflow.push(...xs.slice(count).filter(Boolean));return Array.from({length:count},(_,i)=>xs[i]||null)};
 base.shield=normSlot(x?.shield);if(base.shield&&!canEquipShield(base.shield,a.id)){overflow.push(base.shield);base.shield=null}base.weapons=fit(x?.weapons,2);base.quick=fit(x?.quick,a.quick);base.safe=fit(x?.safe,a.safe);base.augmented=fit(x?.augmented,a.extraCount);
 base.overflow=[...overflow,...legacyExtra.map(normSlot).filter(Boolean)].slice(0,350);return base;
}

let area='stash';

const demoItems = [
  ['Magnet','Material'], ['Light Ammo','Ammo'], ['Frying Pan','Trinket'],
  ['Headphones','Trinket'], ['Leaper Pulse Unit','ARC'], ['Light Shield','Shield'],
  ['Ferro IV','Weapon'], ['Heavy Gun Parts','Material']
].map(([name,category],i)=>({id:`demo:${i}`,name,nameRu:'',category,rarity:'',image:'',source:'demo',stackMax:0,value:0}));
const initial = (which='stash')=>{const capacity=which==='stash'?64:18;return {capacity,columns:which==='stash'?10:4,slots:Array(capacity).fill(null),selectedSlot:null,...(which==='raid'?{raidGear:createGear()}: {})}};
const cache={stash:{state:initial('stash'),builds:[]},raid:{state:initial('raid'),builds:[]}};
let state=initial('stash'), builds=[],catalog=demoItems,shown=80,editingIndex=null,toastTimer=null;
const activePlanNames={stash:null,raid:null};
let allowCloudLogin=false,loginSubmitting=false;let resourcesOpen=false,resourceData=null,resourceSelection=new Set();
const RESOURCE_RECENT_KEY='raiders-recent-resources-v1';
let recentResourceIds=[];
try{
 const stored=JSON.parse(localStorage.getItem(RESOURCE_RECENT_KEY)||'[]');
 if(Array.isArray(stored))recentResourceIds=[...new Set(stored.filter(x=>typeof x==='string'))].slice(0,8);
}catch(error){console.warn('История ресурсов недоступна:',error)}
function rememberRecentResource(id){
 recentResourceIds=[id,...recentResourceIds.filter(x=>x!==id)].slice(0,8);
 try{localStorage.setItem(RESOURCE_RECENT_KEY,JSON.stringify(recentResourceIds))}
 catch(error){console.warn('История ресурсов не сохранена:',error)}
}
function renderRecentResources(items){
 const recent=recentResourceIds.filter(id=>items[id]);
 $('resourceHistory').hidden=recent.length===0;
 $('resourceHistory').innerHTML=recent.length?
  '<div class="resource-history-title">НЕДАВНО ИСКАЛИ</div><div class="resource-history-items">'+
  recent.map(id=>{
   const item=items[id];
   return `<button type="button" data-recent-resource="${esc(id)}" title="Добавить ${esc(item.name)}" aria-label="Добавить ${esc(item.name)}">${validImage(item.image)?`<img src="${esc(item.image)}" alt="" loading="lazy">`:'<span aria-hidden="true">⬡</span>'}<span>${esc(item.nameRu||item.name)}</span></button>`;
  }).join('')+'</div>':'';
}
let mode='loading',ready=false,auth=null,db=null,workspace=null,user=null,unsubscribe=null;
let remoteRevision=0, dirty=0,saved=0,saveBusy=false,halted=false,saveTimer=null,savingRevision=-1,sessionToken=0;
let pendingRemote=false,demoChosen=false,registerMode=false,sharedPreview=null;
let selectedGearRef='', openGearDropdown='';
const incomingShareId=new URLSearchParams(location.search).get('share');
const configured = ['apiKey','authDomain','projectId','appId'].every(k => typeof firebaseConfig[k]==='string' && !/PASTE|YOUR_PROJECT|_HERE/.test(firebaseConfig[k]) && firebaseConfig[k].trim().length>5);
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function validImage(u){return typeof u==='string' && /^https:\/\/[^\s"'<>]+$/i.test(u)?u:''}
function normSlot(s){if(!s||typeof s!=='object'||typeof s.name!=='string')return null;
  return {id:String(s.id||s.name).slice(0,150),name:s.name.slice(0,180),nameRu:String(s.nameRu||'').slice(0,180),image:validImage(s.image).slice(0,700),category:String(s.category||'').slice(0,100),rarity:String(s.rarity||'').slice(0,60),stackMax:Math.max(0,Math.min(9999,Number(s.stackMax)||0)),value:Number(s.value)||0,source:String(s.source||'').slice(0,30),collected:s.collected===true,qty:Math.max(1,Math.min(9999,parseInt(s.qty)||1))};
}
function normState(raw,which=area){
 if(which==='raid'){
  const gear=normalizeGear(raw?.raidGear);
  const a=augmentById(gear.augmentId);
  const source=Array.isArray(raw?.slots)?raw.slots.map(normSlot):[];
  const previous=Number(raw?.capacity)||source.length;
  // v5 was a flat configurable grid. Excess stacks are never silently deleted.
  const overflow=source.slice(a.backpack).filter(Boolean);
  if(overflow.length)gear.overflow.push(...overflow);
  return {capacity:a.backpack,columns:4,slots:Array.from({length:a.backpack},(_,i)=>source[i]||null),selectedSlot:null,raidGear:gear};
 }
 const cap=Math.max(1,Math.min(STASH_MAX,parseInt(raw?.capacity)||initial(which).capacity)),cols=Math.max(4,Math.min(12,parseInt(raw?.columns)||initial(which).columns));
 const slots=Array.isArray(raw?.slots)?raw.slots.slice(0,cap).map(normSlot):[];while(slots.length<cap)slots.push(null);
 return {capacity:cap,columns:cols,slots,selectedSlot:null};
}
function normBuilds(arr,which=area){return Array.isArray(arr)?arr.filter(b=>b&&typeof b.name==='string'&&Array.isArray(b.slots)).slice(0,30).map(b=>({...normState(b,which),name:b.name.slice(0,60),created:String(b.created||''),...(typeof b.shareId==='string'&&/^[a-f0-9]{32}$/.test(b.shareId)?{shareId:b.shareId}:{})})):[]}
function serializeState(){return {capacity:state.capacity,columns:state.columns,slots:state.slots.map(normSlot),...(area==='raid'?{raidGear:normalizeGear(state.raidGear)}:{})}}
function rememberArea(){cache[area]={state:normState(state,area),builds:normBuilds(builds,area)}}
function loadArea(){state=normState(cache[area].state,area);builds=normBuilds(cache[area].builds,area)}
function restore(){
 for(const which of ['stash','raid']){
  const stateKey=which==='stash'?STASH_KEY:RAID_KEY;
  const buildsKey=which==='stash'?STASH_BUILDS_KEY:RAID_BUILDS_KEY;
  try{const raw=JSON.parse(localStorage.getItem(stateKey)|| (which==='raid'?localStorage.getItem(KEY):'null') ||'null');if(raw)cache[which].state=normState(raw,which)}catch{}
  try{cache[which].builds=normBuilds(JSON.parse(localStorage.getItem(buildsKey)|| (which==='raid'?localStorage.getItem(BUILDS_KEY):'null') ||'[]'),which)}catch{}
 }
 loadArea();
}
function saveLocal(){rememberArea();if(mode==='cloud')return;
 try{localStorage.setItem(area==='stash'?STASH_KEY:RAID_KEY,JSON.stringify(serializeState()));localStorage.setItem(area==='stash'?STASH_BUILDS_KEY:RAID_BUILDS_KEY,JSON.stringify(builds))}catch{}
}
async function switchArea(next){
 if(!['stash','raid'].includes(next)||next===area)return true;
 if(!await guardPlanNavigation())return false;
 if(mode==='cloud'){
  if(!ready)return toast('Дождитесь подключения к облаку'),false;
  if(dirty>saved&&!halted)await saveCloud();
  if(dirty>saved || halted){toast('Есть несохранённые изменения. Экспортируйте JSON или обновите данные перед переключением.');return false}
 }
 rememberArea();closeEditor();closeGearDropdown();selectedGearRef='';$('shareLinkBox').hidden=true;
 area=next;loadArea();renderAll();
 if(mode==='cloud'&&auth?.currentUser)await startCloud(auth.currentUser);
 else if(mode==='demo')setStatus('Демо · сохранено только в браузере');
 return true;
}
$('areaStash').addEventListener('click',async()=>{if(resourcesOpen&&area==='stash'){leaveResources();return}if(!await switchArea('stash'))return;leaveResources()});
$('areaRaid').addEventListener('click',async()=>{if(!await switchArea('raid'))return;leaveResources()});
$('areaResources').addEventListener('click',async()=>{if(await guardPlanNavigation())openResources()});
function updateActiveSection(){
 const current=resourcesOpen?'areaResources':area==='stash'?'areaStash':'areaRaid';
 for(const id of ['areaStash','areaResources','areaRaid']){
  const active=id===current;
  $(id).classList.toggle('active',active);
  $(id).setAttribute('aria-selected',String(active));
  if(active)$(id).setAttribute('aria-current','page');
  else $(id).removeAttribute('aria-current');
 }
}
function leaveResources(){
 resourcesOpen=false;
 $('resourcesPanel').hidden=true;
 $('mainDashboard').hidden=false;
 updateActiveSection();
}
async function openResources(){
 resourcesOpen=true;
 $('mainDashboard').hidden=true;
 $('resourcesPanel').hidden=false;
 updateActiveSection();
 if(!resourceData){$('resourceResults').textContent='Загрузка рецептов…';try{const r=await fetch('./catalog/recipes.json',{cache:'no-cache'});if(!r.ok)throw Error('Данные рецептов ещё не опубликованы');resourceData=await r.json();}catch(e){$('resourceResults').textContent='Не удалось загрузить рецепты: '+e.message;return}}
 renderResources();
}
function renderResources(){
 if(!resourceData)return;
 const query=$('resourceSearch').value.toLocaleLowerCase().trim();
 const items=resourceData.items||{},recipes=resourceData.recipes||[];
 renderRecentResources(items);
 const resourceIds=query?[...new Set(recipes.flatMap(r=>r.ingredients.map(i=>i.id)))].filter(id=>items[id]&&!resourceSelection.has(id)&&[items[id].name,items[id].nameRu].join(' ').toLocaleLowerCase().includes(query)):[];
 $('resourceList').innerHTML=resourceIds.slice(0,120).map(id=>{
  const item=items[id],selected=resourceSelection.has(id);
  return `<button type="button" data-resource="${esc(id)}" class="${selected?'active':''}" aria-pressed="${selected}">${validImage(item.image)?`<img src="${esc(item.image)}" alt="">`:''}<span>${esc(item.name)}${item.nameRu?'<small> · '+esc(item.nameRu)+'</small>':''}</span>${selected?'<b>✓</b>':''}</button>`;
 }).join('');
 const selected=[...resourceSelection].filter(id=>items[id]);
 $('resourceChosen').innerHTML=selected.length?selected.map(id=>`<span class="resource-chip">${validImage(items[id].image)?`<img class="resource-chip-image" src="${esc(items[id].image)}" alt="" loading="lazy">`:'<span class="resource-chip-fallback" aria-hidden="true">⬡</span>'}<span class="resource-chip-name">${esc(items[id].nameRu||items[id].name)}</span><button type="button" data-remove-resource="${esc(id)}" aria-label="Убрать ${esc(items[id].name)}">×</button></span>`).join(''):'<span class="hint">Выбери один или несколько нужных ресурсов</span>';
 if(!selected.length){$('resourceResults').innerHTML='<p class="hint">Выбери нужные ресурсы. Рецепты будут отсортированы по минимальному количеству лишних ресурсов.</p>';return}
 const selectedSet=new Set(selected);
 // Coverage first, then fewer unnecessary tracked ingredients.
 const matches=recipes.map(recipe=>{
  const ids=new Set(recipe.ingredients.map(i=>i.id));
  const covered=selected.filter(id=>ids.has(id)).length;
  return {...recipe,covered,extra:recipe.ingredients.filter(i=>!selectedSet.has(i.id)).length};
 }).filter(x=>x.covered>0).sort((a,b)=>b.covered-a.covered||a.extra-b.extra||a.ingredients.length-b.ingredients.length);
 $('resourceResults').innerHTML=matches.slice(0,160).map(recipe=>{
  const item=items[recipe.id];if(!item)return '';
  return `<article class="recipe-card">
   <div class="recipe-head">${validImage(item.image)?`<img src="${esc(item.image)}" alt="">`:''}<div><h3>${esc(item.name)}</h3><small>${esc(item.nameRu||'')}</small></div></div>
   <p class="recipe-rank">НУЖНЫХ РЕСУРСОВ: ${recipe.covered}/${selected.length} · ДОПОЛНИТЕЛЬНЫХ: ${recipe.extra}</p>
   <div class="recipe-ingredient-list">${recipe.ingredients.map(ing=>{
    const resource=items[ing.id]||{name:ing.id,image:''},wanted=selectedSet.has(ing.id);
    return `<div class="recipe-ingredient ${wanted?'wanted':''}">${validImage(resource.image)?`<img loading="lazy" src="${esc(resource.image)}" alt="">`:'<span class="ingredient-fallback">◇</span>'}<span><b>${esc(resource.name)}</b><small>${esc(resource.nameRu||'')}</small></span>${wanted?'<span class="wanted-eye">👁</span>':''}</div>`;
   }).join('')}</div>
  </article>`;
 }).join('')||'<p class="hint">Для выбранных ресурсов рецептов не найдено.</p>';
}
$('resourceSearch').addEventListener('input',renderResources);
$('resourceList').addEventListener('click',e=>{
 const btn=e.target.closest('[data-resource]');if(!btn)return;
 const id=btn.dataset.resource;
 if(!resourceSelection.has(id))resourceSelection.add(id);
 rememberRecentResource(id);
 $('resourceSearch').value='';
 renderResources();
 $('resourceSearch').focus();
});
$('resourceChosen').addEventListener('click',e=>{const b=e.target.closest('[data-remove-resource]');if(!b)return;resourceSelection.delete(b.dataset.removeResource);renderResources()});
$('resourceHistory').addEventListener('click',e=>{
 const button=e.target.closest('[data-recent-resource]');if(!button)return;
 const id=button.dataset.recentResource;
 if(!resourceData?.items?.[id])return;
 resourceSelection.add(id);
 rememberRecentResource(id);
 $('resourceSearch').value='';
 renderResources();
 $('resourceSearch').focus();
});


let actionResolve=null;
function finishAction(value){
 if(!actionResolve)return;
 const resolve=actionResolve;actionResolve=null;
 $('actionOverlay').hidden=true;
 resolve(value);
}
function siteConfirm(message,title='Подтвердить действие'){
 return new Promise(resolve=>{
  if(actionResolve)finishAction(false);
  actionResolve=resolve;
  $('actionTitle').textContent=title;
  $('actionMessage').textContent=message;
  $('actionInput').hidden=true;$('actionInputLabel').hidden=true;$('actionDiscard').hidden=true;
  $('actionConfirm').classList.remove('danger-confirm');
  $('actionConfirm').firstChild.textContent='Подтвердить ';
  $('actionOverlay').hidden=false;
  $('actionConfirm').focus();
 });
}
function sitePrompt(message,defaultValue=''){
 return new Promise(resolve=>{
  if(actionResolve)finishAction(null);
  actionResolve=resolve;
  $('actionTitle').textContent='Введите название';
  $('actionMessage').textContent=message;
  $('actionInput').hidden=false;$('actionInputLabel').hidden=false;$('actionDiscard').hidden=true;
  $('actionInput').value=defaultValue;
  $('actionConfirm').firstChild.textContent='Сохранить ';
  $('actionOverlay').hidden=false;$('actionInput').focus();$('actionInput').select();
 });
}
$('actionForm').addEventListener('submit',e=>{
 e.preventDefault();
 finishAction($('actionDiscard').hidden?($('actionInput').hidden?true:$('actionInput').value):'save');
});
$('actionCancel').addEventListener('click',()=>finishAction($('actionInput').hidden?false:null));
$('actionOverlay').addEventListener('click',e=>{
 if(e.target===$('actionOverlay'))finishAction($('actionInput').hidden?false:null);
});
window.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&!$('actionOverlay').hidden){e.preventDefault();finishAction($('actionInput').hidden?false:null)}
});

async function guardPlanNavigation(){
 if(!activePlanNames[area]||!changedPlan())return true;
 const choice=await new Promise(resolve=>{
  if(actionResolve)finishAction(false);actionResolve=resolve;
  $('actionTitle').textContent='Сохранить изменения?';
  $('actionMessage').textContent='План «'+activePlanNames[area]+'» изменён. Сохранить перед переходом?';
  $('actionInput').hidden=true;$('actionInputLabel').hidden=true;$('actionDiscard').hidden=false;
  $('actionConfirm').firstChild.textContent='Сохранить ';$('actionOverlay').hidden=false;$('actionConfirm').focus();
 });
 if(choice==='save'){saveExistingPlanChanges();return true}
 if(choice==='discard'){const p=builds.find(b=>b.name===activePlanNames[area]);if(p){state=normState(p,area);renderAll()}return true}
 return false;
}
$('actionDiscard').addEventListener('click',()=>finishAction('discard'));
function setStatus(s){$('saveStatus').textContent=s}
function message(err){const code=err?.code||''; const messages={
 'auth/invalid-credential':'Неверный email или пароль.','auth/invalid-email':'Неверный формат email.',
 'auth/too-many-requests':'Слишком много попыток, попробуйте позднее.',
 'auth/network-request-failed':'Нет связи с Firebase.',
 'auth/email-already-in-use':'Этот адрес уже зарегистрирован. Войдите.',
 'auth/weak-password':'Пароль недостаточно надёжный (минимум 6 символов).',
 'auth/operation-not-allowed':'В Firebase Authentication нужно включить Email/Password.','permission-denied':'Нет доступа к базе. Проверьте опубликованные Firestore Rules.',
 'unavailable':'База временно недоступна. Проверьте интернет.'};
 return messages[code]||err?.message||'Неизвестная ошибка';
}
function toast(s){const t=$('toast');t.textContent=s;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,4500)}
function persist(){saveLocal();updatePlanControls();if(!ready)return;
 if(mode==='demo'){setStatus('Демо · сохранено только в браузере');return}
 if(mode!=='cloud'||halted)return;
 dirty++;setStatus('Сохраняется в Firebase…');clearTimeout(saveTimer);saveTimer=setTimeout(saveCloud,650);
}
function applyRemote(payload,rev,announce=false){activePlanNames[area]=null;state=normState(payload.state,area);builds=normBuilds(payload.builds,area);rememberArea();remoteRevision=rev;dirty=0;saved=0;halted=false;pendingRemote=false;saveLocal();renderAll();setStatus('Синхронизировано · версия '+rev);if(announce)toast('Получены изменения с другого компьютера')}
function stopCloud(){sessionToken++;if(unsubscribe){unsubscribe();unsubscribe=null}clearTimeout(saveTimer);ready=false;workspace=null;user=null;saveBusy=false;halted=false;dirty=0;saved=0;pendingRemote=false}
async function startCloud(u){stopCloud();const epoch=sessionToken;user=u;mode='cloud';setStatus('Загрузка облачных данных…');$('loginOverlay').hidden=true;$('logoutBtn').hidden=false;
 $('loginOpen').hidden=true;workspace=doc(db,'users',u.uid,'planner',area==='stash'?'stash':'main');
 try{const snapshot=await getDocFromServer(workspace);if(epoch!==sessionToken)return;
  const remote=snapshot.exists()?snapshot.data():null;
  let uploadLocal=false;
  if(remote){applyRemote(remote,Number(remote.revision)||0)}
  else {
   remoteRevision=0;
   const localHasChanges=state.slots.some(Boolean)||builds.length>0;
   uploadLocal=localHasChanges && await siteConfirm('В облаке пока нет сохранений. Перенести сюда текущий локальный инвентарь и сборки?');
   if(!uploadLocal){state=initial(area);builds=[];rememberArea();saveLocal();renderAll()}
  }
  ready=true;setStatus('Синхронизировано · версия '+remoteRevision);
  unsubscribe=onSnapshot(workspace,snap=>{
   if(epoch!==sessionToken||!ready)return;
   const rec=snap.exists()?snap.data():null;const rev=Number(rec?.revision)||0;
   if(rev<=remoteRevision || (saveBusy && rev===savingRevision))return;
   if(dirty>saved||saveBusy){halted=true;pendingRemote=true;setStatus('Конфликт с другим компьютером · экспортируйте копию');toast('Изменения появились на другом ПК. Экспортируйте свои правки и нажмите «Обновить».');return;}
   if(rec)applyRemote(rec,rev,true);
  },e=>{if(epoch===sessionToken){setStatus('Ошибка синхронизации: '+message(e));toast(message(e))}});
  if(uploadLocal){dirty++;saveLocal();await saveCloud()}
  fetchCatalog();
 }catch(err){if(epoch!==sessionToken)return;ready=false;
   $('loginOverlay').hidden=true;
   $('loginOpen').hidden=Boolean(auth?.currentUser);
   $('logoutBtn').hidden=!auth?.currentUser;
   setStatus('Вход сохранён · ошибка синхронизации: '+message(err));
   toast('Не удалось загрузить облачный склад. Попробуй «Обновить».');
 }
}
class ConflictError extends Error { constructor(){super('CONFLICT');this.code='CONFLICT'} }
async function saveCloud(){clearTimeout(saveTimer);if(mode!=='cloud'||!ready||saveBusy||halted||saved===dirty)return;
 saveBusy=true;const epoch=sessionToken;
 try{while(dirty>saved&&!halted&&epoch===sessionToken){
  const target=dirty;const payload={state:serializeState(),builds:normBuilds(builds)};
  const bytes=new Blob([JSON.stringify(payload)]).size;
  if(bytes>800000){halted=true;setStatus('Превышен лимит размера сборок · экспортируйте JSON');toast('Слишком много сохранённых сборок. Удалите ненужные или уменьшите размер изображений.');return}
  const expected=remoteRevision;
  savingRevision=expected+1;
  try{const next=await runTransaction(db,async tr=>{
   const snap=await tr.get(workspace),revision=snap.exists()?(Number(snap.data().revision)||0):0;
   if(revision!==expected)throw new ConflictError();
   tr.set(workspace,{revision:revision+1,...payload,updatedAt:new Date().toISOString()});
   return revision+1;
  });
   if(epoch!==sessionToken)return;
   remoteRevision=next;saved=target;setStatus('Синхронизировано · версия '+next);
  }catch(err){if(epoch!==sessionToken)return;
   if(err.code==='CONFLICT'){halted=true;pendingRemote=true;setStatus('Конфликт изменений: данные на другом ПК новее');toast('Облачная сборка изменилась. Сначала экспортируйте несохранённую версию в JSON.')}
   else{setStatus('Не сохранено в облаке · нажмите «Обновить» для повтора');toast(message(err))}
   return;
  }finally{savingRevision=-1}
 }
 }finally{saveBusy=false;}
}
async function refreshCloud(){if(mode==='cloud'&&!ready&&auth?.currentUser){await startCloud(auth.currentUser);return}
 if(mode==='demo'){toast('Демо работает только в этом браузере');return}
 if(!ready||!workspace)return toast('Нужно войти');
 if(dirty>saved){if(!await siteConfirm('Есть несохранённые изменения. Скачать их резервную копию JSON и загрузить облачную версию?'))return;downloadJSON({version:2,state:serializeState(),builds},'arc-unsaved-backup.json');}
 try{const snap=await getDocFromServer(workspace);if(snap.exists())applyRemote(snap.data(),Number(snap.data().revision)||0,true);else{applyRemote({state:initial(area),builds:[]},0);}
 }catch(err){toast('Не удалось загрузить: '+message(err))}
}
function demoLogin(){stopCloud();demoChosen=true;mode='demo';ready=true;$('loginOverlay').hidden=true;$('logoutBtn').hidden=true;$('loginOpen').hidden=false;restore();renderAll();setStatus('Демо · сохранено только в браузере');fetchCatalog()}
function setLogin(messageText=''){$('loginOverlay').hidden=false;$('loginMessage').textContent=messageText;$('logoutBtn').hidden=true;setStatus('Требуется вход в Firebase');}
async function initialize(){
 restore();renderAll();renderCatalog();
 if(!configured){demoLogin();setStatus('Гость · Firebase не настроен');return}
 setStatus('Проверяем сохранённую сессию…');
 try{
  const app=initializeApp(firebaseConfig);
  auth=getAuth(app);db=getFirestore(app);
  try{
   await setPersistence(auth,browserLocalPersistence);
  }catch(persistenceError){
   console.warn('Не удалось включить постоянную авторизацию:',persistenceError);
   setStatus('Вход может не сохраняться: браузер блокирует хранилище');
  }
  onAuthStateChanged(auth,async currentUser=>{
   if(loginSubmitting)return;
   if(currentUser){
    if(mode==='cloud'&&user?.uid===currentUser.uid&&ready)return;
    demoChosen=false;allowCloudLogin=true;
    await startCloud(currentUser);
   }else if(mode!=='demo'){
    allowCloudLogin=false;demoLogin();
   }else setStatus('Гость · локальные данные');
  },error=>{
   console.warn('Firebase auth error:',error);
   if(mode!=='demo')demoLogin();
   setStatus('Не удалось проверить вход: '+message(error));
  });
 }catch(error){
  console.warn('Firebase initialization error:',error);
  demoLogin();
  setStatus('Гость · ошибка Firebase: '+message(error));
 }
}
$('loginOpen').addEventListener('click',()=>setLogin());
function closeLogin(){
 $('loginOverlay').hidden=true;
 $('loginMessage').textContent='';
 $('loginPassword').value='';
 if(mode!=='cloud'||!ready){
   if(mode==='cloud'&&!ready){allowCloudLogin=false;demoLogin()}
   else setStatus('Гость · локальный режим');
 }
}
$('loginClose').addEventListener('click',closeLogin);
$('loginOverlay').addEventListener('click',e=>{if(e.target===$('loginOverlay'))closeLogin()});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('loginOverlay').hidden)closeLogin()});
$('signupToggle').addEventListener('click',()=>{
 registerMode=!registerMode;
 $('loginTitle').textContent=registerMode?'Создать аккаунт':'Войти в планировщик';
 $('authSubtitle').textContent=registerMode?'Личные сборки останутся доступными только вам. Пароль — не менее 6 символов.':'Используйте свою учётную запись Firebase. У каждого игрока собственные сборки.';
 $('authSubmit').textContent=registerMode?'Зарегистрироваться':'Войти и синхронизировать';
 $('signupToggle').textContent=registerMode?'У меня уже есть аккаунт':'Создать личный аккаунт';
 $('loginPassword').minLength=registerMode?6:1;
 $('loginPassword').autocomplete=registerMode?'new-password':'current-password';
 $('loginMessage').textContent='';
});
$('loginForm').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!configured||!auth||!db){$('loginMessage').textContent='Firebase недоступен. Можно продолжить как гость.';return}
 if(loginSubmitting)return;
 loginSubmitting=true;
 const btn=$('authSubmit');btn.disabled=true;
 $('loginMessage').textContent=registerMode?'Создаём аккаунт…':'Проверка email и пароля…';
 try{
  allowCloudLogin=true;
  const email=$('loginEmail').value.trim(),pass=$('loginPassword').value;
  await setPersistence(auth,browserLocalPersistence);
  const result=registerMode?await createUserWithEmailAndPassword(auth,email,pass):await signInWithEmailAndPassword(auth,email,pass);
  demoChosen=false;
  $('loginPassword').value='';
  // Explicitly load the cloud workspace even if Firebase sees the same logged-in UID.
  await startCloud(result.user);
 }catch(err){
  allowCloudLogin=false;
  $('loginMessage').textContent=message(err);
  setStatus('Гость · ошибка входа');
  if(mode==='cloud'&&!ready)demoLogin();
 }finally{loginSubmitting=false;btn.disabled=false}
});
$('demoMode').addEventListener('click',async()=>{if(auth?.currentUser)await signOut(auth);demoLogin()});
$('logoutBtn').addEventListener('click',async()=>{if(mode==='cloud'&&dirty>saved&&!await siteConfirm('Есть несохранённые изменения. Сначала экспортируйте JSON. Всё равно выйти?'))return;
 if(!await guardPlanNavigation())return;
 if(mode==='cloud'&&auth){allowCloudLogin=false;await signOut(auth);demoLogin()}else demoLogin()
});
$('syncRefresh').addEventListener('click',refreshCloud);
window.addEventListener('online',()=>{if(mode==='cloud'&&ready&&!halted&&dirty>saved)saveCloud()});
window.addEventListener('beforeunload',e=>{if(mode==='cloud'&&ready&&dirty>saved){e.preventDefault();e.returnValue=''}});

// Only physical inventory items are offered in the STASH catalog.
// This is a conservative category-based filter, not a game API entitlement check.
const NON_STASH_CATEGORIES=new Set(['outfits','outfit','cosmetic','cosmetics','furniture','design','research','stencil unlock','emote','skin','appearance']);
function isBlueprint(item){return /^(blueprint|blueprints)$/i.test(String(item?.category||'').trim())||/\bblueprint\b/i.test(item?.name||'')}
function isStashItem(item){
 const name=String(item?.name||''),category=String(item?.category||'').trim().toLowerCase();
 if(NON_STASH_CATEGORIES.has(category))return false;
 if(/\((outfit|skin|emote|backpack charm|backpack attachment|face style|colour|color)\)/i.test(name))return false;
 // Amplified weapons are real weapon variants and belong in STASH.
 if(/^amplification module\b/i.test(name))return false;
 if(/^amplified\s/i.test(name)&&category!=='weapon')return false;
 if(/^(coins|raider tokens|research points)$/i.test(name))return false;
 // Category "Stencil" may refer to a physical stencil; keep it until proven otherwise.
 if(category==='misc'&&/\b(face style|colour|color)\b/i.test(name))return false;
 return true;
}
function blueprintArtwork(item){
 const img=validImage(item?.image);
 return `<span class="bp-art">${img?`<img src="${esc(img)}" alt="" loading="lazy" onerror="this.hidden=true">`:'<span class="blueprint-fallback">▤</span>'}</span>`;
}
// STASH visual filter: leaves saved slots and their indices unchanged.
const STASH_CATEGORIES=[
 ['all','ВСЁ','Icon_AllItems.png','▦'],
 ['augment','АУГМЕНТЫ','Icon_Augment.png','▣'],
 ['shield','ЩИТЫ','Icon_Shield.png','⬡'],
 ['weapon','ОРУЖИЕ','Icon_Weapon.png','⌁'],
 ['ammo','ПАТРОНЫ','Icon_Ammo.png','▥'],
 ['mod','МОДИФИКАЦИИ','Icon_WeaponMod.png','⚙'],
 ['quick','РАСХОДНИКИ','Icon_QuickUse.png','✚'],
 ['key','КЛЮЧИ','Icon_Key.png','⚿'],
 ['material','МАТЕРИАЛЫ','Icon_Material.png','◉'],
 ['other','ПРОЧЕЕ','Icon_Misc.png','⬡'],
 ['research','ЧЕРТЕЖИ','Icon_Research.png','▤']
];
let stashFilter='all',stashSort='type';
function stashKind(item){
 const cat=String(item?.category||'').toLowerCase(),name=String(item?.name||'').toLowerCase();
 if(/shield|щит/.test(cat)||/^(light|medium|heavy) shield$/i.test(name))return 'shield';
 if(/blueprint|research|исслед|чертёж|чертеж/.test(cat)||/\bblueprint\b/i.test(name))return 'research';
 if(/augment|аугмент/.test(cat))return 'augment';
 if(/modification|attachment|weapon mod|модификац/.test(cat))return 'mod';
 if(/ammunition|ammo|патрон|боеприпас/.test(cat))return 'ammo';
 if(/weapon|rifle|shotgun|pistol|smg|lmg|hand cannon|оруж/.test(cat))return 'weapon';
 if(/quick use|consumable|utility|medical|grenade|healing|расход/.test(cat))return 'quick';
 if(/key|ключ/.test(cat))return 'key';
 if(/material|recyclable|nature|resource|crafting|trinket|материал|ресурс/.test(cat))return 'material';
 return 'other';
}
// Automatic STASH sorting affects only what is displayed, not Firestore or saved plans.
const STASH_RARITY_ORDER={common:1,uncommon:2,rare:3,epic:4,legendary:5,amplified:6};
function stashRarity(item){return isBlueprint(item)?0:(STASH_RARITY_ORDER[String(item?.rarity||'').trim().toLowerCase()]||0)}
function stashValue(item){return (Number(item?.value)||0)*Math.max(1,Number(item?.qty)||1)}
function stashTypeOrder(item){const n=STASH_CATEGORIES.findIndex(row=>row[0]===stashKind(item));return n<0?99:n}
function stashViewEntries(){
 const occupied=state.slots.map((item,index)=>({item,index})).filter(entry=>entry.item&&(stashFilter==='all'||stashKind(entry.item)===stashFilter));
 occupied.sort((a,b)=>{
  const aa=a.item,bb=b.item;
  const byType=stashTypeOrder(aa)-stashTypeOrder(bb);
  const byRarity=stashRarity(bb)-stashRarity(aa);
  const byWorth=stashValue(bb)-stashValue(aa);
  const byName=String(aa.nameRu||aa.name||'').localeCompare(String(bb.nameRu||bb.name||''),'ru',{sensitivity:'base'});
  let difference=0;
  if(stashSort==='none')difference=a.index-b.index;
  else if(stashSort==='rarity')difference=byRarity||byWorth||byType||byName;
  else if(stashSort==='value')difference=byWorth||byRarity||byType||byName;
  else if(stashSort==='name')difference=byName||byRarity||byWorth;
  else difference=byType||byRarity||byWorth||byName;
  return difference||a.index-b.index;
 });
 // An empty category shows EVERY available slot from the whole STASH.
 const free=state.slots.flatMap((item,index)=>item?[]:[{item:null,index}]);
 return occupied.concat(free);
}
function renderStashCategories(){
 $('stashCategoryBar').innerHTML=STASH_CATEGORIES.map(([id,label,icon,backup])=>{
  const count=state.slots.filter(x=>x&&(id==='all'||stashKind(x)===id)).length;
  const active=stashFilter===id;
  return `<button type="button" class="stash-category ${active?'active':''}" data-stash-category="${id}" aria-pressed="${active}" title="${label}"><span class="cat-icon"><img src="https://arcraiders.wiki/wiki/Special:Redirect/file/${icon}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="cat-fallback" hidden>${backup}</span></span><span class="cat-name">${label}</span><span class="cat-count">${count}</span></button>`;
 }).join('');
 const visible=state.slots.filter(x=>x&&(stashFilter==='all'||stashKind(x)===stashFilter)).length;
 const free=state.slots.filter(x=>!x).length;
 $('stashFilterCaption').textContent=(stashFilter==='all'?'ВСЕ ПРЕДМЕТЫ':STASH_CATEGORIES.find(x=>x[0]===stashFilter)[1])+' · ПРЕДМЕТОВ '+visible+' · СВОБОДНО '+free;
}
$('stashCategoryBar').addEventListener('click',e=>{
 const btn=e.target.closest('[data-stash-category]');if(!btn)return;
 stashFilter=btn.dataset.stashCategory;
 state.selectedSlot=null;renderGrid();
});
$('stashSort').addEventListener('change',e=>{
 if(!['none','type','rarity','name','value'].includes(e.target.value))return;
 stashSort=e.target.value;
 if(area==='stash')renderGrid();
});
function renderGrid(){const grid=$('inventory');grid.style.setProperty('--columns',state.columns);grid.dataset.columns=String(state.columns);const shownSlots=area==='stash'?stashViewEntries():state.slots.map((item,index)=>({item,index}));grid.innerHTML=shownSlots.map(({item:s,index:i},v)=>`<button class="slot ${s?'filled':''} ${s?.collected?'collected':''} ${isBlueprint(s)?'is-blueprint':''} ${state.selectedSlot===i?'selected':''}" data-slot="${i}" data-rarity="${esc(isBlueprint(s)?'':(s?.rarity||'').toLowerCase())}" draggable="${s?'true':'false'}" aria-label="${esc(s?s.name+' ×'+s.qty:'Пустая ячейка '+(v+1))}"><span class="slotnum">${String(v+1).padStart(2,'0')}</span>${s&&area==='stash'?'<span class="collected-toggle" role="checkbox" tabindex="0" data-collected-slot="'+i+'" aria-label="Предмет собран" aria-checked="'+Boolean(s.collected)+'">'+(s.collected?'✓':'')+'</span>':''}${s?(isBlueprint(s)?blueprintArtwork(s):(s.image?`<img src="${esc(s.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="empty-plus" style="display:none">▣</span>`:'<span class="empty-plus">▣</span>'))+`<span class="name" lang="en">${esc(s.name)}</span>${s.nameRu&&s.nameRu!==s.name?`<span class="name-ru" lang="ru">${esc(s.nameRu)}</span>`:''}<span class="qty">${s.qty}</span><span class="rarity"></span>`:'<span class="empty-plus">+</span>'}</button>`).join('');
 const used=state.slots.filter(Boolean).length;$('usedCount').textContent=used;$('totalCount').textContent=state.capacity;$('freeCount').textContent=state.capacity-used;$('itemCount').textContent=state.slots.reduce((n,s)=>n+(s?.qty||0),0)+(area==='raid'?['quick','safe','augmented','weapons'].reduce((t,k)=>t+state.raidGear[k].reduce((n,s)=>n+(s?.qty||0),0),0)+(state.raidGear.shield?.qty||0):0);$('capacity').value=state.capacity;$('columns').value=state.columns;
 if(area==='stash'){renderStashCategories();const done=state.slots.filter(x=>x?.collected).length;$('collectedCount').textContent=done;$('collectedTotal').textContent=used;$('collectedPercent').textContent=(used?Math.round(done/used*100):0)+'%';$('clearCollected').hidden=done===0;}
}

// ----- Dynamic game-style LOADOUTS -----
function catalogAugment(a){return catalog.find(x=>canonicalAugment(x.name)?.id===a.id)}
function canonicalAugment(name){if(!name)return null;const n=String(name).toLowerCase().replace(/[^a-z0-9]/g,'');return AUGMENTS.find(a=>a.name.toLowerCase().replace(/[^a-z0-9]/g,'')===n)||null}
function getRef(ref){
 const [kind,ix]=ref.split(':');const i=Number(ix);if(kind==='bag')return state.slots[i];const g=state.raidGear;
 if(kind==='shield')return g.shield;if(kind==='weapon')return g.weapons[i];if(kind==='quick')return g.quick[i];if(kind==='safe')return g.safe[i];if(kind==='aug')return g.augmented[i];if(kind==='overflow')return g.overflow[i];return null;
}
function putRef(ref,item){const [kind,ix]=ref.split(':'),i=Number(ix),g=state.raidGear;
 if(kind==='bag')state.slots[i]=item;else if(kind==='shield')g.shield=item;
 else if(kind==='weapon')g.weapons[i]=item;else if(kind==='quick')g.quick[i]=item;else if(kind==='safe')g.safe[i]=item;
 else if(kind==='aug')g.augmented[i]=item;else if(kind==='overflow')g.overflow[i]=item;
}
function compactOverflow(){state.raidGear.overflow=state.raidGear.overflow.filter(Boolean)}
function layoutAugment(id){
 if(area!=='raid')return;
 const a=augmentById(id);if(a.id===state.raidGear.augmentId)return;
 const old=state.raidGear,carry=[...old.overflow];
 const resize=(arr,n)=>{carry.push(...arr.slice(n).filter(Boolean));return Array.from({length:n},(_,i)=>arr[i]||null)};
 const slots=resize(state.slots,a.backpack);
 const quick=resize(old.quick,a.quick),safe=resize(old.safe,a.safe),augmented=(augmentById(old.augmentId).extraType===a.extraType?resize(old.augmented,a.extraCount):(carry.push(...old.augmented.filter(Boolean)),Array(a.extraCount).fill(null)));
 const shield=canEquipShield(old.shield,a.id)?old.shield:null;
 if(old.shield&&!shield)carry.push(old.shield);
 const dropped=carry.length-old.overflow.length;
 state={...state,capacity:a.backpack,columns:4,slots,selectedSlot:null,raidGear:{augmentId:a.id,shield,weapons:old.weapons,quick,safe,augmented,overflow:carry}};
 persist();renderAll();toast(`Выбран ${a.name}. ${old.shield&&!shield?'Несовместимый щит перенесён в «Не размещено». ':''}${dropped?'Сохранено вне слотов: '+dropped:'Структура ячеек обновлена.'}`);
}
function matchSlot(item,ref){const [kind,index]=ref.split(':');let n=(item?.name||'').toLowerCase(),c=(item?.category||'').toLowerCase();
 if(kind==='shield')return canEquipShield(item);
 if(kind==='weapon')return /weapon|rifle|pistol|shotgun|launcher|gun|оруж/i.test(c) || /ferro|anvil|stitcher|venator|bettina|torrente|renegade/i.test(n);
 if(kind==='quick')return /grenade|medical|healing|heal|consum|utility|gadget|deploy|trap|шприц|гранат|лечени|применени/i.test(n+' '+c);
 if(kind==='aug'){
  const type=augmentById(state.raidGear.augmentId).extraType;
  if(type==='Trinket')return /trinket|valuable|treasure|ценност|безделуш/i.test(c);
  if(type==='Grenade')return /grenade|гранат/i.test(n+' '+c);
  if(type==='Healing')return /heal|medical|bandage|med|лечен|бинт/i.test(n+' '+c);
  if(type==='Utility')return /utility|deployable|gadget|trap|device|усилител|устройств/i.test(n+' '+c);
 }
 return true;
}
function slotMarkup(ref,label='',gear=false){const item=getRef(ref),sh=ref.startsWith('shield')&&item?(item.name.match(/\b(Light|Medium|Heavy)\s+Shield\b/i)?.[1]||''):'';const wrong=item&&(!matchSlot(item,ref)||(sh&&!augmentById(state.raidGear.augmentId).shields.includes(sh)));
 return `<button type="button" class="raid-special ${gear?'gearslot':''} ${wrong?'incompatible':''} ${selectedGearRef===ref?'selected-gear':''}" data-ref="${esc(ref)}" draggable="${item?'true':'false'}" title="${esc(wrong?'Не соответствует игровому типу слота · ':'')}${esc(item?.name||label)}"><span class="slotnum">${esc(label)}</span>${item?(item.image?`<img src="${esc(item.image)}" alt="" loading="lazy">`:'<span class="empty-plus">◆</span>')+`<span class="name">${esc(item.nameRu||item.name)}</span><span class="qty">${item.qty}</span>`:'<span class="empty-plus">+</span>'}${wrong?'<span class="kind pillwarning">НЕ СООТВЕТСТВУЕТ</span>':''}</button>`;
}
function renderRaid(){if(area!=='raid')return;const a=augmentById(state.raidGear.augmentId),g=state.raidGear,chosen=catalogAugment(a);
 $('augmentSelector').innerHTML=(chosen?.image?`<img class="augment-icon" src="${esc(chosen.image)}" alt="" loading="lazy">`:'<span class="augment-fallback">▣</span>')+`<span class="name">${esc(a.name)}</span><span class="selector-caret" aria-hidden="true">▾</span>`;
 $('augmentDetails').textContent=`BACKPACK ${a.backpack} · QUICK USE ${a.quick} · SAFE POCKET ${a.safe} · AUGMENTED ${a.extraCount}${a.extraType?' ('+a.extraType+')':''} · Shield: ${a.shields.join('/')} ${a.integrated?' · '+a.integrated:''}`;
 $('raidWeight').textContent=`LIMIT ${a.weight} KG`;
 $('raidShield').innerHTML=slotMarkup('shield:0','SHIELD',true);
 $('raidGear').innerHTML=slotMarkup('weapon:0','WEAPON 1',true)+slotMarkup('weapon:1','WEAPON 2',true);
 $('raidQuick').innerHTML=g.quick.map((_,i)=>slotMarkup('quick:'+i,'QUICK '+(i+1))).join('');
 $('raidSafe').innerHTML=g.safe.map((_,i)=>slotMarkup('safe:'+i,'SAFE '+(i+1))).join('')||'<span class="hint">Нет защищённых карманов</span>';
 $('raidAugmented').innerHTML=g.augmented.map((_,i)=>slotMarkup('aug:'+i,(a.extraType||'BONUS').toUpperCase()+' '+(i+1))).join('') || (a.integrated?`<span class="hint">Встроено: ${esc(a.integrated)} (не занимает ячейку)</span>`:'<span class="hint">Нет специальных ячеек</span>');
 $('raidOverflowBox').hidden=!g.overflow.length;
 $('raidOverflow').innerHTML=g.overflow.map((_,i)=>slotMarkup('overflow:'+i,'+'+(i+1))).join('');
 $('raidOverflowCount').textContent=g.overflow.length;
 $('raidQuickCount').textContent=g.quick.filter(Boolean).length+'/'+a.quick;
 $('raidSafeCount').textContent=g.safe.filter(Boolean).length+'/'+a.safe;
 $('raidBagCount').textContent=state.slots.filter(Boolean).length+'/'+a.backpack;
 $('raidExtraTitle').textContent='AUGMENTED SLOTS '+(a.extraType?'· '+a.extraType.toUpperCase():'')+' '+g.augmented.filter(Boolean).length+'/'+a.extraCount;
}
// Only AUGMENT and SHIELD have inline dropdowns; no modal item picker.
const EQUIPPABLE_SHIELD_NAMES=['Light Shield','Medium Shield','Heavy Shield'];
function shieldTier(item){
 const match=String(item?.name||'').trim().match(/^(Light|Medium|Heavy)\s+Shield$/i);
 return match?match[1][0].toUpperCase()+match[1].slice(1).toLowerCase():null;
}
function isEquippableShield(item){return Boolean(shieldTier(item))}
function canEquipShield(item,augmentId=state.raidGear?.augmentId){
 if(!item)return true;
 const tier=shieldTier(item);
 return Boolean(tier && augmentById(augmentId).shields.includes(tier));
}
function availableShields(){
 const byName=new Map();
 for(const x of catalog.filter(isEquippableShield)){
  const key=x.name.trim().toLowerCase();if(!byName.has(key))byName.set(key,x);
 }
 return EQUIPPABLE_SHIELD_NAMES.map(name=>byName.get(name.toLowerCase())||{
  id:'builtin:shield:'+name.toLowerCase().replace(/\s+/g,'-'),name,nameRu:'',
  category:'Shield',rarity:'',image:'',source:'builtin',stackMax:1,value:0
 });
}
function closeGearDropdown(){openGearDropdown='';for(const id of ['augment','shield']){$(id+'Dropdown').hidden=true;$(id==='augment'?'augmentSelector':'raidShield').querySelector('[data-ref]')?.setAttribute('aria-expanded','false')} $('augmentSelector').setAttribute('aria-expanded','false');$('raidShield').querySelector('[data-ref]')?.setAttribute('aria-expanded','false');}
function openDropdown(kind){if(area!=='raid')return;
 if(openGearDropdown===kind){closeGearDropdown();return}
 closeGearDropdown();openGearDropdown=kind;
 $(kind+'Dropdown').hidden=false;
 if(kind==='augment'){$('augmentSelector').setAttribute('aria-expanded','true');$('augmentFilter').value='';renderAugmentOptions();$('augmentFilter').focus()}
 else{$('raidShield').querySelector('[data-ref]')?.setAttribute('aria-expanded','true');$('shieldFilter').value='';renderShieldOptions();$('shieldFilter').focus()}
}
function renderAugmentOptions(){const query=$('augmentFilter').value.trim().toLocaleLowerCase();
 const rows=AUGMENTS.filter(a=>a.name.toLocaleLowerCase().includes(query));
 $('augmentOptions').innerHTML=rows.map(a=>{const item=catalogAugment(a),current=a.id===state.raidGear.augmentId;
  return `<button type="button" role="option" aria-selected="${current}" class="dropdown-option ${current?'is-current':''}" data-choose-augment="${esc(a.id)}">${item?.image?`<img src="${esc(item.image)}" alt="">`:'<span class="dropdown-icon">▣</span>'}<span class="dropdown-option-label"><b>${esc(a.name)}</b><small>BACKPACK ${a.backpack} · QUICK ${a.quick} · SAFE ${a.safe}${a.extraCount?' · BONUS '+a.extraCount:''}</small></span>${current?'✓':''}</button>`}).join('')||'<p class="dropdown-empty">Аугменты не найдены</p>';
}
function renderShieldOptions(){
 const query=$('shieldFilter').value.trim().toLocaleLowerCase(),current=state.raidGear.shield;
 const rows=availableShields().filter(x=>canEquipShield(x)&&[x.name,x.nameRu].join(' ').toLocaleLowerCase().includes(query));
 const remove=!query&&current?'<button class="dropdown-option" type="button" data-clear-shield="true"><span class="dropdown-icon">×</span><span class="dropdown-option-label"><b>Снять щит</b><small>Очистить слот SHIELD</small></span></button>':'';
 $('shieldOptions').innerHTML=remove+rows.map(x=>{
  const selected=current?.name===x.name;
  return `<button type="button" role="option" aria-selected="${selected}" class="dropdown-option ${selected?'is-current':''}" data-choose-shield="${esc(x.id)}">${x.image?`<img src="${esc(x.image)}" alt="">`:'<span class="dropdown-icon">⬡</span>'}<span class="dropdown-option-label"><b>${esc(x.nameRu||x.name)}</b><small>Подходит для выбранного AUGMENT</small></span>${selected?'✓':''}</button>`;
 }).join('')||(!remove?'<p class="dropdown-empty">Для этого аугмента подходящих щитов нет</p>':'');
}
function setShield(item){
 if(!canEquipShield(item)){toast('Этот щит не поддерживается выбранным AUGMENT');return false}
 state.raidGear.shield=normSlot({...item,qty:1});selectedGearRef='';closeGearDropdown();persist();renderAll();return true;
}
$('augmentSelector').addEventListener('click',()=>openDropdown('augment'));
$('augmentFilter').addEventListener('input',renderAugmentOptions);
$('shieldFilter').addEventListener('input',renderShieldOptions);
$('augmentOptions').addEventListener('click',e=>{const b=e.target.closest('[data-choose-augment]');if(!b)return;closeGearDropdown();layoutAugment(b.dataset.chooseAugment)});
$('shieldOptions').addEventListener('click',e=>{const clear=e.target.closest('[data-clear-shield]');if(clear){putRef('shield:0',null);closeGearDropdown();persist();renderAll();return}
 const b=e.target.closest('[data-choose-shield]');if(!b)return;const item=availableShields().find(x=>x.id===b.dataset.chooseShield);if(item)setShield(item)});
document.addEventListener('click',e=>{if(!openGearDropdown)return;
 const anchor=openGearDropdown==='augment'?$('augmentSelector'):$('raidShield');
 if(!anchor.contains(e.target)&&!$(openGearDropdown+'Dropdown').contains(e.target))closeGearDropdown();
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&openGearDropdown){closeGearDropdown();e.stopPropagation()}});
function putCatalogRef(id,ref){const item=catalog.find(x=>x.id===id);if(!item)return toast('Предмет не найден');
 if(ref==='augment'){const a=canonicalAugment(item.name);if(a)layoutAugment(a.id);else toast('Этот предмет не является известным аугментом');return}
 if(ref==='shield:0'&&!canEquipShield(item)){toast('Этот щит не поддерживается выбранным AUGMENT');return}
  putRef(ref,normSlot({...item,qty:$('singleAdd').checked?1:Math.max(1,Number(item.stackMax)||1)}));compactOverflow();persist();renderAll();
}
function moveRef(from,to){if(from===to)return;if(from.startsWith('overflow')&&to.startsWith('overflow'))return;
 const a=getRef(from),b=getRef(to);if(!a)return;
 if(to==='augment'){const aug=canonicalAugment(a.name);if(aug){layoutAugment(aug.id)}else toast('На этот слот требуется аугмент');return}
 if((to==='shield:0'&&!canEquipShield(a))||(from==='shield:0'&&!canEquipShield(b))){toast('Слот SHIELD принимает только совместимые с AUGMENT щиты');return}
  putRef(to,a);putRef(from,b);compactOverflow();persist();renderAll();
}
$('raidLayout').addEventListener('click',e=>{
 const b=e.target.closest('[data-ref]');if(!b)return;
 const ref=b.dataset.ref;
 if(ref==='shield:0'){selectedGearRef='';openDropdown('shield');return}
 closeGearDropdown();selectedGearRef=ref;state.selectedSlot=null;
 if(getRef(ref))openEditor(ref);else{renderGrid();renderRaid();toast('Слот выбран. Нажми предмет в каталоге или перетащи его сюда.')}
});
$('raidLayout').addEventListener('dragstart',e=>{const b=e.target.closest('[data-ref]');if(b&&getRef(b.dataset.ref)){e.dataTransfer.setData('text/plain',JSON.stringify({kind:'ref',from:b.dataset.ref}));e.dataTransfer.effectAllowed='move'}});
$('raidLayout').addEventListener('dragover',e=>{if(e.target.closest('[data-ref],#augmentSelector'))e.preventDefault()});
$('raidLayout').addEventListener('drop',e=>{const b=e.target.closest('[data-ref],#augmentSelector');if(!b)return;e.preventDefault();let data;try{data=JSON.parse(e.dataTransfer.getData('text/plain'))}catch{return}const ref=b.id==='augmentSelector'?'augment':b.dataset.ref;
 selectedGearRef='';closeGearDropdown();if(data.kind==='catalog')putCatalogRef(data.id,ref);else if(data.kind==='slot')moveRef('bag:'+data.from,ref);else if(data.kind==='ref')moveRef(data.from,ref);
});
function planSnapshot(b){return JSON.stringify({capacity:b.capacity,columns:b.columns,slots:b.slots.map(normSlot),...(area==='raid'?{raidGear:normalizeGear(b.raidGear)}:{})})}
function changedPlan(){
 const plan=builds.find(b=>b.name===activePlanNames[area]);
 return Boolean(plan&&JSON.stringify(serializeState())!==planSnapshot(plan));
}
function updatePlanControls(){
 const exists=builds.some(b=>b.name===activePlanNames[area]);
 $('activePlanLabel').hidden=!exists;
 $('saveChanges').hidden=!exists||!changedPlan();
 if(exists)$('activePlanLabel').textContent='Открыт план: '+activePlanNames[area];
}
function saveExistingPlanChanges(){
 const name=activePlanNames[area],i=builds.findIndex(b=>b.name===name);
 if(!name||i<0)return toast('Сначала открой сохранённый план');
 if(!changedPlan())return updatePlanControls();
 builds[i]={...builds[i],...serializeState()};
 persist();renderSaves();toast('Сохранены изменения: '+name);
}
function renderSaves(){$('savedList').innerHTML=builds.length?builds.map((b,i)=>`<span class="saveitem" data-plan-index="${i}"><span class="plan-drag-handle" title="Перетащи для изменения порядка" aria-label="Переместить план">⠿</span><button data-load="${i}" class="small savename ${activePlanNames[area]===b.name?'active-plan':''}" title="Открыть сборку">${esc(b.name)}</button><button data-rename="${i}" class="small renameaction" title="Переименовать план" aria-label="Переименовать ${esc(b.name)}">✎</button><button data-share="${i}" class="small shareaction" title="Показать ссылку на опубликованную копию или опубликовать сборку">${b.shareId?'Ссылка':'Поделиться'}</button>${b.shareId?`<button data-revoke="${i}" class="small revokeaction" title="Отозвать доступ по ссылке">Отозвать</button>`:''}<button data-delete="${i}" title="Удалить сборку" aria-label="Удалить сборку">×</button></span>`).join(''):'<span class="muted" style="font-size:12px">Пока нет сохранённых сборок</span>';updatePlanControls()}
function renderAreaUi(){
 const stash=area==='stash';
 const plansPanel=$('plansPanel');
 const plansDestination=stash?$('plansTopAnchor'):$('plansBottomAnchor');
 if(plansPanel.parentElement!==plansDestination)plansDestination.appendChild(plansPanel);
 plansPanel.classList.toggle('plans-at-top',stash);
 updateActiveSection();
 $('workspaceTitle').textContent=stash?'МОЙ СКЛАД · STASH':'LOADOUTS';
 $('areaDescription').textContent=stash?'Модель хранилища в Сперанце. Каждый стак занимает отдельную ячейку.':'Отдельный план снаряжения и предметов для выхода на поверхность. Не меняет склад.';
 $('plansTitle').textContent=stash?'ПЛАНЫ СКЛАДА':'РЕЙДОВЫЕ СБОРКИ';
 $('saveBuild').textContent=stash?'Сохранить план склада':'Сохранить сборку';
 $('buildName').placeholder=stash?'Название плана (например: Основной склад)':'Название сборки (например: Фарм Бастиона)';
 $('capacity').max=stash?STASH_MAX:RAID_MAX;
 $('raidLayout').hidden=stash;$('stashGridHost').hidden=!stash;
 (stash?$('stashGridMount'):$('raidBackpackHost')).appendChild($('inventory'));
 $('capacity').disabled=!stash;$('columns').disabled=!stash;$('presets').hidden=!stash;
 $('capacity').closest('.control').hidden=!stash;$('columns').closest('.control').hidden=!stash;$('presets').closest('.control').hidden=!stash;
 $('gridHelp').textContent=stash?'Нажми пустую ячейку, затем предмет в каталоге. Перетаскивание и настройка количества доступны.':'AUGMENT и SHIELD раскрывают встроенные списки. Остальные ячейки — клик для выбора, затем предмет справа, либо перетаскивание. Излишки сохраняются в НЕ РАЗМЕЩЕНО.';
 const choices=stash?[64,88,112,136,160,184,208,232,256,280,304,328]:[12,16,18,20,24,30,36];
 $('presets').innerHTML=choices.map(n=>`<button class="small" data-capacity="${n}">${n}</button>`).join('');
 $('stashNote').hidden=!stash;
 $('exportPdf').hidden=!stash;
  if(catalog.length)categories();renderCatalog();
}
// Floating return-to-top button, shared by STASH and LOADOUTS.
const backToTop=$('backToTop');
function updateBackToTop(){backToTop.hidden=window.scrollY<280}
window.addEventListener('scroll',updateBackToTop,{passive:true});
backToTop.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
updateBackToTop();
function renderAll(){renderAreaUi();renderGrid();renderRaid();renderSaves()}
function renderCatalog(){
 const selected=$('catalogKind').value||'all';
 $('catalogKindIcons').innerHTML=STASH_CATEGORIES.map(c=>`<button type="button" class="${selected===c[0]?'active':''}" data-kind="${esc(c[0])}" title="${esc(c[1])}" aria-label="${esc(c[1])}" aria-pressed="${selected===c[0]}"><img src="https://arcraiders.wiki/wiki/Special:Redirect/file/${c[2]}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="kind-fallback" hidden>${esc(c[3])}</span></button>`).join('');
 const q=$('search').value.trim().toLocaleLowerCase(),cat=$('category').value,kind=$('catalogKind').value,sort=$('catalogSort').value;
 const arr=catalog.filter(x=>(area!=='stash'||isStashItem(x))&&(kind==='all'||stashKind(x)===kind)&&(!cat||x.category===cat)&&(!q||[x.name,x.nameRu,x.category,x.slug].join(' ').toLocaleLowerCase().includes(q)));
 if(sort==='rarity'){const rank={common:1,uncommon:2,rare:3,epic:4,legendary:5,amplified:6};arr.sort((a,b)=>(rank[String(b.rarity||'').toLowerCase()]||0)-(rank[String(a.rarity||'').toLowerCase()]||0)||a.name.localeCompare(b.name));}
 else if(sort==='name')arr.sort((a,b)=>a.name.localeCompare(b.name,'en'));
 else if(sort==='value')arr.sort((a,b)=>(Number(b.value)||0)-(Number(a.value)||0)||a.name.localeCompare(b.name));
 $('resultCount').textContent=arr.length+' / '+catalog.filter(x=>area!=='stash'||isStashItem(x)).length;
 $('catalogGrid').innerHTML=arr.slice(0,shown).map(x=>`<div class="catalog-item-wrap"><button class="item ${isBlueprint(x)?'is-blueprint':''}" data-rarity="${esc(isBlueprint(x)?'':String(x.rarity||'').toLowerCase())}" draggable="true" data-item="${esc(x.id)}">${isBlueprint(x)?blueprintArtwork(x):(validImage(x.image)?`<img src="${esc(x.image)}" loading="lazy" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="placeholder" style="display:none">◇</span>`:'<span class="placeholder">◇</span>')}<span class="itemdata"><span class="itemtitle">${esc(x.name)}</span>${x.nameRu&&x.nameRu!==x.name?`<span class="item-subname">${esc(x.nameRu)}</span>`:''}<span class="itemsubtitle">${esc(x.category||'Предмет')}${x.stackMax?' · Stack <strong>'+x.stackMax+'</strong>':''}</span>${isBlueprint(x)?'':`<span class="item-rarity">${esc(x.rarity||'Редкость не указана')}</span>`}</span></button>${x.source==='metaforge'&&/^[a-z0-9-]+$/.test(String(x.slug||''))?`<a class="item-meta-link" target="_blank" rel="noopener noreferrer" aria-label="Информация о ${esc(x.name)} на сайте MetaForge" href="https://metaforge.app/arc-raiders/database/item/${encodeURIComponent(x.slug)}">i</a>`:''}</div>`).join('')||'<div class="muted" style="padding:15px;grid-column:1/-1">Совпадений нет.</div>';
 $('showMore').hidden=arr.length<=shown;
}
function categories(){
 const selectedKind=$('catalogKind').value||'all';
 $('catalogKind').innerHTML=STASH_CATEGORIES.map(c=>`<option value="${esc(c[0])}">${esc(c[1])} ${esc(c[3])}</option>`).join('');
 $('catalogKind').value=STASH_CATEGORIES.some(x=>x[0]===selectedKind)?selectedKind:'all';
 const old=$('category').value,names=[...new Set(catalog.filter(x=>area!=='stash'||isStashItem(x)).map(x=>x.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b));$('category').innerHTML='<option value="">Все категории</option>'+names.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');if(names.includes(old))$('category').value=old}
// Prefer verified RU names; never present guessed machine translations as official.
// Search always indexes the English name, the verified Russian name and aliases.
const ITEM_RU_ALIASES={
 'anvil splitter':'Разделитель Наковальни',
 'amplification module mk. i':'Модуль амплификации I',
 'amplification module mk. ii':'Модуль амплификации II',
 'amplification module mk. iii':'Модуль амплификации III',
 'amplification module mk. iv':'Модуль амплификации IV',
 'amplification module mk. v':'Модуль амплификации V'
};
function applyItemNames(items){
 for(const item of items){
  if(!item.nameRu){
   const alias=ITEM_RU_ALIASES[String(item.name||'').toLowerCase()];
   if(alias)item.nameRu=alias;
  }
 }
 return enrichAmplifiedNames(items);
}
function enrichAmplifiedNames(items){
 const bases=new Map();
 for(const item of items){
  if(!item.nameRu)continue;
  const tier=item.name.match(/^(.+?) (?:I|II|III|IV)$/);
  if(tier){
   const ru=item.nameRu.replace(/ (?:I|II|III|IV)$/,'').trim();
   if(/[А-Яа-яЁё]/.test(ru))bases.set(tier[1].toLowerCase(),ru);
  }
 }
 for(const item of items){
  if(item.nameRu||!/^Amplified /i.test(item.name))continue;
  const match=item.name.match(/^Amplified (.+?)(?: \((.+)\))?$/i);
  if(match)item.nameRu='Усиленное оружие: '+(bases.get(match[1].toLowerCase())||match[1])+(match[2]?' ('+match[2]+')':'');
 }
 return items;
}
async function fetchCatalog(){const source=$('source').value,st=$('catalogStatus');st.textContent='Загрузка локального кэша '+source+'…';st.className='catalogstatus';$('refreshBtn').disabled=true;
 try{const res=await fetch('./catalog/'+source+'.json',{cache:'no-cache'});if(!res.ok)throw new Error('Файл каталога недоступен');const data=await res.json();if(source!==$('source').value)return;
  if(!Array.isArray(data.items)||!data.items.length)throw new Error('Каталог ещё не загружен. В GitHub → Actions запустите «Update ARC items catalog».');
  catalog=applyItemNames(data.items.map(x=>({...x,id:String(x.id),name:String(x.name),image:validImage(x.image),rarity:isBlueprint(x)?'':String(x.rarity||'')})));
  shown=80;categories();renderCatalog();syncCatalogMetadata();st.className='catalogstatus ok';st.textContent=`${catalog.length} предметов · ${source==='metaforge'?'MetaForge':'ARDB'} · обновлён ${data.updatedAt||'вручную'}`;
 }catch(err){if(source!==$('source').value)return;catalog=demoItems;shown=80;categories();renderCatalog();st.className='catalogstatus fail';st.textContent='Демонстрационный каталог (8 предметов). '+err.message}
 finally{$('refreshBtn').disabled=false}
}

function refreshSavedItem(item,byId,byName){
 if(!item)return false;
 const match=byId.get(item.id)||byName.get(String(item.name||'').trim().toLowerCase());
 if(!match||String(match.name||'').toLowerCase()!==String(item.name||'').toLowerCase())return false;
 let changed=false;
 const patch={nameRu:match.nameRu||item.nameRu||'',rarity:isBlueprint(item)?'':match.rarity,
   value:match.value,stackMax:match.stackMax||item.stackMax,image:match.image||item.image};
 for(const [key,val] of Object.entries(patch)){if(val!==undefined&&item[key]!==val){item[key]=val;changed=true}}
 return changed;
}
function syncCatalogMetadata(){
 if(area!=='stash'||mode!=='cloud'||!ready||halted||saveBusy||dirty>saved||!catalog.length)return;
 const byId=new Map(catalog.map(x=>[x.id,x])),byName=new Map(catalog.map(x=>[String(x.name||'').trim().toLowerCase(),x]));
 let changed=false;
 for(const item of state.slots)if(refreshSavedItem(item,byId,byName))changed=true;
 for(const plan of builds)for(const item of plan.slots||[])if(refreshSavedItem(item,byId,byName))changed=true;
 if(changed){persist();renderGrid();renderSaves();toast('Характеристики предметов обновлены')}
}
function firstEmpty(){return state.slots.findIndex(s=>!s)}
function addItem(id,target=state.selectedSlot){const item=catalog.find(x=>x.id===id);if(!item)return toast('Предмет не найден');if(area==='stash'&&!isStashItem(item))return toast('Этот предмет не хранится в STASH');if(target==null||target<0||target>=state.capacity)target=firstEmpty();if(target<0)return toast('Нет свободных ячеек');const qty=$('singleAdd').checked?1:Math.max(1,Number(item.stackMax)||1);state.slots[target]={...normSlot({...item,qty}),qty};state.selectedSlot=target;persist();renderGrid();renderRaid();toast('Добавлено: '+item.name)}
async function updateCapacity(input){if(area==='raid')return;const n=Math.max(1,Math.min(area==='stash'?STASH_MAX:RAID_MAX,parseInt(input)||1));if(n<state.capacity&&state.slots.slice(n).some(Boolean)&&!await siteConfirm('Удалить предметы из обрезаемых ячеек?')){$('capacity').value=state.capacity;return}
 state.slots=state.slots.slice(0,n);while(state.slots.length<n)state.slots.push(null);state.capacity=n;if(state.selectedSlot>=n)state.selectedSlot=null;persist();renderGrid()}
function openEditor(i){const item=typeof i==='string'?getRef(i):state.slots[i];if(!item)return;editingIndex=i;$('editTitle').textContent=item.nameRu||item.name;$('editImage').src=item.image||'';$('editImage').style.display=item.image?'block':'none';$('editInfo').textContent=(item.category||'Предмет')+(item.rarity?' · '+item.rarity:'');$('editQty').value=item.qty;$('editQty').max=item.stackMax||9999;$('stackHint').textContent=item.stackMax?'Максимальный стак по источнику: '+item.stackMax:'Размер стака не указан. Количество меняется вручную.';$('editOverlay').hidden=false;$('editQty').focus()}
function closeEditor(){editingIndex=null;$('editOverlay').hidden=true}
function validQty(){const item=typeof editingIndex==='string'?getRef(editingIndex):state.slots[editingIndex];return Math.max(1,Math.min(item?.stackMax||9999,parseInt($('editQty').value)||1))}
function applyQty(){if(editingIndex===null)return;(typeof editingIndex==='string'?getRef(editingIndex):state.slots[editingIndex]).qty=validQty();persist();renderGrid();renderRaid();closeEditor()}
async function saveBuild(){const name=$('buildName').value.trim()||'Сборка '+new Date().toLocaleString('ru-RU');if(builds.find(b=>b.name===name)?.shareId)return toast('Перед заменой опубликованной сборки отзовите её ссылку.');if(builds.some(b=>b.name===name)&&!await siteConfirm('Заменить сборку с этим именем?'))return;
 builds=builds.filter(b=>b.name!==name);builds.unshift({name,created:new Date().toISOString(),...JSON.parse(JSON.stringify(serializeState()))});builds=builds.slice(0,30);activePlanNames[area]=name;persist();$('buildName').value='';renderSaves();toast('Сборка сохранена: '+name)}
function applySaved(x,name=null){if(!x||!Array.isArray(x.slots))throw Error('Неверный формат инвентаря');activePlanNames[area]=name;state=normState(x);closeEditor();persist();renderAll()}
function downloadJSON(obj,name){const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
$('capacity').addEventListener('change',e=>updateCapacity(e.target.value));$('columns').addEventListener('change',e=>{state.columns=Number(e.target.value);persist();renderGrid()});$('presets').addEventListener('click',e=>{const b=e.target.closest('[data-capacity]');if(b)updateCapacity(b.dataset.capacity)});
$('clearCollected').addEventListener('click',async()=>{if(area!=='stash')return;const done=state.slots.filter(x=>x?.collected).length;if(!done)return;if(!await siteConfirm('Снять отметки со всех '+done+' собранных предметов?'))return;for(const item of state.slots)if(item)item.collected=false;persist();renderGrid();toast('Все галочки сняты')});
function toggleCollected(i){
 if(area!=='stash'||!state.slots[i])return;
 state.slots[i].collected=!state.slots[i].collected;
 persist();renderGrid();
}
$('inventory').addEventListener('keydown',e=>{
 const toggle=e.target.closest('[data-collected-slot]');
 if(toggle&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopPropagation();toggleCollected(Number(toggle.dataset.collectedSlot))}
});
const itemTooltip=$('itemTooltip');
function hideItemTooltip(){itemTooltip.hidden=true}
$('inventory').addEventListener('pointerover',e=>{
 const slot=e.target.closest('[data-slot]');if(!slot||area!=='stash')return;
 const item=state.slots[Number(slot.dataset.slot)];if(!item){hideItemTooltip();return}
 itemTooltip.innerHTML='<strong>'+esc(item.name)+'</strong>'+(item.nameRu?'<span class="tooltip-ru">'+esc(item.nameRu)+'</span>':'')+'<span class="tooltip-meta">×'+item.qty+(item.collected?' · Собрано':' · Не собрано')+'</span>';itemTooltip.hidden=false;
});
$('inventory').addEventListener('pointermove',e=>{if(itemTooltip.hidden)return;itemTooltip.style.left=Math.max(5,Math.min(innerWidth-280,e.clientX+16))+'px';itemTooltip.style.top=Math.max(5,Math.min(innerHeight-105,e.clientY+18))+'px'});
$('inventory').addEventListener('pointerleave',hideItemTooltip);
$('catalogGrid').addEventListener('pointerover',e=>{
 const card=e.target.closest('[data-item]');if(!card)return;
 const item=catalog.find(x=>x.id===card.dataset.item);if(!item)return;
 itemTooltip.innerHTML='<strong>'+esc(item.name)+'</strong>'+(item.nameRu?'<span class="tooltip-ru">'+esc(item.nameRu)+'</span>':'')+'<span class="tooltip-meta">'+esc(item.rarity||item.category||'')+'</span>';
 itemTooltip.hidden=false;
});
$('catalogGrid').addEventListener('pointermove',e=>{
 if(itemTooltip.hidden)return;
 itemTooltip.style.left=Math.max(5,Math.min(innerWidth-280,e.clientX+16))+'px';
 itemTooltip.style.top=Math.max(5,Math.min(innerHeight-105,e.clientY+18))+'px';
});
$('catalogGrid').addEventListener('pointerleave',hideItemTooltip);

$('inventory').addEventListener('click',e=>{const toggle=e.target.closest('[data-collected-slot]');if(toggle){e.stopPropagation();toggleCollected(Number(toggle.dataset.collectedSlot));return}const b=e.target.closest('[data-slot]');if(!b)return;const i=Number(b.dataset.slot);selectedGearRef='';closeGearDropdown();state.selectedSlot=i;renderGrid();renderRaid();if(state.slots[i])openEditor(i)});
$('catalogGrid').addEventListener('click',e=>{if(e.target.closest('.item-meta-link'))return;const b=e.target.closest('[data-item]');if(!b)return;if(area==='raid'&&selectedGearRef){const ref=selectedGearRef;selectedGearRef='';putCatalogRef(b.dataset.item,ref)}else addItem(b.dataset.item)});
$('catalogGrid').addEventListener('dragstart',e=>{const b=e.target.closest('[data-item]');if(b){e.dataTransfer.setData('text/plain',JSON.stringify({kind:'catalog',id:b.dataset.item}));e.dataTransfer.effectAllowed='copy'}});
// Drop a STASH item on the catalog to remove exactly that stack.
const catalogDropZone=$('catalogDropZone'),catalogDropHint=$('catalogDropHint');
let stashDragFrom=null;
function clearStashDropState(){
 stashDragFrom=null;catalogDropZone.classList.remove('can-remove','is-drop-ready');catalogDropHint.hidden=true;
}
function startStashDrop(from){
 if(area!=='stash'||!state.slots[from])return;
 stashDragFrom=from;catalogDropZone.classList.add('can-remove');catalogDropHint.hidden=false;
}
// Dragend is not reliable after renderGrid replaces the dragged DOM node.
$('inventory').addEventListener('dragend',clearStashDropState);
document.addEventListener('dragend',clearStashDropState,true);
document.addEventListener('drop',clearStashDropState);
window.addEventListener('blur',clearStashDropState);
catalogDropZone.addEventListener('dragenter',e=>{
 if(area==='stash'&&stashDragFrom!==null){e.preventDefault();catalogDropZone.classList.add('is-drop-ready')}
});
catalogDropZone.addEventListener('dragover',e=>{
 if(area==='stash'&&stashDragFrom!==null){e.preventDefault();e.dataTransfer.dropEffect='move';catalogDropZone.classList.add('is-drop-ready')}
});
catalogDropZone.addEventListener('dragleave',e=>{
 if(!catalogDropZone.contains(e.relatedTarget))catalogDropZone.classList.remove('is-drop-ready');
});
catalogDropZone.addEventListener('drop',e=>{
 if(area!=='stash'||stashDragFrom===null)return;
 e.preventDefault();e.stopPropagation();
 let payload;try{payload=JSON.parse(e.dataTransfer.getData('text/plain'))}catch{clearStashDropState();return}
 const from=Number(payload.from);
 if(payload.kind!=='slot'||!Number.isInteger(from)||from!==stashDragFrom||from<0||from>=state.capacity||!state.slots[from]){
  clearStashDropState();return;
 }
 const removed=state.slots[from].nameRu||state.slots[from].name;
 state.slots[from]=null;state.selectedSlot=null;clearStashDropState();persist();renderGrid();
 toast('Убрано из STASH: '+removed);
});
$('inventory').addEventListener('dragstart',e=>{const b=e.target.closest('[data-slot]');if(b&&state.slots[Number(b.dataset.slot)]){e.dataTransfer.setData('text/plain',JSON.stringify({kind:'slot',from:Number(b.dataset.slot)}));e.dataTransfer.effectAllowed='move';startStashDrop(Number(b.dataset.slot))}});
$('inventory').addEventListener('dragover',e=>{if(e.target.closest('[data-slot]'))e.preventDefault()});
$('inventory').addEventListener('drop',e=>{
 const b=e.target.closest('[data-slot]');
 if(!b){clearStashDropState();return}
 e.preventDefault();
 try{
  const to=Number(b.dataset.slot);
  const data=JSON.parse(e.dataTransfer.getData('text/plain'));
  if(data.kind==='catalog')addItem(data.id,to);
  else if(data.kind==='ref'&&area==='raid')moveRef(data.from,'bag:'+to);
  else if(data.kind==='slot'){
   const from=Number(data.from);
   if(from>=0&&from<state.capacity&&from!==to){
    [state.slots[from],state.slots[to]]=[state.slots[to],state.slots[from]];
    state.selectedSlot=to;
    persist();
    renderGrid();
   }
  }
 }catch(error){toast('Не удалось перенести предмет')}
 finally{
  // Always dismiss the remove-from-STASH prompt, including same-slot drops.
  clearStashDropState();
 }
});
$('catalogKind').addEventListener('change',renderCatalog);
$('catalogSort').addEventListener('change',()=>{
  const mode=$('catalogSort').value;
  if(!['rarity','name','value'].includes(mode))return;
  try{localStorage.setItem('raiders-catalog-sort-v1',mode)}catch(error){console.warn('Catalog sorting preference not saved:',error)}
  shown=80;renderCatalog();
});
$('catalogKindIcons').addEventListener('click',e=>{
 const button=e.target.closest('[data-kind]');if(!button)return;
 $('catalogKind').value=button.dataset.kind;
 $('category').value='';
 shown=80;renderCatalog();
});
$('search').addEventListener('input',()=>{shown=80;renderCatalog()});$('category').addEventListener('change',()=>{
 // Detailed category and game category icons are mutually exclusive filters.
 $('catalogKind').value='all';
 shown=80;renderCatalog();
});$('source').addEventListener('change',fetchCatalog);$('refreshBtn').addEventListener('click',fetchCatalog);$('showMore').addEventListener('click',()=>{shown+=80;renderCatalog()});
$('editQty').addEventListener('keydown',e=>{if(e.key==='Enter')applyQty();if(e.key==='Escape')closeEditor()});$('qtyMinus').addEventListener('click',()=>{$('editQty').value=Math.max(1,validQty()-1)});$('qtyPlus').addEventListener('click',()=>{$('editQty').value=Math.min(Number($('editQty').max),validQty()+1)});$('applyEdit').addEventListener('click',applyQty);$('closeEdit').addEventListener('click',closeEditor);$('editOverlay').addEventListener('click',e=>{if(e.target.id==='editOverlay')closeEditor()});window.addEventListener('keydown',e=>{if(e.key==='Escape')closeEditor()});
$('removeItem').addEventListener('click',()=>{if(editingIndex===null)return;if(typeof editingIndex==='string'){putRef(editingIndex,null);compactOverflow()}else state.slots[editingIndex]=null;persist();renderGrid();renderRaid();closeEditor()});$('duplicateItem').addEventListener('click',()=>{const ix=firstEmpty();if(ix<0)return toast('Нет свободных ячеек');state.slots[ix]={...(typeof editingIndex==='string'?getRef(editingIndex):state.slots[editingIndex]),qty:validQty()};state.selectedSlot=ix;persist();renderGrid();closeEditor()});
$('clearBtn').addEventListener('click',async()=>{if((state.slots.some(Boolean)||(area==='raid'&&(state.raidGear.overflow.length||state.raidGear.quick.some(Boolean)||state.raidGear.safe.some(Boolean)||state.raidGear.augmented.some(Boolean)||state.raidGear.weapons.some(Boolean)||state.raidGear.shield)))&&await siteConfirm(area==='stash'?'Очистить виртуальный склад?':'Очистить содержимое рейдовой сборки?')){state.slots=Array(state.capacity).fill(null);if(area==='raid')state.raidGear=createGear(state.raidGear.augmentId);state.selectedSlot=null;persist();renderAll()}});
$('saveBuild').addEventListener('click',saveBuild);
$('saveChanges').addEventListener('click',saveExistingPlanChanges);

let planPointer=null;
function planDropHint(index,after){
 for(const node of $('savedList').querySelectorAll('[data-plan-index]')){
  const idx=Number(node.dataset.planIndex);
  node.classList.toggle('plan-scoot-before',idx===index&&!after);
  node.classList.toggle('plan-scoot-after',idx===index&&after);
 }
}
function finishPlanPointer(cancel=false){
 const p=planPointer;if(!p)return;planPointer=null;
 if(p.handle.hasPointerCapture(p.pointerId))p.handle.releasePointerCapture(p.pointerId);
 p.ghost?.remove();
 $('savedList').querySelectorAll('.saveitem').forEach(n=>n.classList.remove('plan-dragging','plan-scoot-before','plan-scoot-after'));
 if(cancel||!p.moved||p.target===null)return;
 const result=[...builds],item=result.splice(p.from,1)[0];
 if(!item)return;
 const insert=p.target+(p.after?1:0)-(p.from<p.target+(p.after?1:0)?1:0);
 if(insert===p.from)return;
 result.splice(insert,0,item);builds=result;persist();renderSaves();toast('Порядок планов сохранён');
}
$('savedList').addEventListener('pointerdown',e=>{
 const handle=e.target.closest('.plan-drag-handle');if(!handle||e.button!==0)return;
 const node=handle.closest('[data-plan-index]');if(!node)return;
 e.preventDefault();const rect=node.getBoundingClientRect();
 planPointer={handle,pointerId:e.pointerId,from:Number(node.dataset.planIndex),startX:e.clientX,startY:e.clientY,offsetX:e.clientX-rect.left,offsetY:e.clientY-rect.top,target:null,after:false,moved:false,ghost:null};
 handle.setPointerCapture(e.pointerId);
});
$('savedList').addEventListener('pointermove',e=>{
 const p=planPointer;if(!p||p.pointerId!==e.pointerId)return;
 if(!p.moved&&Math.hypot(e.clientX-p.startX,e.clientY-p.startY)<5)return;
 if(!p.moved){
  p.moved=true;const node=p.handle.closest('[data-plan-index]'),rect=node.getBoundingClientRect();
  p.ghost=node.cloneNode(true);p.ghost.classList.add('plan-ghost');p.ghost.style.width=rect.width+'px';document.body.appendChild(p.ghost);node.classList.add('plan-dragging');
 }
 p.ghost.style.left=e.clientX-p.offsetX+'px';p.ghost.style.top=e.clientY-p.offsetY+'px';
 const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-plan-index]');
 if(!target||!$('savedList').contains(target)||Number(target.dataset.planIndex)===p.from){p.target=null;planDropHint(-1,false);return}
 const rect=target.getBoundingClientRect();p.target=Number(target.dataset.planIndex);p.after=e.clientX>=rect.left+rect.width/2;planDropHint(p.target,p.after);
});
$('savedList').addEventListener('pointerup',e=>{if(planPointer?.pointerId===e.pointerId)finishPlanPointer()});
$('savedList').addEventListener('pointercancel',e=>{if(planPointer?.pointerId===e.pointerId)finishPlanPointer(true)});
$('savedList').addEventListener('click',async e=>{
 const del=e.target.closest('[data-delete]'),load=e.target.closest('[data-load]'),share=e.target.closest('[data-share]'),revoke=e.target.closest('[data-revoke]'),rename=e.target.closest('[data-rename]');
 if(rename){
  const idx=Number(rename.dataset.rename),plan=builds[idx];if(!plan)return;
  const answer=await sitePrompt('Новое название плана:',plan.name);if(answer===null)return;
  const next=answer.trim();
  if(!next||next.length>60)return toast('Название должно содержать от 1 до 60 символов');
  if(next===plan.name)return;
  if(builds.some((b,i)=>i!==idx&&b.name===next))return toast('План с таким названием уже существует');
  const prev=plan.name;plan.name=next;
  if(activePlanNames[area]===prev)activePlanNames[area]=next;
  persist();renderSaves();toast('План переименован: '+next);
 }else if(share){await publishBuild(Number(share.dataset.share))}
 else if(revoke){const b=builds[Number(revoke.dataset.revoke)];if(b&&await siteConfirm('Отозвать публичную ссылку на «'+b.name+'»? Друг больше не сможет открыть её.'))await revokeBuild(b)}
 else if(del){const i=Number(del.dataset.delete),b=builds[i];if(!b||!await siteConfirm('Удалить сборку «'+b.name+'»?'))return;
  if(b.shareId&&!(await revokeBuild(b,true)))return;
  const index=builds.indexOf(b);if(index>=0){builds.splice(index,1);if(activePlanNames[area]===b.name)activePlanNames[area]=null;persist();renderSaves()}
 }else if(load){const b=builds[Number(load.dataset.load)];if(!b)return;if(activePlanNames[area]!==b.name&&!await guardPlanNavigation())return;applySaved(b,b.name);toast('Открыта сборка: '+b.name)}
});

function exportStashPDF(){
 if(area!=='stash'){toast('PDF доступен для STASH');return}
 const items=state.slots.map((item,index)=>({item,index})).filter(x=>x.item);
 const columns=Math.max(4,Math.min(12,state.columns)); // Respect user's on-screen column selection.
 const title=(activePlanNames.stash||'STASH').replace(/[<>]/g,'');
 const escapeHTML=esc;
 const unique='item-'+Date.now().toString(36)+'-';
 const cards=state.slots.map((item,i)=>{
  const id=unique+i;
  const isFilled=Boolean(item);
  return '<a class="cell '+(isFilled?'filled r-'+esc(isBlueprint(item)?'':String(item?.rarity||'').toLowerCase()):'empty')+'" '+(isFilled?'href="#'+id+'"':'')+' title="'+escapeHTML(item?.name||'Свободно')+'">'+
   '<small>'+(i+1)+'</small>'+
   (isFilled?(validImage(item.image)?'<img src="'+escapeHTML(item.image)+'" alt="">':'<span class="cube">◇</span>')+'<b>×'+Number(item.qty||1)+'</b>':'<span class="plus">+</span>')+
   '</a>';
 }).join('');
 const details=items.map(({item,index})=>'<section class="detail" id="'+unique+index+'"><b>Ячейка '+(index+1)+'</b>'+
 '<h3>'+escapeHTML(item.name)+'</h3>'+(item.nameRu?'<p>'+escapeHTML(item.nameRu)+'</p>':'')+
 '<p>Количество: '+Number(item.qty||1)+'</p><a href="#top">↑ К складу</a></section>').join('');
 const css="\n@page{size:180mm SHEET_HEIGHT;margin:8mm}\n:root{color-scheme:dark}\n*{box-sizing:border-box}\nhtml,body{background:#0c151d!important;color:#e6edf2!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}\nbody{margin:0;font:12px/1.4 Arial,'Segoe UI',sans-serif}\nheader{background:#192a34;border:1px solid #4c5c65;border-left:4px solid #efb75f;padding:14px 17px;margin-bottom:12px;break-after:avoid}\n.brand{font-size:10px;letter-spacing:1.5px;color:#edb76b;font-weight:800}\nh1{font-size:21px;margin:5px 0 6px;font-weight:800;letter-spacing:.6px}\n.muted{color:#a8bbc7;font-size:11px}\n.grid{display:grid;grid-template-columns:repeat(COL_COUNT,minmax(0,1fr));gap:3px;width:GRID_WIDTH;max-width:100%;margin:0 auto}\n.cell{aspect-ratio:1 / 1;height:auto;position:relative;display:flex;align-items:center;justify-content:center;border:1px solid #516572;border-radius:5px;text-decoration:none;color:#e8eef3;break-inside:avoid;overflow:hidden;background:#1e2c36}\n.cell.filled{border:2px solid #b98f54;background:radial-gradient(ellipse at 10% 100%,#3d3831,#1e2c36 70%)}\n.cell.r-common{border-color:#9faab2}.cell.r-uncommon{border-color:#5fb789}.cell.r-rare{border-color:#5bace1}\n.cell.r-epic{border-color:#bb7ed0}.cell.r-legendary{border-color:#ecb868}.cell.r-amplified{border-color:#df936c}\n.cell small{position:absolute;left:4px;top:2px;font-size:8px;color:#b6c3cb}\n.cell img{max-width:85%;max-height:75%;object-fit:contain}\n.cell b{position:absolute;bottom:2px;right:4px;font-size:11px;color:#fff}\n.plus,.cube{font-size:19px;color:#748a96}\n#details{break-before:auto;padding:6px 2px}\n#details h2{color:#edb86d;font-size:18px;border-bottom:1px solid #5e6c75;padding-bottom:8px}\n.detail{break-inside:avoid;background:#1b2b35;border-left:3px solid #dfab60;padding:10px 12px;margin:0 0 8px}\n.detail b{color:#f1c57f}.detail h3{font-size:14px;margin:5px 0;color:#fff}\n.detail p{color:#c3d1d9;margin:4px 0}.detail a{color:#edb86d;font-size:10px}\n@media screen{body{max-width:800px;margin:15px auto}}\n@media print{body{margin:0}.cell{height:auto;aspect-ratio:1 / 1}}\n".replace('COL_COUNT',String(columns)).replace('GRID_WIDTH',Math.min(480,columns*54)+'px');
 const rows=Math.ceil(state.capacity/columns);const pageHeight=Math.max(210,Math.ceil(47+rows*(Math.min(480,columns*54)/columns+3)*0.265+items.length*21+30));
 const dynamicCss=css.replace('SHEET_HEIGHT',pageHeight+'mm');
 const html='<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>'+escapeHTML(title)+' — RAIDER’S UTILITY</title><style>'+dynamicCss+'</style></head><body>'+
 '<header id="top"><div class="brand">KITTY_MARVINS · RAIDER’S UTILITY</div><h1>'+escapeHTML(title)+'</h1><div class="muted">STASH · '+state.capacity+' ячеек · '+items.length+' занято · '+(state.capacity-items.length)+' свободно</div></header>'+
 '<div class="grid">'+cards+'</div><article id="details"><h2>ПРЕДМЕТЫ</h2><p class="muted">Нажми на занятую ячейку в PDF, чтобы перейти к названию предмета.</p>'+details+'</article></body></html>';
 const blob=new Blob([html],{type:'text/html;charset=utf-8'});
 const url=URL.createObjectURL(blob);
 const printWindow=window.open(url,'_blank');
 if(!printWindow){URL.revokeObjectURL(url);toast('Разреши открывать новые вкладки для экспорта PDF');return}
 printWindow.addEventListener('load',()=>{
   // The browser print dialog creates PDF with working internal links in compatible viewers.
   setTimeout(()=>{try{printWindow.focus();printWindow.print()}catch(e){console.warn('PDF print:',e)}},450);
 },{once:true});
 setTimeout(()=>URL.revokeObjectURL(url),120000);
 toast('В окне печати выбери «Сохранить как PDF» и включи «Фоновая графика»');
}
$('exportPdf').addEventListener('click',exportStashPDF);

$('exportBtn').addEventListener('click',()=>downloadJSON({version:2,area,state:serializeState(),builds},area==='stash'?'arc-stash-plans.json':'arc-raid-builds.json'));
$('importBtn').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{const x=JSON.parse(await f.text());if(x.area&&x.area!==area){toast('Этот JSON относится к разделу «'+(x.area==='stash'?'Склад':'Рейд')+'». Переключитесь в него и повторите импорт.');return}if(x.version===2&&x.state&&Array.isArray(x.builds)){if(!await siteConfirm('Заменить все сохранённые сборки из JSON?'))return;builds=normBuilds(x.builds);applySaved(x.state);toast('Все сборки импортированы')}else{applySaved(x);toast('Инвентарь импортирован')}}catch(err){toast('Ошибка импорта: '+err.message)}finally{e.target.value=''}});

// --- Sharing only explicit snapshots. Every private workspace stays behind owner rules. ---
function shareUrl(id){const url=new URL(location.origin+location.pathname);url.searchParams.set('share',id);return url.toString()}
async function copyText(s){try{await navigator.clipboard.writeText(s);toast('Ссылка скопирована')}catch{sitePrompt('Скопируйте ссылку:',s)}}
let shareToastTimer=null,sharePointer={x:0,y:0};
document.addEventListener('pointermove',e=>{sharePointer={x:e.clientX,y:e.clientY}},{passive:true});
function cursorCopied(){
 const node=$('cursorToast');node.textContent='✓ Ссылка скопирована';node.hidden=false;
 node.style.left=Math.min(window.innerWidth-175,Math.max(8,sharePointer.x+14))+'px';
 node.style.top=Math.min(window.innerHeight-45,Math.max(8,sharePointer.y+15))+'px';
 clearTimeout(shareToastTimer);shareToastTimer=setTimeout(()=>node.hidden=true,1900);
}
async function revealShareLink(id){
 $('shareLinkBox').hidden=true;const url=shareUrl(id);
 try{await navigator.clipboard.writeText(url);cursorCopied()}
 catch(err){
  const textarea=document.createElement('textarea');textarea.value=url;textarea.style.position='fixed';textarea.style.opacity='0';
  document.body.append(textarea);textarea.select();const ok=document.execCommand('copy');textarea.remove();
  if(ok)cursorCopied();else await sitePrompt('Скопируй ссылку:',url);
 }
}
$('copyShareLink').addEventListener('click',()=>copyText($('shareLinkInput').value));
$('closeShareLink').addEventListener('click',()=>{$('shareLinkBox').hidden=true});
async function publishBuild(i){
 const b=builds[i];if(!b)return;
 if(mode!=='cloud'||!user||!ready){toast('Для публикации сборки войдите в личный аккаунт. Демо-сборки доступны только на этом ПК.');return}
 if(b.shareId){await revealShareLink(b.shareId);return}
 const id=crypto.randomUUID().replace(/-/g,'');
 const record={ownerUid:user.uid,name:b.name,area,build:{capacity:b.capacity,columns:b.columns,slots:b.slots.map(normSlot),...(area==='raid'?{raidGear:normalizeGear(b.raidGear)}:{})},createdAt:new Date().toISOString()};
 try{
  if(new Blob([JSON.stringify(record)]).size>700000)throw new Error('Слишком большая сборка для публикации');
  await setDoc(doc(db,'sharedBuilds',id),record);
  b.shareId=id;persist();renderSaves();await revealShareLink(id);
 }catch(err){toast('Не удалось опубликовать: '+message(err))}
}
async function revokeBuild(b,quiet=false){
 if(!b.shareId)return true;
 if(mode!=='cloud'||!user||!ready){toast('Для отзыва ссылки нужно войти в свой аккаунт');return false}
 try{await deleteDoc(doc(db,'sharedBuilds',b.shareId));delete b.shareId;if(!quiet){persist();renderSaves();toast('Ссылка отозвана')} $('shareLinkBox').hidden=true;return true}
 catch(err){toast('Не удалось отозвать ссылку: '+message(err));return false}
}
function showShareStatus(title,text){$('sharedTitle').textContent=title;$('sharedInfo').textContent=text;$('sharedGrid').innerHTML='';$('importShared').hidden=true;$('sharedOverlay').hidden=false}
async function openIncomingShare(id){
 if(!/^[0-9a-f]{32}$/.test(id||'')){showShareStatus('Неверная ссылка','Идентификатор сборки повреждён.');return}
 showShareStatus('Загрузка опубликованной сборки…','Читаем публичную копию из Firebase.');
 if(!db){showShareStatus('Firebase не настроен','Владелец сайта ещё не подключил Firebase.');return}
 try{
  const snap=await getDocFromServer(doc(db,'sharedBuilds',id));
  if(!snap.exists()){showShareStatus('Сборка не найдена','Автор удалил сборку или отозвал ссылку.');return}
  const record=snap.data();if(!record?.build||!record?.name)throw new Error('Неверный формат опубликованной сборки');
  const shareArea=record.area==='stash'?'stash':'raid';const build=normState(record.build,shareArea);sharedPreview={...build,area:shareArea,name:String(record.name).slice(0,60)};
  $('sharedTitle').textContent=sharedPreview.name;
  $('sharedInfo').textContent=(shareArea==='stash'?'СКЛАД':'РЕЙДОВАЯ СБОРКА '+augmentById(build.raidGear?.augmentId).name)+' · Ячеек: '+build.capacity+' · Предметов: '+build.slots.reduce((a,s)=>a+(s?.qty||0),0);$('importShared').textContent=shareArea==='stash'?'Скопировать в мой склад':'Скопировать в рейдовые сборки';
  $('sharedGrid').style.gridTemplateColumns='repeat('+Math.min(build.columns,8)+',minmax(0,1fr))';
  $('sharedGrid').innerHTML=build.slots.map(s=>`<div class="sharedslot">${s?(s.image?`<img src="${esc(s.image)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'')+`<span class="name">${esc(s.nameRu||s.name)}</span><span class="qty">${s.qty}</span>`:'<span class="muted">+</span>'}</div>`).join('');
  if(shareArea==='raid'){
   const g=build.raidGear;
   const extra=[['SHIELD',g.shield],...g.weapons.map((x,i)=>['WEAPON '+(i+1),x]),...g.quick.map((x,i)=>['QUICK '+(i+1),x]),...g.safe.map((x,i)=>['SAFE '+(i+1),x]),...g.augmented.map((x,i)=>['BONUS '+(i+1),x])];
   $('sharedGrid').insertAdjacentHTML('beforeend',extra.map(([label,s])=>`<div class="sharedslot" title="${esc(label)}"><small>${esc(label)}</small>${s?(s.image?`<img src="${esc(s.image)}" alt="">`:'')+`<span class="name">${esc(s.nameRu||s.name)}</span>`:'<span>+</span>'}</div>`).join(''));
  }
  $('importShared').hidden=false;
 }catch(err){showShareStatus('Не удалось открыть сборку',message(err))}
}
$('importShared').addEventListener('click',async()=>{
 if(!sharedPreview)return;
 if(mode==='cloud'&&!ready){toast('Подождите загрузки ваших сохранений');return}
 if(state.slots.some(Boolean)&&!await siteConfirm('Заменить текущие ячейки опубликованной сборкой? Сохранённые сборки останутся без изменений.'))return;
 if(mode!=='cloud'&&mode!=='demo')demoLogin();
 if(area!==sharedPreview.area && !(await switchArea(sharedPreview.area)))return;
 applySaved(sharedPreview);
 $('sharedOverlay').hidden=true;
 toast(mode==='cloud'?'Сборка скопирована и сохраняется в вашем аккаунте':'Сборка скопирована в локальное демо. Для облачного сохранения войдите.');
});
$('closeShared').addEventListener('click',()=>{
 $('sharedOverlay').hidden=true;
 const url=new URL(location.href);url.searchParams.delete('share');history.replaceState(null,'',url);
});

// Restore sorting preference before the first catalog render.
try{
 const savedSort=localStorage.getItem('raiders-catalog-sort-v1');
 $('catalogSort').value=['rarity','name','value'].includes(savedSort)?savedSort:'rarity';
}catch(error){$('catalogSort').value='rarity'}
initialize();
if(incomingShareId){
 // Wait for Firebase setup to finish; guests can view without signing in.
 Promise.resolve().then(async()=>{for(let retry=0;retry<10&&!db;retry++)await new Promise(r=>setTimeout(r,100));await openIncomingShare(incomingShareId)});
}
