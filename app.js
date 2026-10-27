import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
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
 base.shield=normSlot(x?.shield);base.weapons=fit(x?.weapons,2);base.quick=fit(x?.quick,a.quick);base.safe=fit(x?.safe,a.safe);base.augmented=fit(x?.augmented,a.extraCount);
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
let mode='loading',ready=false,auth=null,db=null,workspace=null,user=null,unsubscribe=null;
let remoteRevision=0, dirty=0,saved=0,saveBusy=false,halted=false,saveTimer=null,savingRevision=-1,sessionToken=0;
let pendingRemote=false,demoChosen=false,registerMode=false,sharedPreview=null;
let selectedGearRef='', openGearDropdown='';
const incomingShareId=new URLSearchParams(location.search).get('share');
const configured = ['apiKey','authDomain','projectId','appId'].every(k => typeof firebaseConfig[k]==='string' && !/PASTE|YOUR_PROJECT|_HERE/.test(firebaseConfig[k]) && firebaseConfig[k].trim().length>5);
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function validImage(u){return typeof u==='string' && /^https:\/\/[^\s"'<>]+$/i.test(u)?u:''}
function normSlot(s){if(!s||typeof s!=='object'||typeof s.name!=='string')return null;
  return {id:String(s.id||s.name).slice(0,150),name:s.name.slice(0,180),nameRu:String(s.nameRu||'').slice(0,180),image:validImage(s.image).slice(0,700),category:String(s.category||'').slice(0,100),rarity:String(s.rarity||'').slice(0,60),stackMax:Math.max(0,Math.min(9999,Number(s.stackMax)||0)),value:Number(s.value)||0,source:String(s.source||'').slice(0,30),qty:Math.max(1,Math.min(9999,parseInt(s.qty)||1))};
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
$('areaStash').addEventListener('click',()=>switchArea('stash'));
$('areaRaid').addEventListener('click',()=>switchArea('raid'));

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
function persist(){saveLocal();if(!ready)return;
 if(mode==='demo'){setStatus('Демо · сохранено только в браузере');return}
 if(mode!=='cloud'||halted)return;
 dirty++;setStatus('Сохраняется в Firebase…');clearTimeout(saveTimer);saveTimer=setTimeout(saveCloud,650);
}
function applyRemote(payload,rev,announce=false){state=normState(payload.state,area);builds=normBuilds(payload.builds,area);rememberArea();remoteRevision=rev;dirty=0;saved=0;halted=false;pendingRemote=false;saveLocal();renderAll();setStatus('Синхронизировано · версия '+rev);if(announce)toast('Получены изменения с другого компьютера')}
function stopCloud(){sessionToken++;if(unsubscribe){unsubscribe();unsubscribe=null}clearTimeout(saveTimer);ready=false;workspace=null;user=null;saveBusy=false;halted=false;dirty=0;saved=0;pendingRemote=false}
async function startCloud(u){stopCloud();const epoch=sessionToken;user=u;mode='cloud';setStatus('Загрузка облачных данных…');$('loginOverlay').hidden=true;$('logoutBtn').hidden=false;
 workspace=doc(db,'users',u.uid,'planner',area==='stash'?'stash':'main');
 try{const snapshot=await getDocFromServer(workspace);if(epoch!==sessionToken)return;
  const remote=snapshot.exists()?snapshot.data():null;
  let uploadLocal=false;
  if(remote){applyRemote(remote,Number(remote.revision)||0)}
  else {
   remoteRevision=0;
   const localHasChanges=state.slots.some(Boolean)||builds.length>0;
   uploadLocal=localHasChanges && confirm('В облаке пока нет сохранений. Перенести сюда текущий локальный инвентарь и сборки?');
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
 }catch(err){if(epoch!==sessionToken)return;ready=false;setStatus('Ошибка: '+message(err));$('loginOverlay').hidden=false;$('loginMessage').textContent='Не удалось открыть базу: '+message(err);}
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
async function refreshCloud(){if(mode==='demo'){toast('Демо работает только в этом браузере');return}
 if(!ready||!workspace)return toast('Нужно войти');
 if(dirty>saved){if(!confirm('Есть несохранённые изменения. Скачать их резервную копию JSON и загрузить облачную версию?'))return;downloadJSON({version:2,state:serializeState(),builds},'arc-unsaved-backup.json');}
 try{const snap=await getDocFromServer(workspace);if(snap.exists())applyRemote(snap.data(),Number(snap.data().revision)||0,true);else{applyRemote({state:initial(area),builds:[]},0);}
 }catch(err){toast('Не удалось загрузить: '+message(err))}
}
function demoLogin(){stopCloud();demoChosen=true;mode='demo';ready=true;$('loginOverlay').hidden=true;$('logoutBtn').hidden=false;restore();renderAll();setStatus('Демо · сохранено только в браузере');fetchCatalog()}
function setLogin(messageText=''){$('loginOverlay').hidden=false;$('loginMessage').textContent=messageText;$('logoutBtn').hidden=true;setStatus('Требуется вход в Firebase');}
async function initialize(){restore();renderAll();renderCatalog();
 if(!configured){setLogin('Firebase ещё не настроен. Заполните firebase-config.js по инструкции или откройте локальное демо.');return}
 try{const app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);
  onAuthStateChanged(auth,async u=>{if(demoChosen)return;if(u)await startCloud(u);else{stopCloud();mode='login';state=initial(area);builds=[];rememberArea();renderAll();setLogin('Укажите пользователя, созданного в Firebase Authentication.')}},err=>setLogin(message(err)));
 }catch(err){setLogin('Ошибка Firebase: '+message(err))}
}
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
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();if(!configured||!auth){$('loginMessage').textContent='Сначала заполните firebase-config.js';return}
 const btn=$('authSubmit');btn.disabled=true;$('loginMessage').textContent=registerMode?'Создаём аккаунт…':'Проверка email и пароля…';
 try{demoChosen=false;const email=$('loginEmail').value.trim(),pass=$('loginPassword').value;
  if(registerMode)await createUserWithEmailAndPassword(auth,email,pass);
  else await signInWithEmailAndPassword(auth,email,pass);
  $('loginPassword').value='';$('loginMessage').textContent='';
 }catch(err){$('loginMessage').textContent=message(err)}finally{btn.disabled=false}
});
$('demoMode').addEventListener('click',async()=>{if(auth?.currentUser)await signOut(auth);demoLogin()});
$('logoutBtn').addEventListener('click',async()=>{if(mode==='cloud'&&dirty>saved&&!confirm('Есть несохранённые изменения. Сначала экспортируйте JSON. Всё равно выйти?'))return;
 if(mode==='cloud'&&auth)await signOut(auth);else{stopCloud();mode='login';setLogin('Демо завершено. Для синхронизации настройте Firebase.')}
});
$('syncRefresh').addEventListener('click',refreshCloud);
window.addEventListener('online',()=>{if(mode==='cloud'&&ready&&!halted&&dirty>saved)saveCloud()});
window.addEventListener('beforeunload',e=>{if(mode==='cloud'&&ready&&dirty>saved){e.preventDefault();e.returnValue=''}});

function renderGrid(){const grid=$('inventory');grid.style.setProperty('--columns',state.columns);grid.innerHTML=state.slots.map((s,i)=>`<button class="slot ${s?'filled':''} ${state.selectedSlot===i?'selected':''}" data-slot="${i}" data-rarity="${esc((s?.rarity||'').toLowerCase())}" title="${esc(s?s.name+' ×'+s.qty:'Пустая ячейка '+(i+1))}" draggable="${s?'true':'false'}" aria-label="${esc(s?s.name+' ×'+s.qty:'Пустая ячейка '+(i+1))}"><span class="slotnum">${String(i+1).padStart(2,'0')}</span>${s?(s.image?`<img src="${esc(s.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="empty-plus" style="display:none">▣</span>`:'<span class="empty-plus">▣</span>')+`<span class="name">${esc(s.nameRu||s.name)}</span><span class="qty">${s.qty}</span><span class="rarity"></span>`:'<span class="empty-plus">+</span>'}</button>`).join('');
 const used=state.slots.filter(Boolean).length;$('usedCount').textContent=used;$('totalCount').textContent=state.capacity;$('freeCount').textContent=state.capacity-used;$('itemCount').textContent=state.slots.reduce((n,s)=>n+(s?.qty||0),0)+(area==='raid'?['quick','safe','augmented','weapons'].reduce((t,k)=>t+state.raidGear[k].reduce((n,s)=>n+(s?.qty||0),0),0)+(state.raidGear.shield?.qty||0):0);$('capacity').value=state.capacity;$('columns').value=state.columns;
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
 const dropped=carry.length-old.overflow.length;
 state={...state,capacity:a.backpack,columns:4,slots,selectedSlot:null,raidGear:{augmentId:a.id,shield:old.shield,weapons:old.weapons,quick,safe,augmented,overflow:carry}};
 persist();renderAll();toast(`Выбран ${a.name}. ${dropped?'Неразмещённые предметы сохранены отдельно: '+dropped:'Структура ячеек обновлена.'}`);
}
function matchSlot(item,ref){const [kind,index]=ref.split(':');let n=(item?.name||'').toLowerCase(),c=(item?.category||'').toLowerCase();
 if(kind==='shield')return isEquippableShield(item);
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
 $('augmentSelector').innerHTML=(chosen?.image?`<img src="${esc(chosen.image)}" alt="" style="width:34px;height:34px;object-fit:contain">`:'')+`<span class="selector-label">${esc(a.name)}</span><span class="selector-caret">▾</span>`;
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
function isEquippableShield(item){
 const name=String(item?.name||'').trim(),category=String(item?.category||'').trim();
 // Avoid matches such as Shield Recharger, Shield Battery, and weapon names containing "shield".
 if(/recharg|charg|battery|cell|capacitor|repair|ammo|rifle|pistol|gun|launcher|weapon|grenade|kit|booster|replenish/i.test(name))return false;
 return /^(light|medium|heavy)\s+shield(?:\s+(?:mk\.?\s*\d+|[ivx]+))?$/i.test(name)
   || (/^shields?$/i.test(category) && /\bshield\b/i.test(name));
}
function availableShields(){
 const matching=catalog.filter(isEquippableShield),byName=new Map();
 for(const x of matching){const key=x.name.trim().toLowerCase();if(!byName.has(key))byName.set(key,x)}
 for(const name of EQUIPPABLE_SHIELD_NAMES){if(!byName.has(name.toLowerCase()))byName.set(name.toLowerCase(),{id:'builtin:shield:'+name.toLowerCase().replace(/\s+/g,'-'),name,nameRu:'',category:'Shield',rarity:'',image:'',source:'builtin',stackMax:1,value:0});}
 return [...byName.values()].sort((a,b)=>{const ai=EQUIPPABLE_SHIELD_NAMES.findIndex(n=>n.toLowerCase()===a.name.toLowerCase()),bi=EQUIPPABLE_SHIELD_NAMES.findIndex(n=>n.toLowerCase()===b.name.toLowerCase());return (ai<0?100:ai)-(bi<0?100:bi)||a.name.localeCompare(b.name)});
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
function renderShieldOptions(){const query=$('shieldFilter').value.trim().toLocaleLowerCase(),current=state.raidGear.shield;
 const rows=availableShields().filter(x=>[x.name,x.nameRu].join(' ').toLocaleLowerCase().includes(query));
 const remove=!query&&current?'<button class="dropdown-option" type="button" data-clear-shield="true"><span class="dropdown-icon">×</span><span class="dropdown-option-label"><b>Снять щит</b><small>Очистить слот SHIELD</small></span></button>':'';
 $('shieldOptions').innerHTML=remove+rows.map(x=>{const selected=current?.name===x.name,tier=x.name.match(/^(Light|Medium|Heavy)\s+Shield\b/i)?.[1]||'',compatible=!tier||augmentById(state.raidGear.augmentId).shields.includes(tier);
 return `<button type="button" role="option" aria-selected="${selected}" class="dropdown-option ${selected?'is-current':''}" data-choose-shield="${esc(x.id)}">${x.image?`<img src="${esc(x.image)}" alt="">`:'<span class="dropdown-icon">⬡</span>'}<span class="dropdown-option-label"><b>${esc(x.nameRu||x.name)}</b><small>${compatible?'Shield · подходит для AUGMENT':'Shield · ⚠ несовместим с AUGMENT'}</small></span>${selected?'✓':''}</button>`}).join('')||(!remove?'<p class="dropdown-empty">Подходящих щитов нет</p>':'');
}
function setShield(item){state.raidGear.shield=normSlot({...item,qty:1});selectedGearRef='';closeGearDropdown();persist();renderAll();}
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
 putRef(ref,normSlot({...item,qty:1}));compactOverflow();persist();renderAll();
}
function moveRef(from,to){if(from===to)return;if(from.startsWith('overflow')&&to.startsWith('overflow'))return;
 const a=getRef(from),b=getRef(to);if(!a)return;
 if(to==='augment'){const aug=canonicalAugment(a.name);if(aug){layoutAugment(aug.id)}else toast('На этот слот требуется аугмент');return}
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
function renderSaves(){$('savedList').innerHTML=builds.length?builds.map((b,i)=>`<span class="saveitem"><button data-load="${i}" class="small savename" title="Открыть сборку">${esc(b.name)}</button><button data-share="${i}" class="small shareaction" title="Показать ссылку на опубликованную копию или опубликовать сборку">${b.shareId?'Ссылка':'Поделиться'}</button>${b.shareId?`<button data-revoke="${i}" class="small revokeaction" title="Отозвать доступ по ссылке">Отозвать</button>`:''}<button data-delete="${i}" title="Удалить сборку" aria-label="Удалить сборку">×</button></span>`).join(''):'<span class="muted" style="font-size:12px">Пока нет сохранённых сборок</span>'}
function renderAreaUi(){
 const stash=area==='stash';
 $('areaStash').classList.toggle('active',stash);$('areaRaid').classList.toggle('active',!stash);
 $('areaStash').setAttribute('aria-selected',String(stash));$('areaRaid').setAttribute('aria-selected',String(!stash));
 $('workspaceTitle').textContent=stash?'МОЙ СКЛАД · STASH':'LOADOUTS';
 $('areaDescription').textContent=stash?'Модель хранилища в Сперанце. Каждый стак занимает отдельную ячейку.':'Отдельный план снаряжения и предметов для выхода на поверхность. Не меняет склад.';
 $('plansTitle').textContent=stash?'02 / ПЛАНЫ СКЛАДА':'02 / РЕЙДОВЫЕ СБОРКИ';
 $('saveBuild').textContent=stash?'Сохранить план склада':'Сохранить сборку';
 $('buildName').placeholder=stash?'Название плана (например: Основной склад)':'Название сборки (например: Фарм Бастиона)';
 $('capacity').max=stash?STASH_MAX:RAID_MAX;
 $('raidLayout').hidden=stash;$('stashGridHost').hidden=!stash;
 (stash?$('stashGridHost'):$('raidBackpackHost')).appendChild($('inventory'));
 $('capacity').disabled=!stash;$('columns').disabled=!stash;$('presets').hidden=!stash;
 $('capacity').closest('.control').hidden=!stash;$('columns').closest('.control').hidden=!stash;$('presets').closest('.control').hidden=!stash;
 $('gridHelp').textContent=stash?'Нажми пустую ячейку, затем предмет в каталоге. Перетаскивание и настройка количества доступны.':'AUGMENT и SHIELD раскрывают встроенные списки. Остальные ячейки — клик для выбора, затем предмет справа, либо перетаскивание. Излишки сохраняются в НЕ РАЗМЕЩЕНО.';
 const choices=stash?[64,88,112,136,160,184,208,232,256,280,304,328]:[12,16,18,20,24,30,36];
 $('presets').innerHTML=choices.map(n=>`<button class="small" data-capacity="${n}">${n}</button>`).join('');
 $('stashNote').hidden=!stash;
 $('exportAllBtn').textContent=stash?'Экспорт планов склада':'Экспорт рейдовых сборок';
}
function renderAll(){renderAreaUi();renderGrid();renderRaid();renderSaves()}
function renderCatalog(){const q=$('search').value.trim().toLocaleLowerCase(),cat=$('category').value;
 const arr=catalog.filter(x=>(!cat||x.category===cat)&&(!q||[x.name,x.nameRu,x.category,x.slug].join(' ').toLocaleLowerCase().includes(q)));
 $('resultCount').textContent=arr.length+' / '+catalog.length;
 $('catalogGrid').innerHTML=arr.slice(0,shown).map(x=>`<button class="item" draggable="true" data-item="${esc(x.id)}" title="Добавить ${esc(x.name)}">${validImage(x.image)?`<img src="${esc(x.image)}" loading="lazy" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="placeholder" style="display:none">◇</span>`:'<span class="placeholder">◇</span>'}<span class="itemdata"><span class="itemtitle">${esc(x.nameRu||x.name)}</span><span class="itemsubtitle">${esc(x.category||'Предмет')}${x.stackMax?' · стак '+x.stackMax:''}</span></span></button>`).join('')||'<div class="muted" style="padding:15px;grid-column:1/-1">Совпадений нет.</div>';
 $('showMore').hidden=arr.length<=shown;
}
function categories(){const old=$('category').value,names=[...new Set(catalog.map(x=>x.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b));$('category').innerHTML='<option value="">Все категории</option>'+names.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');if(names.includes(old))$('category').value=old}
async function fetchCatalog(){const source=$('source').value,st=$('catalogStatus');st.textContent='Загрузка локального кэша '+source+'…';st.className='catalogstatus';$('refreshBtn').disabled=true;
 try{const res=await fetch('./catalog/'+source+'.json',{cache:'no-cache'});if(!res.ok)throw new Error('Файл каталога недоступен');const data=await res.json();if(source!==$('source').value)return;
  if(!Array.isArray(data.items)||!data.items.length)throw new Error('Каталог ещё не загружен. В GitHub → Actions запустите «Update ARC items catalog».');
  catalog=data.items.map(x=>({...x,id:String(x.id),name:String(x.name),image:validImage(x.image)}));
  shown=80;categories();renderCatalog();st.className='catalogstatus ok';st.textContent=`${catalog.length} предметов · ${source==='metaforge'?'MetaForge':'ARDB'} · обновлён ${data.updatedAt||'вручную'}`;
 }catch(err){if(source!==$('source').value)return;catalog=demoItems;shown=80;categories();renderCatalog();st.className='catalogstatus fail';st.textContent='Демонстрационный каталог (8 предметов). '+err.message}
 finally{$('refreshBtn').disabled=false}
}
function firstEmpty(){return state.slots.findIndex(s=>!s)}
function addItem(id,target=state.selectedSlot){const item=catalog.find(x=>x.id===id);if(!item)return toast('Предмет не найден');if(target==null||target<0||target>=state.capacity)target=firstEmpty();if(target<0)return toast('Нет свободных ячеек');state.slots[target]={...normSlot({...item,qty:1}),qty:1};state.selectedSlot=target;persist();renderGrid();renderRaid();toast('Добавлено: '+item.name)}
function updateCapacity(input){if(area==='raid')return;const n=Math.max(1,Math.min(area==='stash'?STASH_MAX:RAID_MAX,parseInt(input)||1));if(n<state.capacity&&state.slots.slice(n).some(Boolean)&&!confirm('Удалить предметы из обрезаемых ячеек?')){$('capacity').value=state.capacity;return}
 state.slots=state.slots.slice(0,n);while(state.slots.length<n)state.slots.push(null);state.capacity=n;if(state.selectedSlot>=n)state.selectedSlot=null;persist();renderGrid()}
function openEditor(i){const item=typeof i==='string'?getRef(i):state.slots[i];if(!item)return;editingIndex=i;$('editTitle').textContent=item.nameRu||item.name;$('editImage').src=item.image||'';$('editImage').style.display=item.image?'block':'none';$('editInfo').textContent=(item.category||'Предмет')+(item.rarity?' · '+item.rarity:'');$('editQty').value=item.qty;$('editQty').max=item.stackMax||9999;$('stackHint').textContent=item.stackMax?'Максимальный стак по источнику: '+item.stackMax:'Размер стака не указан. Количество меняется вручную.';$('editOverlay').hidden=false;$('editQty').focus()}
function closeEditor(){editingIndex=null;$('editOverlay').hidden=true}
function validQty(){const item=typeof editingIndex==='string'?getRef(editingIndex):state.slots[editingIndex];return Math.max(1,Math.min(item?.stackMax||9999,parseInt($('editQty').value)||1))}
function applyQty(){if(editingIndex===null)return;(typeof editingIndex==='string'?getRef(editingIndex):state.slots[editingIndex]).qty=validQty();persist();renderGrid();renderRaid();closeEditor()}
function saveBuild(){const name=$('buildName').value.trim()||'Сборка '+new Date().toLocaleString('ru-RU');if(builds.find(b=>b.name===name)?.shareId)return toast('Перед заменой опубликованной сборки отзовите её ссылку.');if(builds.some(b=>b.name===name)&&!confirm('Заменить сборку с этим именем?'))return;
 builds=builds.filter(b=>b.name!==name);builds.unshift({name,created:new Date().toISOString(),...JSON.parse(JSON.stringify(serializeState()))});builds=builds.slice(0,30);persist();$('buildName').value='';renderSaves();toast('Сборка сохранена: '+name)}
function applySaved(x){if(!x||!Array.isArray(x.slots))throw Error('Неверный формат инвентаря');state=normState(x);closeEditor();persist();renderAll()}
function downloadJSON(obj,name){const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
$('capacity').addEventListener('change',e=>updateCapacity(e.target.value));$('columns').addEventListener('change',e=>{state.columns=Number(e.target.value);persist();renderGrid()});$('presets').addEventListener('click',e=>{const b=e.target.closest('[data-capacity]');if(b)updateCapacity(b.dataset.capacity)});
$('inventory').addEventListener('click',e=>{const b=e.target.closest('[data-slot]');if(!b)return;const i=Number(b.dataset.slot);selectedGearRef='';closeGearDropdown();state.selectedSlot=i;renderGrid();renderRaid();if(state.slots[i])openEditor(i)});
$('catalogGrid').addEventListener('click',e=>{const b=e.target.closest('[data-item]');if(!b)return;if(area==='raid'&&selectedGearRef){const ref=selectedGearRef;selectedGearRef='';putCatalogRef(b.dataset.item,ref)}else addItem(b.dataset.item)});
$('catalogGrid').addEventListener('dragstart',e=>{const b=e.target.closest('[data-item]');if(b){e.dataTransfer.setData('text/plain',JSON.stringify({kind:'catalog',id:b.dataset.item}));e.dataTransfer.effectAllowed='copy'}});
$('inventory').addEventListener('dragstart',e=>{const b=e.target.closest('[data-slot]');if(b&&state.slots[Number(b.dataset.slot)]){e.dataTransfer.setData('text/plain',JSON.stringify({kind:'slot',from:Number(b.dataset.slot)}));e.dataTransfer.effectAllowed='move'}});
$('inventory').addEventListener('dragover',e=>{if(e.target.closest('[data-slot]'))e.preventDefault()});
$('inventory').addEventListener('drop',e=>{const b=e.target.closest('[data-slot]');if(!b)return;e.preventDefault();const to=Number(b.dataset.slot);try{const data=JSON.parse(e.dataTransfer.getData('text/plain'));if(data.kind==='catalog')addItem(data.id,to);else if(data.kind==='ref'&&area==='raid'){moveRef(data.from,'bag:'+to)}else if(data.kind==='slot'){const from=Number(data.from);if(from>=0&&from<state.capacity&&from!==to){[state.slots[from],state.slots[to]]=[state.slots[to],state.slots[from]];state.selectedSlot=to;persist();renderGrid()}}}catch{toast('Не удалось перенести предмет')}});
$('search').addEventListener('input',()=>{shown=80;renderCatalog()});$('category').addEventListener('change',()=>{shown=80;renderCatalog()});$('source').addEventListener('change',fetchCatalog);$('refreshBtn').addEventListener('click',fetchCatalog);$('showMore').addEventListener('click',()=>{shown+=80;renderCatalog()});
$('editQty').addEventListener('keydown',e=>{if(e.key==='Enter')applyQty();if(e.key==='Escape')closeEditor()});$('qtyMinus').addEventListener('click',()=>{$('editQty').value=Math.max(1,validQty()-1)});$('qtyPlus').addEventListener('click',()=>{$('editQty').value=Math.min(Number($('editQty').max),validQty()+1)});$('applyEdit').addEventListener('click',applyQty);$('closeEdit').addEventListener('click',closeEditor);$('editOverlay').addEventListener('click',e=>{if(e.target.id==='editOverlay')closeEditor()});window.addEventListener('keydown',e=>{if(e.key==='Escape')closeEditor()});
$('removeItem').addEventListener('click',()=>{if(editingIndex===null)return;if(typeof editingIndex==='string'){putRef(editingIndex,null);compactOverflow()}else state.slots[editingIndex]=null;persist();renderGrid();renderRaid();closeEditor()});$('duplicateItem').addEventListener('click',()=>{const ix=firstEmpty();if(ix<0)return toast('Нет свободных ячеек');state.slots[ix]={...(typeof editingIndex==='string'?getRef(editingIndex):state.slots[editingIndex]),qty:validQty()};state.selectedSlot=ix;persist();renderGrid();closeEditor()});
$('clearBtn').addEventListener('click',()=>{if((state.slots.some(Boolean)||(area==='raid'&&(state.raidGear.overflow.length||state.raidGear.quick.some(Boolean)||state.raidGear.safe.some(Boolean)||state.raidGear.augmented.some(Boolean)||state.raidGear.weapons.some(Boolean)||state.raidGear.shield)))&&confirm(area==='stash'?'Очистить виртуальный склад?':'Очистить содержимое рейдовой сборки?')){state.slots=Array(state.capacity).fill(null);if(area==='raid')state.raidGear=createGear(state.raidGear.augmentId);state.selectedSlot=null;persist();renderAll()}});
$('saveBuild').addEventListener('click',saveBuild);
$('savedList').addEventListener('click',async e=>{
 const del=e.target.closest('[data-delete]'),load=e.target.closest('[data-load]'),share=e.target.closest('[data-share]'),revoke=e.target.closest('[data-revoke]');
 if(share){await publishBuild(Number(share.dataset.share))}
 else if(revoke){const b=builds[Number(revoke.dataset.revoke)];if(b&&confirm('Отозвать публичную ссылку на «'+b.name+'»? Друг больше не сможет открыть её.'))await revokeBuild(b)}
 else if(del){const i=Number(del.dataset.delete),b=builds[i];if(!b||!confirm('Удалить сборку «'+b.name+'»?'))return;
  if(b.shareId&&!(await revokeBuild(b,true)))return;
  const index=builds.indexOf(b);if(index>=0){builds.splice(index,1);persist();renderSaves()}
 }else if(load){const b=builds[Number(load.dataset.load)];if(!b)return;applySaved(b);toast('Открыта сборка: '+b.name)}
});
$('exportBtn').addEventListener('click',()=>downloadJSON({version:1,area,capacity:state.capacity,columns:state.columns,slots:state.slots},area==='stash'?'arc-stash.json':'arc-raid.json'));
$('exportAllBtn').addEventListener('click',()=>downloadJSON({version:2,area,state:serializeState(),builds},area==='stash'?'arc-stash-plans.json':'arc-raid-builds.json'));
$('importBtn').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{const x=JSON.parse(await f.text());if(x.area&&x.area!==area){toast('Этот JSON относится к разделу «'+(x.area==='stash'?'Склад':'Рейд')+'». Переключитесь в него и повторите импорт.');return}if(x.version===2&&x.state&&Array.isArray(x.builds)){if(!confirm('Заменить все сохранённые сборки из JSON?'))return;builds=normBuilds(x.builds);applySaved(x.state);toast('Все сборки импортированы')}else{applySaved(x);toast('Инвентарь импортирован')}}catch(err){toast('Ошибка импорта: '+err.message)}finally{e.target.value=''}});

// --- Sharing only explicit snapshots. Every private workspace stays behind owner rules. ---
function shareUrl(id){const url=new URL(location.origin+location.pathname);url.searchParams.set('share',id);return url.toString()}
async function copyText(s){try{await navigator.clipboard.writeText(s);toast('Ссылка скопирована')}catch{window.prompt('Скопируйте ссылку:',s)}}
function revealShareLink(id){$('shareLinkInput').value=shareUrl(id);$('shareLinkBox').hidden=false;$('shareLinkInput').focus();$('shareLinkInput').select();}
$('copyShareLink').addEventListener('click',()=>copyText($('shareLinkInput').value));
$('closeShareLink').addEventListener('click',()=>{$('shareLinkBox').hidden=true});
async function publishBuild(i){
 const b=builds[i];if(!b)return;
 if(mode!=='cloud'||!user||!ready){toast('Для публикации сборки войдите в личный аккаунт. Демо-сборки доступны только на этом ПК.');return}
 if(b.shareId){revealShareLink(b.shareId);return}
 const id=crypto.randomUUID().replace(/-/g,'');
 const record={ownerUid:user.uid,name:b.name,area,build:{capacity:b.capacity,columns:b.columns,slots:b.slots.map(normSlot),...(area==='raid'?{raidGear:normalizeGear(b.raidGear)}:{})},createdAt:new Date().toISOString()};
 try{
  if(new Blob([JSON.stringify(record)]).size>700000)throw new Error('Слишком большая сборка для публикации');
  await setDoc(doc(db,'sharedBuilds',id),record);
  b.shareId=id;persist();renderSaves();revealShareLink(id);toast('Сборка опубликована. Только эту копию можно открыть по ссылке.');
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
 if(state.slots.some(Boolean)&&!confirm('Заменить текущие ячейки опубликованной сборкой? Сохранённые сборки останутся без изменений.'))return;
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

initialize();
if(incomingShareId){
 // Wait for Firebase setup to finish; guests can view without signing in.
 Promise.resolve().then(async()=>{for(let retry=0;retry<10&&!db;retry++)await new Promise(r=>setTimeout(r,100));await openIncomingShare(incomingShareId)});
}
