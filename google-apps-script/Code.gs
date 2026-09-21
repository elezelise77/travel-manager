/*******************************************************
 * 여행 상황판 - 서버 (Code.gs)
 * 구글 시트 = DB / 이름+비밀번호 로그인
 *******************************************************/

var APP_VERSION = '2.1.0';
var TZ = 'Asia/Seoul';
var TOKEN_HOURS = 24 * 14;
var DEFAULT_MAX_PEOPLE = 40;
var ACCESS_KEEP = 400;        // 접속기록 보관 행 수

/* ===== 화면 자동 업데이트 =====
 * 화면(Index.html)을 시트에 붙박아 두지 않고, 만든 곳에서 받아와 그립니다.
 * 그래서 화면을 고치면 붙여넣기 없이 모두에게 반영됩니다.
 *
 *   · 받아온 화면은 6시간 캐시합니다 (매번 받아오지 않습니다)
 *   · 인터넷이 막히거나 주소가 죽으면 시트에 붙여넣어 둔 화면으로 그립니다 (절대 안 죽습니다)
 *   · 설정 시트의 '자동업데이트' 를 '끔' 으로 두면 시트 화면만 씁니다
 *
 * 배포하는 사람은 아래 주소만 본인 것으로 바꾸면 됩니다. (끝에 / 를 붙입니다)
 *   예) https://donghyun.github.io/travel-manager/
 * 비워두면 자동 업데이트를 쓰지 않습니다.                                   */
var UPDATE_URL = '';
var UI_CACHE_KEY = 'UIHTML';
var UI_CACHE_SEC = 21600;     // 6시간
var UI_CHUNK = 30000;         // 캐시 한 칸에 담을 글자 수 (한글은 한 자가 3바이트)

var SHEETS = {
  MEMBER  : { name:'참석자명단', headerRow:1, cols:['이름','거주지','출발지(대안)','참석여부','비밀번호','권한','은행','계좌번호'] },
  /* '참여자' — 비어 있으면 정산 대상자 전원, 이름을 쉼표로 적으면 그 사람들끼리만 나눈다 */
  EXPENSE : { name:'지출대장',   headerRow:2, cols:['NO.','결제자','카드','사유','금액','비고','지불현황','정산제외','등록자','참여자'] },
  PLAN    : { name:'일정',       headerRow:1, cols:['날짜','시간','내용','장소','메모'] },
  MEAL    : { name:'식사',       headerRow:1, cols:['날짜','구분','메뉴','장소','비고'] },
  MOVE    : { name:'이동수단',   headerRow:1, cols:['날짜','구분','팀','수단','차량/편명','운전자','탑승자','출발지','출발시각','도착지','비고'] },
  /* ※ 이미 쓰던 시트가 있으므로 새 항목은 반드시 '맨 뒤'에만 추가할 것 (중간 삽입 금지) */
  STAY    : { name:'숙소',       headerRow:1, cols:['숙소명','주소','체크인','체크아웃','예약처','예약번호','연락처','옵션','지도링크','메모'] },
  PHOTO   : { name:'사진',       headerRow:1, cols:['제목','링크','올린사람','등록일','파일ID','종류'] },
  IDEA    : { name:'건의사항',   headerRow:1, cols:['작성자','내용','등록일','반영'] },
  PAY     : { name:'송금확인',   headerRow:1, cols:['보낸사람','받는사람','금액','확인일','확인자','메모','구분'] },
  ACCESS  : { name:'접속기록',   headerRow:1, cols:['이름','시각','방식'] },
  CONFIG  : { name:'설정',       headerRow:1, cols:['항목','값'] }
};

var CONFIG_ROWS = [
  ['여행이름',   '우리 여행'],
  ['출발일',     ''],
  ['종료일',     ''],
  ['장소',       ''],
  ['기본비밀번호','0000'],
  ['관리자이름', ''],
  ['최대인원',   DEFAULT_MAX_PEOPLE],
  ['사진폴더ID', ''],
  ['정산모드',   '수시정산'],     // 수시정산 | 여행후일괄
  ['지출마감',   ''],             // 비어 있으면 진행 중, 날짜시각이 있으면 마감
  ['미정포함',   '포함'],         // 참석 '미정'·무응답을 정산 인원에 넣을지 : 포함 | 제외
  ['자동업데이트','켬'],          // 켬 | 끔 — 화면을 만든 곳에서 최신본을 받아올지
  ['업데이트주소', UPDATE_URL]    // 비워두면 시트에 붙여넣은 화면을 그대로 씁니다
];                                //  ※ '불참'은 언제나 정산 인원에서 빠진다

function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }

/* ===== 요청 1회짜리 캐시 : 같은 시트를 몇 번씩 다시 읽지 않게 함 ===== */
var _CACHE = {};
function invalidate_(){ _CACHE = {}; }

/* ===== 시트 점검은 평소엔 건너뛰되, 시트 항목이 바뀌면 딱 한 번 다시 돈다 =====
   (예전에는 '한 번 했으면 끝'이라, 새 항목을 추가해도 머리글이 안 생기는 문제가 있었다) */
var SETUP_FLAG = 'SETUP_SIG';
function schemaSig_(){
  var s = '';
  Object.keys(SHEETS).forEach(function(k){ s += SHEETS[k].name + ':' + SHEETS[k].cols.join(',') + ';'; });
  s += 'cfg:' + CONFIG_ROWS.map(function(r){return r[0]}).join(',') + ';';
  s += 'v:' + APP_VERSION + ';';
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s));
}
function ensureSetup_(){
  var p = PropertiesService.getScriptProperties();
  var sig = schemaSig_();
  if(p.getProperty(SETUP_FLAG) === sig) return;
  setup_();
  p.setProperty(SETUP_FLAG, sig);
}

/* ================= 화면 가져오기 ================= */
function updateBase_(){
  var u = String(cfg_('업데이트주소') || UPDATE_URL || '').trim();
  if(!u) return '';
  if(!/^https:\/\//i.test(u)) return '';          // https 아니면 쓰지 않는다
  return u.slice(-1) === '/' ? u : u + '/';
}
function autoUpdateOn_(){ return String(cfg_('자동업데이트') || '켬').trim() !== '끔'; }

/* 캐시 한 칸은 100KB 한도라, 긴 화면은 여러 칸에 나눠 담는다 */
function cacheGetBig_(key){
  try{
    var c = CacheService.getScriptCache();
    var n = Number(c.get(key + 'N')) || 0;
    if(!n) return '';
    var keys = [];
    for(var i=0; i<n; i++) keys.push(key + i);
    var got = c.getAll(keys), out = '';
    for(var j=0; j<n; j++){
      if(got[key + j] == null) return '';          // 한 칸이라도 비면 통째로 무효
      out += got[key + j];
    }
    return out;
  }catch(e){ return ''; }
}
function cachePutBig_(key, text){
  try{
    var c = CacheService.getScriptCache(), obj = {}, n = 0;
    for(var i=0; i<text.length; i += UI_CHUNK){ obj[key + n] = text.substr(i, UI_CHUNK); n++; }
    if(n > 24) return;                              // 너무 길면 캐시하지 않는다
    obj[key + 'N'] = String(n);
    c.putAll(obj, UI_CACHE_SEC);
  }catch(e){}
}
function uiCacheClear_(){
  try{
    var c = CacheService.getScriptCache();
    var n = Number(c.get(UI_CACHE_KEY + 'N')) || 0;
    var keys = [UI_CACHE_KEY + 'N'];
    for(var i=0; i<n; i++) keys.push(UI_CACHE_KEY + i);
    c.removeAll(keys);
  }catch(e){}
}

/** 만든 곳에서 최신 화면을 받아온다. 실패하면 빈 문자열(→ 시트 화면 사용). */
function fetchRemoteUi_(){
  var base = updateBase_();
  if(!base || !autoUpdateOn_()) return '';
  try{
    var res = UrlFetchApp.fetch(base + 'Index.html', {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    });
    if(res.getResponseCode() !== 200) return '';
    var html = res.getContentText('UTF-8');
    /* 받아온 것이 진짜 이 앱의 화면인지 최소한으로 확인한다 */
    if(html.length < 5000 || html.indexOf('tripToken') < 0) return '';
    return html;
  }catch(e){ return ''; }
}

/** 화면 HTML 과 그 출처를 돌려준다 */
function uiHtml_(){
  if(!autoUpdateOn_() || !updateBase_()) return { html:'', from:'시트' };
  var cached = cacheGetBig_(UI_CACHE_KEY);
  if(cached) return { html: cached, from:'최신(보관중)' };
  var fresh = fetchRemoteUi_();
  if(fresh){ cachePutBig_(UI_CACHE_KEY, fresh); return { html: fresh, from:'최신' }; }
  return { html:'', from:'시트(가져오기 실패)' };
}

/* ================= 진입점 ================= */
function doGet(){
  ensureSetup_();
  var url = '';
  try{ url = ScriptApp.getService().getUrl(); }catch(e){}
  var got = uiHtml_();
  var boot = JSON.stringify({
    title: cfg_('여행이름') || '여행 상황판',
    url  : url,
    uiFrom: got.from
  });

  var out;
  if(got.html){
    /* 받아온 화면에도 <?!= boot ?> 자리가 있으므로 직접 채워 넣는다 */
    out = HtmlService.createHtmlOutput(got.html.replace(/<\?!?=?\s*boot\s*\?>/, boot));
  }else{
    var t = HtmlService.createTemplateFromFile('Index');
    t.boot = boot;
    out = t.evaluate();
  }
  return out
    .setTitle('여행 상황판')
    .addMetaTag('viewport','width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ===== 데스크톱 앱(EXE)용 JSON API =====
 * 브라우저 화면은 doGet, 데스크톱 앱은 doPost 로 같은 데이터를 씁니다.      */
function doPost(e){
  var out = function(o){
    return ContentService.createTextOutput(JSON.stringify(o))
      .setMimeType(ContentService.MimeType.JSON);
  };
  try{
    ensureSetup_();
    var body = {};
    try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }catch(_){}
    switch(body.action){
      case 'ping'  : return out({ok:true, title:cfg_('여행이름')||'여행 상황판', app:'trip-board', version:APP_VERSION});
      case 'login' : return out({ok:true, result:login(body.name, body.pw)});
      case 'data'  : return out({ok:true, result:getData(body.token)});
      case 'backup': return out({ok:true, result:backupAll(body.token)});
      default      : return out({ok:false, error:'알 수 없는 요청입니다: ' + body.action});
    }
  }catch(err){
    return out({ok:false, error:String((err && err.message) || err)});
  }
}

/** 전체 시트를 그대로 내려받기 (데스크톱 앱의 백업 기능) */
function backupAll(token){
  needAdmin_(token);
  invalidate_();
  var dump = { savedAt: now_(), title: cfg_('여행이름'), sheets: {} };
  Object.keys(SHEETS).forEach(function(k){
    var def = SHEETS[k];
    if(def.name === SHEETS.MEMBER.name){
      dump.sheets[def.name] = readSheet_(def).map(function(r){
        var c = {}; Object.keys(r).forEach(function(key){
          if(key !== '비밀번호') c[key] = r[key];   // 비밀번호 해시는 백업에서 제외
        }); return c;
      });
    }else{
      dump.sheets[def.name] = readSheet_(def);
    }
  });
  return dump;
}

function onOpen(){
  SpreadsheetApp.getUi().createMenu('여행 상황판')
    .addItem('초기 설정 (시트 만들기)','초기설정')
    .addItem('관리자 지정','관리자지정')
    .addItem('시트 점검 · 복구','시트점검')
    .addItem('숙소 시트 다시 만들기','숙소시트다시만들기')
    .addItem('로그인 점검','로그인점검')
    .addItem('전원 비밀번호 초기화','비밀번호전체초기화')
    .addSeparator()
    .addItem('내 자료 전부 비우기 (배포용)','개인자료비우기')
    .addToUi();
}

function 초기설정(){
  setup_();
  PropertiesService.getScriptProperties().setProperty(SETUP_FLAG, schemaSig_());
  if(!cfg_('관리자이름')) 관리자지정();
  else try{ SpreadsheetApp.getUi().alert('설정을 마쳤습니다.\n관리자: ' + cfg_('관리자이름')); }catch(e){}
}

function 관리자지정(){
  var ui;
  try{ ui = SpreadsheetApp.getUi(); }catch(e){ return; }
  var res = ui.prompt('관리자 지정',
    '관리자로 쓸 이름을 참석자명단과 똑같이 적어주세요. 여러 명이면 쉼표로 구분합니다.\n지금: ' +
    (cfg_('관리자이름') || '(없음)'), ui.ButtonSet.OK_CANCEL);
  if(res.getSelectedButton() !== ui.Button.OK) return;
  var names = String(res.getResponseText()||'').trim();
  setCfg_('관리자이름', names);
  var miss = names.split(/[,\s]+/).filter(function(n){ return n && !memberByName_(n); });
  ui.alert('관리자: ' + (names||'(없음)') +
    (miss.length ? '\n\n※ 명단에 없는 이름: ' + miss.join(', ') + '\n참석자명단의 이름과 정확히 같아야 합니다.' : ''));
}

/** 남에게 넘기기 전에 내 자료를 전부 지운다 (머리글·설정 항목은 남는다) */
function 개인자료비우기(){
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('내 자료 전부 비우기',
    '참석자 명단·계좌·비밀번호·지출·일정·숙소·사진·건의사항·접속기록이\n' +
    '모두 지워집니다. 되돌릴 수 없습니다.\n\n' +
    '이 시트를 다른 사람에게 넘기기 전에 쓰는 기능입니다.\n계속할까요?', ui.ButtonSet.OK_CANCEL);
  if(r !== ui.Button.OK) return;

  Object.keys(SHEETS).forEach(function(k){
    if(SHEETS[k].name !== SHEETS.CONFIG.name) clearSheet_(SHEETS[k]);
  });
  setCfg_('여행이름','우리 여행');
  ['출발일','종료일','장소','관리자이름','사진폴더ID','지출마감'].forEach(function(k){ setCfg_(k,''); });
  setCfg_('기본비밀번호','0000');
  setCfg_('정산모드','수시정산');
  setCfg_('미정포함','포함');
  invalidate_();
  try{ PropertiesService.getScriptProperties().deleteAllProperties(); }catch(e){}
  ui.alert('전부 비웠습니다.\n\n이제 이 시트를 배포용으로 쓰실 수 있습니다.\n' +
           '받는 분이 처음 로그인하면 그분이 관리자가 됩니다.');
}

/** 숙소 시트만 깨끗하게 새로 만든다 (다른 시트는 건드리지 않음) */
function 숙소시트다시만들기(){
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('숙소 시트 다시 만들기',
    '숙소 시트의 내용이 모두 지워지고 머리글이 올바른 순서로 새로 만들어집니다.\n' +
    '지출·일정·참석자 등 다른 시트는 그대로입니다.\n\n계속할까요?', ui.ButtonSet.OK_CANCEL);
  if(r !== ui.Button.OK) return;

  var ss = ss_(), d = SHEETS.STAY;
  var old = ss.getSheetByName(d.name);
  if(old) ss.deleteSheet(old);
  var sh = ss.insertSheet(d.name);
  sh.getRange(1,1,1,d.cols.length).setValues([d.cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  invalidate_();
  ui.alert('숙소 시트를 새로 만들었습니다.\n앱에서 [＋ 숙소 추가] 로 다시 등록해 주세요.');
}

/** 머리글이 중복되거나 어긋났을 때 정리 (자료는 지우지 않음) */
function 시트점검(){
  var ui = SpreadsheetApp.getUi(), notes = [], fixed = 0;
  Object.keys(SHEETS).forEach(function(k){
    var d = SHEETS[k], sh = ss_().getSheetByName(d.name);
    if(!sh || sh.getLastColumn() < 1) return;
    var w = sh.getLastColumn();
    var head = sh.getRange(d.headerRow,1,1,w).getValues()[0]
                 .map(function(h){ return String(h||'').trim(); });
    var seen = {}, changed = false;
    for(var i=0; i<head.length; i++){
      if(!head[i]) continue;
      if(seen[head[i]]){
        var hasData = false;
        if(sh.getLastRow() > d.headerRow){
          hasData = sh.getRange(d.headerRow+1, i+1, sh.getLastRow()-d.headerRow, 1)
                      .getValues().some(function(r){ return String(r[0]||'').trim(); });
        }
        if(hasData) notes.push('· ' + d.name + ' 시트 ' + (i+1) + '번째 열 「' + head[i] + '」 이(가) 중복인데 내용이 있습니다. 직접 확인해 주세요.');
        else { head[i] = ''; changed = true; fixed++; }
      }else seen[head[i]] = true;
    }
    if(changed) sh.getRange(d.headerRow,1,1,head.length).setValues([head]);
  });
  setup_();
  ui.alert('시트 점검 완료\n\n중복 머리글 ' + fixed + '개를 정리했습니다.' +
    (notes.length ? '\n\n확인이 필요한 곳:\n' + notes.join('\n') : '\n문제 없습니다.'));
}

function 로그인점검(){
  var names = readSheet_(SHEETS.MEMBER).filter(f_('이름'));
  var setPw = names.filter(function(r){return String(r['비밀번호']||'').trim()}).length;
  var admins = names.filter(function(r){return roleOf_(r)==='admin'}).map(function(r){return r['이름']});
  SpreadsheetApp.getUi().alert(
    '등록 인원: ' + names.length + '명\n' +
    '비밀번호를 직접 정한 사람: ' + setPw + '명\n' +
    '기본 비밀번호: [' + (String(cfg_('기본비밀번호')||'').trim() || '(비어있음 → 0000)') + ']\n' +
    '관리자로 인식되는 사람: ' + (admins.length ? admins.join(', ') : '(없음)'));
}

function 비밀번호전체초기화(){
  var sh = ss_().getSheetByName(SHEETS.MEMBER.name);
  readSheet_(SHEETS.MEMBER).forEach(function(r){
    if(String(r['이름']||'').trim()) sh.getRange(r._row,5).setValue(''); });
  SpreadsheetApp.getUi().alert('모두 기본비밀번호(' + (cfg_('기본비밀번호')||'0000') + ')로 돌아갔습니다.');
}

/* ================= 시트 준비 ================= */
function setup_(){
  var ss = ss_();
  Object.keys(SHEETS).forEach(function(k){
    var d = SHEETS[k], sh = ss.getSheetByName(d.name);
    if(!sh){
      sh = ss.insertSheet(d.name);
      sh.getRange(d.headerRow,1,1,d.cols.length).setValues([d.cols]).setFontWeight('bold');
      sh.setFrozenRows(d.headerRow);
    }else{
      /* 이미 있는 시트는 '자리'가 아니라 '이름'으로 맞춘다.
         없는 머리글만 빈 칸이나 맨 뒤에 채워 넣어야 기존 자료가 밀리지 않는다. */
      var w = Math.max(sh.getLastColumn(), 1);
      var head = sh.getRange(d.headerRow,1,1,w).getValues()[0]
                   .map(function(h){ return String(h||'').trim(); });
      var missing = d.cols.filter(function(c){ return head.indexOf(c) < 0; });
      if(missing.length){
        for(var i=0; i<head.length && missing.length; i++){
          if(!head[i]) head[i] = missing.shift();
        }
        while(missing.length) head.push(missing.shift());
        sh.getRange(d.headerRow,1,1,head.length).setValues([head]).setFontWeight('bold');
      }
    }
  });
  var c = ss.getSheetByName(SHEETS.CONFIG.name);
  if(c.getLastRow() < 2) c.getRange(2,1,CONFIG_ROWS.length,2).setValues(CONFIG_ROWS);
  else{
    var have = readSheet_(SHEETS.CONFIG).map(function(r){return String(r['항목']||'').trim()});
    CONFIG_ROWS.forEach(function(p){ if(have.indexOf(p[0])<0) c.appendRow(p); });
  }
  c.getRange('B:B').setNumberFormat('@');
  var m = ss.getSheetByName(SHEETS.MEMBER.name);
  m.getRange('E:E').setNumberFormat('@');   // 비밀번호(해시)
  m.getRange('H:H').setNumberFormat('@');   // 계좌번호
  var pwRow = readSheet_(SHEETS.CONFIG).filter(function(r){
    return String(r['항목']||'').trim()==='기본비밀번호'; })[0];
  if(pwRow){
    var v = String(pwRow['값']==null?'':pwRow['값']).trim();
    if(v==='' || v==='0') c.getRange(pwRow._row,2).setValue('0000');
  }
}

/* ================= 읽기 ================= */
function readSheet_(def){
  if(_CACHE[def.name]) return _CACHE[def.name];
  var out = [];
  var sh = ss_().getSheetByName(def.name);
  if(sh){
    var vals = sh.getDataRange().getValues();        // 시트당 읽기 1회
    if(vals.length > def.headerRow){
      var head = vals[def.headerRow-1] || [];
      for(var i=def.headerRow; i<vals.length; i++){
        var o = {_row:i+1}, row = vals[i];
        for(var c=0;c<head.length;c++){
          var h = String(head[c]||'').trim();
          if(h) o[h] = norm_(row[c]);
        }
        out.push(o);
      }
    }
  }
  _CACHE[def.name] = out;
  return out;
}
function norm_(v){
  if(Object.prototype.toString.call(v) === '[object Date]'){
    if(v.getFullYear() < 1900) return Utilities.formatDate(v,TZ,'HH:mm');
    if(v.getHours()===0 && v.getMinutes()===0) return Utilities.formatDate(v,TZ,'yyyy-MM-dd');
    return Utilities.formatDate(v,TZ,'yyyy-MM-dd HH:mm');
  }
  return v;
}
function f_(col){ return function(r){ return String(r[col]||'').trim(); }; }
function cfg_(key){
  var hit = readSheet_(SHEETS.CONFIG).filter(function(r){
    return String(r['항목']||'').trim()===key; })[0];
  return hit ? String(hit['값']==null?'':hit['값']).trim() : '';
}
function setCfg_(key,val){
  var sh = ss_().getSheetByName(SHEETS.CONFIG.name);
  var hit = readSheet_(SHEETS.CONFIG).filter(function(r){
    return String(r['항목']||'').trim()===key; })[0];
  if(hit) sh.getRange(hit._row,2).setValue(val);
  else    sh.appendRow([key,val]);
  invalidate_();
}
function now_(){ return Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm'); }

/* ================= 로그인 ================= */
function hash_(pw){
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pw)+'|'+ss_().getId()));
}
function memberByName_(name){
  name = String(name||'').trim();
  if(!name) return null;
  return readSheet_(SHEETS.MEMBER).filter(function(r){
    return String(r['이름']||'').trim() === name; })[0];
}
function roleOf_(m){
  if(String(m['권한']||'').trim().toLowerCase()==='admin') return 'admin';
  var admins = cfg_('관리자이름').split(/[,\s]+/).filter(function(x){return x});
  return admins.indexOf(String(m['이름']||'').trim()) >= 0 ? 'admin' : 'member';
}
function sameDefaultPw_(input){
  var def = String(cfg_('기본비밀번호')||'').trim() || '0000';
  input = String(input==null?'':input).trim();
  if(input === def) return true;
  if(/^\d+$/.test(input) && /^\d+$/.test(def) && Number(input)===Number(def)) return true;
  return false;
}

function login(name, pw){
  var m = memberByName_(name);
  if(!m) throw new Error('명단에 없는 이름입니다. 띄어쓰기까지 똑같이 적어주세요.');
  var stored = String(m['비밀번호']||'').trim();
  var ok = stored ? (stored===hash_(pw)) : sameDefaultPw_(pw);
  if(!ok) throw new Error('비밀번호가 맞지 않습니다.');

  var me = String(m['이름']||'').trim();

  // 관리자가 아직 한 명도 없으면, 처음 들어온 사람이 방장(관리자)이 된다
  var firstAdmin = false;
  if(!readSheet_(SHEETS.MEMBER).filter(f_('이름')).some(function(r){ return roleOf_(r)==='admin'; })){
    setCfg_('관리자이름', me);
    firstAdmin = true;
  }

  var token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('T_'+token, JSON.stringify({
    name: me, exp: Date.now()+TOKEN_HOURS*3600*1000 }));
  logAccess_(me, '로그인');
  return { token:token, name:me, role: firstAdmin ? 'admin' : roleOf_(memberByName_(me)),
           mustSet: !stored, firstAdmin: firstAdmin, data:getData(token) };
}

function who_(token){
  var raw = PropertiesService.getScriptProperties().getProperty('T_'+String(token||''));
  if(!raw) throw new Error('로그인이 필요합니다.');
  var t = JSON.parse(raw);
  if(!t.exp || t.exp < Date.now()){
    PropertiesService.getScriptProperties().deleteProperty('T_'+token);
    throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
  }
  var m = memberByName_(t.name);
  if(!m) throw new Error('명단에서 사라진 계정입니다.');
  return { name:t.name, role:roleOf_(m), row:m._row };
}
function session(token){
  var u = who_(token);
  logAccess_(u.name,'재방문');
  var m = memberByName_(u.name);
  return { name:u.name, role:u.role, mustSet: !String(m['비밀번호']||'').trim(), data:getData(token) };
}
function logout(token){
  PropertiesService.getScriptProperties().deleteProperty('T_'+String(token||''));
  return true;
}
function needAdmin_(token){
  var u = who_(token);
  if(u.role!=='admin') throw new Error('관리자만 할 수 있습니다.');
  return u;
}

/** 접속 기록 (같은 사람 30분 내 재방문은 남기지 않음) */
function logAccess_(name, kind){
  try{
    var sh = ss_().getSheetByName(SHEETS.ACCESS.name);
    if(!sh) return;
    var last = sh.getLastRow();
    if(kind==='재방문' && last>1){
      var from = Math.max(2, last-12);
      var recent = sh.getRange(from,1,last-from+1,2).getValues();
      for(var i=recent.length-1;i>=0;i--){
        if(String(recent[i][0]||'').trim()===name){
          var t = recent[i][1];
          var d = (Object.prototype.toString.call(t)==='[object Date]') ? t : new Date(String(t).replace(/-/g,'/'));
          if(d && (Date.now()-d.getTime()) < 30*60*1000) return;
          break;
        }
      }
    }
    sh.appendRow([name, now_(), kind]);
    if(sh.getLastRow() > ACCESS_KEEP + 1) sh.deleteRows(2, sh.getLastRow()-ACCESS_KEEP-1);
    invalidate_();
  }catch(e){}
}

function changeMyPassword(token, oldPw, newPw){
  var u = who_(token);
  var m = memberByName_(u.name);
  var stored = String(m['비밀번호']||'').trim();
  var ok = stored ? (stored===hash_(oldPw)) : sameDefaultPw_(oldPw);
  if(!ok) throw new Error('지금 비밀번호가 맞지 않습니다.');
  var np = String(newPw||'').trim();
  if(np.length<4 || np.length>20) throw new Error('새 비밀번호는 4~20자로 정해주세요.');
  ss_().getSheetByName(SHEETS.MEMBER.name).getRange(m._row,5).setNumberFormat('@').setValue(hash_(np));
  return true;
}
/** 관리자: 이 여행방의 기본 비밀번호를 바꿈 (아직 비번을 안 정한 사람에게 적용) */
function setDefaultPassword(token, pw){
  needAdmin_(token);
  var p = String(pw||'').trim();
  if(p.length < 4 || p.length > 20) throw new Error('기본 비밀번호는 4~20자로 정해주세요.');
  if(/\s/.test(p)) throw new Error('띄어쓰기는 넣을 수 없습니다.');
  var sh = ss_().getSheetByName(SHEETS.CONFIG.name);
  var hit = readSheet_(SHEETS.CONFIG).filter(function(r){
    return String(r['항목']||'').trim() === '기본비밀번호'; })[0];
  if(hit) sh.getRange(hit._row,2).setNumberFormat('@').setValue(p);
  else { sh.appendRow(['기본비밀번호','']); sh.getRange(sh.getLastRow(),2).setNumberFormat('@').setValue(p); }
  invalidate_();
  return getData(token);
}

function resetPassword(token, row){
  needAdmin_(token);
  ss_().getSheetByName(SHEETS.MEMBER.name).getRange(Number(row),5).setValue('');
  return getData(token);
}
/** 본인 계좌 등록 */
function saveMyAccount(token, bank, acct){
  var u = who_(token);
  var m = memberByName_(u.name);
  var sh = ss_().getSheetByName(SHEETS.MEMBER.name);
  sh.getRange(m._row,7).setValue(String(bank||'').trim());
  sh.getRange(m._row,8).setNumberFormat('@').setValue(String(acct||'').replace(/\s/g,''));
  return getData(token);
}

/* ================= 데이터 ================= */
function getData(token){
  var u = who_(token);
  invalidate_();                 // 여기서 한 번만 새로 읽고, 아래는 전부 캐시 사용
  var meta = {};
  readSheet_(SHEETS.CONFIG).forEach(function(r){
    var k = String(r['항목']||'').trim();
    if(!k) return;
    if(k === '기본비밀번호' && u.role !== 'admin') return;   // 기본 비번은 관리자에게만
    meta[k] = r['값'];
  });
  try{ meta['웹앱주소'] = ScriptApp.getService().getUrl(); }catch(e){}
  meta['서버버전'] = APP_VERSION;
  return {
    meta    : meta,
    members : readSheet_(SHEETS.MEMBER).filter(f_('이름')).map(function(r){
                return {_row:r._row, 이름:r['이름'], 거주지:r['거주지'],
                        '출발지(대안)':r['출발지(대안)'], 참석여부:r['참석여부'],
                        권한:roleOf_(r), 은행:r['은행'], 계좌번호:r['계좌번호'],
                        비번설정:!!String(r['비밀번호']||'').trim()}; }),
    expenses: readSheet_(SHEETS.EXPENSE).filter(function(r){
                return String(r['결제자']||'').trim() || Number(r['금액'])>0; }),
    plans   : readSheet_(SHEETS.PLAN).filter(f_('내용')),
    meals   : readSheet_(SHEETS.MEAL).filter(f_('메뉴')),
    moves   : readSheet_(SHEETS.MOVE).filter(function(r){
                return String(r['팀']||'').trim() || String(r['수단']||'').trim(); }),
    stays   : readSheet_(SHEETS.STAY).filter(f_('숙소명')),
    photos  : readSheet_(SHEETS.PHOTO).filter(f_('링크')),
    ideas   : readSheet_(SHEETS.IDEA).filter(f_('내용')),
    pays    : readSheet_(SHEETS.PAY).filter(f_('보낸사람'))
  };
}
function refresh(token){ return getData(token); }

/** 관리자: 접속 기록 (최근 것부터) */
function accessLog(token){
  needAdmin_(token);
  return readSheet_(SHEETS.ACCESS).filter(f_('이름')).slice(-150).reverse().map(function(r){
    return {name:r['이름'], at:r['시각'], kind:r['방식']}; });
}

/* ================= 쓰기 공통 ================= */
function writeRow_(def, rowIndex, obj){
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{
    var sh = ss_().getSheetByName(def.name);
    var width = Math.max(sh.getLastColumn(), def.cols.length);
    var head = sh.getRange(def.headerRow,1,1,width).getValues()[0]
                 .map(function(h){return String(h||'').trim()});
    var target = rowIndex ? Number(rowIndex) : sh.getLastRow()+1;
    if(target <= def.headerRow) target = def.headerRow+1;
    var cur = (target<=sh.getLastRow())
      ? sh.getRange(target,1,1,width).getValues()[0]
      : new Array(width).fill('');
    head.forEach(function(h,c){ if(h && obj.hasOwnProperty(h)) cur[c]=obj[h]; });
    sh.getRange(target,1,1,width).setValues([cur]);
    invalidate_();
    return target;
  } finally { lock.releaseLock(); }
}
function deleteRow_(def, rowIndex){
  var sh = ss_().getSheetByName(def.name);
  if(Number(rowIndex) > def.headerRow) sh.deleteRow(Number(rowIndex));
  invalidate_();
}
function rowOf_(def,row){
  return readSheet_(def).filter(function(r){return String(r._row)===String(row)})[0];
}

/* ================= 지출 ================= */
function saveExpense(token, o){
  var u = who_(token);
  if(expensesClosed_())
    throw new Error('지출이 마감되었습니다. 고치려면 관리자가 설정에서 마감을 먼저 풀어야 합니다.');
  if(o._row){
    var cur = rowOf_(SHEETS.EXPENSE, o._row);
    if(!cur) throw new Error('없는 항목입니다.');
    var owner = String(cur['등록자']||'').trim();
    if(u.role!=='admin' && owner !== u.name)
      throw new Error(owner ? '등록한 사람만 고칠 수 있습니다.' : '예전 항목이라 관리자만 고칠 수 있습니다.');
    o['등록자'] = owner || u.name;
  }else{
    o['등록자'] = u.name;
    if(u.role!=='admin' && String(o['결제자']||'').trim() !== u.name)
      throw new Error('본인이 결제한 지출만 등록할 수 있습니다.');
    var max = 0;
    readSheet_(SHEETS.EXPENSE).forEach(function(r){ max=Math.max(max, Number(r['NO.'])||0); });
    o['NO.'] = max+1;
    var blank = findBlankRow_(SHEETS.EXPENSE,'결제자');
    if(blank){
      var n = Number(ss_().getSheetByName(SHEETS.EXPENSE.name).getRange(blank,1).getValue())||0;
      o._row = blank; if(n) o['NO.']=n;
    }
  }
  writeRow_(SHEETS.EXPENSE, o._row, o);
  return getData(token);
}
function findBlankRow_(def, keyCol){
  var rows = readSheet_(def);
  for(var i=0;i<rows.length;i++) if(!String(rows[i][keyCol]||'').trim()) return rows[i]._row;
  return 0;
}
function deleteExpense(token, row){
  var u = who_(token);
  if(expensesClosed_())
    throw new Error('지출이 마감되었습니다. 지우려면 관리자가 설정에서 마감을 먼저 풀어야 합니다.');
  var cur = rowOf_(SHEETS.EXPENSE,row);
  var owner = cur ? String(cur['등록자']||'').trim() : '';
  if(u.role!=='admin' && owner!==u.name) throw new Error('등록한 사람만 지울 수 있습니다.');
  deleteRow_(SHEETS.EXPENSE,row);
  return getData(token);
}

/* ================= 정산 · 납부 기록 =================
 * 예전에는 "이 송금 끝났음" 체크 하나만 저장했는데,
 * 그러면 지출이 나중에 바뀔 때 숫자가 꼬였다.
 * 이제는 실제로 오간 돈을 한 건씩 쌓고, 잔액은 항상 다시 계산한다.
 *   내 잔액 = (내가 결제한 돈) - (내 부담금) + (내가 보낸 돈) - (내가 받은 돈)
 * 선납·부분납부·환급이 모두 같은 방식으로 처리된다.
 */
var PAY_KINDS = ['정산','선납','환급','기타'];

function addPayment(token, from, to, amount, memo, kind){
  var u = who_(token);
  from = String(from||'').trim();
  to   = String(to||'').trim();
  if(u.role !== 'admin') from = u.name;               // 일반 멤버는 본인이 보낸 것만
  if(!from || !to) throw new Error('보내는 사람과 받는 사람을 정해주세요.');
  if(from === to)  throw new Error('본인에게는 보낼 수 없습니다.');
  if(!memberByName_(from) || !memberByName_(to)) throw new Error('명단에 없는 이름입니다.');

  var amt = Math.round(Number(amount)||0);
  if(amt <= 0) throw new Error('금액을 올바르게 넣어주세요.');
  if(PAY_KINDS.indexOf(kind) < 0) kind = '정산';

  ss_().getSheetByName(SHEETS.PAY.name)
       .appendRow([from, to, amt, now_(), u.name, String(memo||'').slice(0,60), kind]);
  invalidate_();
  return getData(token);
}

function deletePayment(token, row){
  var u = who_(token);
  var cur = rowOf_(SHEETS.PAY, row);
  if(!cur) throw new Error('없는 기록입니다.');
  var mine = String(cur['확인자']||'').trim() === u.name ||
             String(cur['보낸사람']||'').trim() === u.name;
  if(u.role !== 'admin' && !mine) throw new Error('본인이 기록한 것만 지울 수 있습니다.');
  deleteRow_(SHEETS.PAY, row);
  return getData(token);
}

/** 지출이 마감되었는지 (마감되면 아무도 지출을 못 고친다) */
function expensesClosed_(){ return !!String(cfg_('지출마감')||'').trim(); }

/** 관리자: 지출을 조기 마감하거나 다시 연다 */
function closeExpenses(token, close){
  needAdmin_(token);
  setCfg_('지출마감', close ? now_() : '');
  return getData(token);
}

/** 관리자: 여행 중 수시 송금을 받을지, 끝나고 한 번에 받을지 */
function setSettleMode(token, mode){
  needAdmin_(token);
  if(['수시정산','여행후일괄'].indexOf(mode) < 0) throw new Error('잘못된 값입니다.');
  setCfg_('정산모드', mode);
  return getData(token);
}

/* ================= 복원 · 초기화 =================
 * 세 가지를 구분한다.
 *   restoreAll       백업 JSON 으로 통째로 되돌리기 (사고 복구)
 *   resetForNextTrip 다음 여행 준비 — 명단·계좌는 남기고 지출·일정 등만 비우기
 *   개인자료비우기    판매·배포용으로 내 자료를 전부 지우기 (시트 메뉴)
 */

/** 한 시트의 자료만 지우고 머리글은 남긴다 */
function clearSheet_(def){
  var sh = ss_().getSheetByName(def.name);
  if(!sh) return;
  var last = sh.getLastRow();
  if(last > def.headerRow)
    sh.getRange(def.headerRow+1, 1, last-def.headerRow, Math.max(sh.getLastColumn(),1)).clearContent();
}

/** 백업 저장으로 받은 JSON 을 그대로 되돌린다 (비밀번호는 백업에 없으므로 그대로 유지된다) */
function restoreAll(token, dump){
  needAdmin_(token);
  if(!dump || !dump.sheets) throw new Error('백업 파일이 아닙니다.');

  /* 지금 비밀번호를 기억해 뒀다가, 참석자명단을 되돌린 뒤 이름으로 다시 붙여준다 */
  var pw = {};
  readSheet_(SHEETS.MEMBER).forEach(function(r){
    var n = String(r['이름']||'').trim();
    if(n) pw[n] = r['비밀번호'];
  });

  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try{
    var done = [];
    Object.keys(SHEETS).forEach(function(k){
      var def = SHEETS[k], rows = dump.sheets[def.name];
      if(!rows || !rows.length){ return; }               // 백업에 없는 시트는 건드리지 않는다
      var sh = ss_().getSheetByName(def.name);
      if(!sh) return;
      clearSheet_(def);
      var width = Math.max(sh.getLastColumn(), def.cols.length);
      var head = sh.getRange(def.headerRow,1,1,width).getValues()[0]
                   .map(function(h){ return String(h||'').trim(); });
      var out = rows.map(function(r){
        return head.map(function(h){
          if(!h) return '';
          if(def.name===SHEETS.MEMBER.name && h==='비밀번호')
            return pw[String(r['이름']||'').trim()] || '';
          return r.hasOwnProperty(h) ? r[h] : '';
        });
      });
      if(out.length) sh.getRange(def.headerRow+1, 1, out.length, width).setValues(out);
      done.push(def.name + ' ' + out.length + '줄');
    });
    invalidate_();
    return { ok:true, restored:done, savedAt: dump.savedAt || '' };
  } finally { lock.releaseLock(); }
}

/** 다음 여행 준비 — 명단·계좌·비밀번호는 남기고 여행마다 달라지는 것만 비운다 */
function resetForNextTrip(token, opt){
  needAdmin_(token);
  opt = opt || {};
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try{
    [SHEETS.EXPENSE, SHEETS.PAY, SHEETS.PLAN, SHEETS.MEAL,
     SHEETS.MOVE, SHEETS.STAY, SHEETS.IDEA].forEach(clearSheet_);
    if(opt.photos)  clearSheet_(SHEETS.PHOTO);      // 시트에서만 지우고 드라이브 원본은 남긴다
    if(opt.access)  clearSheet_(SHEETS.ACCESS);

    /* 참석 여부는 다시 받아야 한다 */
    var sh = ss_().getSheetByName(SHEETS.MEMBER.name);
    if(sh && sh.getLastRow() > SHEETS.MEMBER.headerRow){
      var head = sh.getRange(SHEETS.MEMBER.headerRow,1,1,Math.max(sh.getLastColumn(),1)).getValues()[0]
                   .map(function(h){return String(h||'').trim()});
      var col = head.indexOf('참석여부') + 1;
      if(col) sh.getRange(SHEETS.MEMBER.headerRow+1, col,
                          sh.getLastRow()-SHEETS.MEMBER.headerRow, 1).clearContent();
    }

    setCfg_('지출마감','');
    setCfg_('정산모드','수시정산');
    if(opt.title) setCfg_('여행이름', String(opt.title).trim());
    setCfg_('출발일',''); setCfg_('종료일',''); setCfg_('장소','');
    if(opt.photos) setCfg_('사진폴더ID','');       // 다음 여행 사진은 새 폴더로
    invalidate_();
    return getData(token);
  } finally { lock.releaseLock(); }
}

/* ================= 범용 창구 =================
 * google.script.run 은 여기 Code.gs 에 적힌 함수만 부를 수 있습니다.
 * 그래서 화면에서 새 기능을 만들 때마다 Code.gs 를 고쳐야 했는데,
 * 아래 창구 하나를 열어두면 앞으로는 화면만 고쳐도 되는 일이 많아집니다.
 *
 *   api(토큰, 'list',   ['준비물'])                     시트 읽기
 *   api(토큰, 'put',    ['준비물', 0, {항목:'텐트'}])     행 추가·수정 (0 이면 새 행)
 *   api(토큰, 'del',    ['준비물', 5])                   행 지우기
 *   api(토큰, 'ensure', ['준비물', ['항목','담당','비고']])  시트 만들기·열 추가
 *   api(토큰, 'getcfg', ['여행이름']) / api(토큰,'setcfg',['여행이름','제주도'])
 *
 * 참석자명단·지출대장 같은 기본 시트는 이 창구로 구조를 바꿀 수 없습니다.
 * 비밀번호·권한 열은 읽지도 쓰지도 못합니다.                              */
var API_HIDDEN = ['비밀번호','권한'];

function baseSheetNames_(){
  return Object.keys(SHEETS).map(function(k){ return SHEETS[k].name; });
}
function userDef_(name){
  name = String(name||'').trim();
  if(!name) throw new Error('시트 이름이 없습니다.');
  var sh = ss_().getSheetByName(name);
  if(!sh) throw new Error('없는 시트입니다: ' + name);
  var w = Math.max(sh.getLastColumn(), 1);
  var cols = sh.getRange(1,1,1,w).getValues()[0]
               .map(function(h){ return String(h||'').trim(); }).filter(Boolean);
  return { name:name, headerRow:1, cols:cols };
}
function strip_(o){
  var c = {};
  Object.keys(o).forEach(function(k){ if(API_HIDDEN.indexOf(k) < 0) c[k] = o[k]; });
  return c;
}

function api(token, action, args){
  var u = who_(token);
  args = args || [];
  var name = String(args[0]||'').trim();
  var isBase = baseSheetNames_().indexOf(name) >= 0;

  switch(String(action||'')){
    case 'list':
      if(name === SHEETS.CONFIG.name || name === SHEETS.ACCESS.name) needAdmin_(token);
      return readSheet_(isBase ? sheetDef_(name) : userDef_(name)).map(strip_);

    case 'put': {
      if(isBase) throw new Error('기본 시트는 화면에서 쓰는 전용 기능으로 저장해 주세요.');
      var def = userDef_(name), obj = strip_(args[2] || {});
      obj['등록자'] = (def.cols.indexOf('등록자') >= 0) ? u.name : obj['등록자'];
      var row = Number(args[1]) || 0;
      if(row){
        var cur = rowOf_(def, row);
        if(!cur) throw new Error('없는 항목입니다.');
        var owner = String(cur['등록자']||'').trim();
        if(u.role !== 'admin' && owner && owner !== u.name)
          throw new Error('등록한 사람만 고칠 수 있습니다.');
      }
      writeRow_(def, row, obj);
      invalidate_();
      return true;
    }

    case 'del': {
      if(isBase) throw new Error('기본 시트는 화면에서 쓰는 전용 기능으로 지워 주세요.');
      var d2 = userDef_(name), r2 = Number(args[1]) || 0;
      var cur2 = rowOf_(d2, r2);
      if(!cur2) throw new Error('없는 항목입니다.');
      var own2 = String(cur2['등록자']||'').trim();
      if(u.role !== 'admin' && own2 && own2 !== u.name)
        throw new Error('등록한 사람만 지울 수 있습니다.');
      deleteRow_(d2, r2);
      invalidate_();
      return true;
    }

    case 'ensure': {
      needAdmin_(token);
      if(isBase) throw new Error('기본 시트는 바꿀 수 없습니다.');
      var cols = (args[1] || []).map(function(c){ return String(c||'').trim(); }).filter(Boolean);
      if(!cols.length) throw new Error('열 이름을 하나 이상 적어주세요.');
      var ss = ss_(), sh2 = ss.getSheetByName(name);
      if(!sh2){
        sh2 = ss.insertSheet(name);
        sh2.getRange(1,1,1,cols.length).setValues([cols]).setFontWeight('bold');
        sh2.setFrozenRows(1);
      }else{
        var w2 = Math.max(sh2.getLastColumn(), 1);
        var head = sh2.getRange(1,1,1,w2).getValues()[0]
                      .map(function(h){ return String(h||'').trim(); });
        cols.forEach(function(c){
          if(head.indexOf(c) >= 0) return;
          var blank = head.indexOf('');
          if(blank >= 0){ head[blank] = c; }
          else { head.push(c); }
        });
        sh2.getRange(1,1,1,head.length).setValues([head]).setFontWeight('bold');
      }
      invalidate_();
      return true;
    }

    case 'getcfg': return cfg_(String(args[0]||''));
    case 'setcfg':
      needAdmin_(token);
      setCfg_(String(args[0]||''), args[1]);
      invalidate_();
      return true;

    default: throw new Error('알 수 없는 요청입니다: ' + action);
  }
}

/** 기본 시트 이름으로 정의 찾기 */
function sheetDef_(name){
  var found = null;
  Object.keys(SHEETS).forEach(function(k){ if(SHEETS[k].name === name) found = SHEETS[k]; });
  if(!found) throw new Error('없는 시트입니다: ' + name);
  return found;
}

/* 화면 자동 업데이트 켜기·끄기 */
function setAutoUpdate(token, v){
  needAdmin_(token);
  if(['켬','끔'].indexOf(v) < 0) throw new Error('잘못된 값입니다.');
  setCfg_('자동업데이트', v);
  uiCacheClear_();
  return getData(token);
}

/** 보관해 둔 화면을 버리고 지금 바로 다시 받아온다 */
function refreshUi(token){
  needAdmin_(token);
  uiCacheClear_();
  invalidate_();
  if(!updateBase_()) return { ok:false, msg:'업데이트 주소가 없어 시트 화면을 씁니다.' };
  if(!autoUpdateOn_()) return { ok:false, msg:'자동 업데이트가 꺼져 있습니다.' };
  var html = fetchRemoteUi_();
  if(!html) return { ok:false, msg:'최신 화면을 가져오지 못했습니다. 주소와 인터넷을 확인해 주세요.' };
  cachePutBig_(UI_CACHE_KEY, html);
  return { ok:true, msg:'최신 화면을 받았습니다. 새로고침하면 적용됩니다.' };
}

/* 참석 '미정'·무응답을 정산 인원에 넣을지 (불참은 언제나 제외) */
function setUndecided(token, v){
  needAdmin_(token);
  if(['포함','제외'].indexOf(v) < 0) throw new Error('잘못된 값입니다.');
  setCfg_('미정포함', v);
  return getData(token);
}

/* ================= 일정 / 식사 / 이동 / 숙소 / 인원 ================= */
function savePlan(token,o){ needAdmin_(token); writeRow_(SHEETS.PLAN,o._row,o); return getData(token); }
function deletePlan(token,r){ needAdmin_(token); deleteRow_(SHEETS.PLAN,r); return getData(token); }

function saveMeal(token,o){ needAdmin_(token); writeRow_(SHEETS.MEAL,o._row,o); return getData(token); }
function deleteMeal(token,r){ needAdmin_(token); deleteRow_(SHEETS.MEAL,r); return getData(token); }

function saveMove(token,o){ needAdmin_(token); writeRow_(SHEETS.MOVE,o._row,o); return getData(token); }
function deleteMove(token,r){ needAdmin_(token); deleteRow_(SHEETS.MOVE,r); return getData(token); }

function saveStay(token,o){ needAdmin_(token); writeRow_(SHEETS.STAY,o._row,o); return getData(token); }
function deleteStay(token,r){ needAdmin_(token); deleteRow_(SHEETS.STAY,r); return getData(token); }

function saveMember(token,o){
  needAdmin_(token);
  if(!o._row){
    var max = Number(cfg_('최대인원')) || DEFAULT_MAX_PEOPLE;
    if(readSheet_(SHEETS.MEMBER).filter(f_('이름')).length >= max)
      throw new Error('최대 인원('+max+'명)을 넘을 수 없습니다.');
    if(memberByName_(o['이름'])) throw new Error('같은 이름이 이미 있습니다.');
  }
  writeRow_(SHEETS.MEMBER,o._row,o);
  return getData(token);
}
function deleteMember(token,r){ needAdmin_(token); deleteRow_(SHEETS.MEMBER,r); return getData(token); }

function saveMeta(token,o){
  needAdmin_(token);
  Object.keys(o).forEach(function(k){
    if(k==='기본비밀번호' || k==='웹앱주소') return;
    setCfg_(k, o[k]);
  });
  return getData(token);
}

/* ================= 참석 / 건의 / 사진 ================= */
function setRsvp(token, name, status){
  var u = who_(token);
  var target = (u.role==='admin' && name) ? String(name).trim() : u.name;
  if(['참석','미정','불참'].indexOf(status)<0) throw new Error('잘못된 값입니다.');
  var m = memberByName_(target);
  if(!m) throw new Error('명단에 없는 이름입니다.');
  writeRow_(SHEETS.MEMBER,m._row,{'참석여부':status});
  return getData(token);
}

function addIdea(token, text){
  var u = who_(token);
  text = String(text||'').trim();
  if(!text) throw new Error('내용을 입력해 주세요.');
  if(text.length>500) throw new Error('500자 이내로 적어주세요.');
  ss_().getSheetByName(SHEETS.IDEA.name).appendRow([u.name,text,now_(),'']);
  return getData(token);
}
function toggleIdea(token,row,done){ needAdmin_(token); writeRow_(SHEETS.IDEA,row,{'반영':done?'O':''}); return getData(token); }
function deleteIdea(token,row){
  var u = who_(token);
  var cur = rowOf_(SHEETS.IDEA,row);
  if(u.role!=='admin' && (!cur || String(cur['작성자']||'').trim()!==u.name))
    throw new Error('본인 글만 삭제할 수 있습니다.');
  deleteRow_(SHEETS.IDEA,row);
  return getData(token);
}

/* ===== 사진 업로드 (구글 드라이브) ===== */

/** 사진을 담을 드라이브 폴더 (없으면 만들고 설정 시트에 기억) */
function photoFolder_(){
  var id = cfg_('사진폴더ID');
  if(id){
    try{ return DriveApp.getFolderById(id); }catch(e){}   // 지워졌으면 새로 만든다
  }
  var name = '여행 상황판 사진 — ' + (cfg_('여행이름') || '여행');
  var folder = DriveApp.createFolder(name);
  try{ folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
  setCfg_('사진폴더ID', folder.getId());
  return folder;
}

/**
 * 화면에서 크기를 줄여 보낸 사진을 드라이브에 저장한다.
 * base64 는 'data:image/jpeg;base64,' 를 뗀 알맹이만 받는다.
 */
function uploadPhoto(token, title, mime, base64){
  var u = who_(token);
  base64 = String(base64||'');
  if(!base64) throw new Error('사진 내용이 비어 있습니다.');
  if(base64.length > 11000000) throw new Error('사진이 너무 큽니다. 한 장씩 올려주세요.');
  mime = String(mime||'image/jpeg');
  if(mime.indexOf('image/') !== 0) throw new Error('사진 파일만 올릴 수 있습니다.');

  var stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss');
  var ext = mime === 'image/png' ? 'png' : 'jpg';
  var fileName = u.name + '_' + stamp + '.' + ext;

  var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, fileName);
  var file = photoFolder_().createFile(blob);
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch(e){ /* 조직 정책으로 공유가 막히면 본인만 보이게 된다 */ }

  var fid = file.getId();
  ss_().getSheetByName(SHEETS.PHOTO.name).appendRow([
    String(title||'').slice(0,60),
    'https://drive.google.com/thumbnail?id=' + fid + '&sz=w1200',
    u.name, now_(), fid, 'drive'
  ]);
  invalidate_();
  return getData(token);
}

function addPhoto(token,o){
  var u = who_(token);
  var url = String(o.url||'').trim();
  if(!/^https?:\/\//i.test(url)) throw new Error('http 로 시작하는 주소를 넣어주세요.');
  ss_().getSheetByName(SHEETS.PHOTO.name)
       .appendRow([String(o.title||'').slice(0,60), url, u.name, now_(), '', 'link']);
  return getData(token);
}
function deletePhoto(token,row){
  var u = who_(token);
  var cur = rowOf_(SHEETS.PHOTO,row);
  if(u.role!=='admin' && (!cur || String(cur['올린사람']||'').trim()!==u.name))
    throw new Error('본인이 올린 사진만 삭제할 수 있습니다.');
  var fid = cur ? String(cur['파일ID']||'').trim() : '';
  if(fid){ try{ DriveApp.getFileById(fid).setTrashed(true); }catch(e){} }
  deleteRow_(SHEETS.PHOTO,row);
  return getData(token);
}
