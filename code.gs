/* =============================================
   INFO PANEN APP  —  Google Apps Script Backend
   ============================================= */

var APP = {
  PROP_SS: 'SIMSTOK_SPREADSHEET_ID',
  PROP_US: 'INFOPANEN_USERS',
  PROP_SESSIONS: 'INFOPANEN_SESSIONS',
  SH_MAIN: 'Ringkasan Stok',
  SH_KODE: 'List Kode Silangan',
  SH_LOG:  'Log Validasi Panen',
  SH_AI:   'Analisa AI',
  EXT_ID:  '1es_iMZKPzYE8RU5r6uXj0ik7EYFI5FR-k27sX269Dm8',
  EXT_S1:  'DATABASE KELAYAKAN',
  EXT_S2:  'KELAYAKAN',
  TZ: 'Asia/Jakarta',
  SESSION_TTL_MS: 4 * 60 * 60 * 1000
};

/* Kolom Ringkasan Stok (0-based, SIMSTOK 3.1) */
var C = { KP:0, FA:1, IP:2, NP:3, TV:4, QA:5, TP:6, TR:7, SS:8, EP:9, HS:10, SV:11 };

/* Kolom Log Validasi Panen (0-based, SIMSTOK 3.3) */
var L = { ID:0, KP:1, PR:2, KG:3, FA:4, IP:5, EA:6, PA:7, PN:8, AF:9, QN:10, QA:11, SV:12, TI:13, IO:14, CT:15 };


/* --- WEB APP ENTRY --- */
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('Info Panen - Harvest Intelligence')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


/* --- ONE-TIME SETUP --- */
function setupApp() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty(APP.PROP_SS)) {
    p.setProperty(APP.PROP_SS, 'PASTE_SPREADSHEET_ID_SIMSTOK_DISINI');
  }
  if (!p.getProperty(APP.PROP_US)) {
    p.setProperty(APP.PROP_US, JSON.stringify([
      { username: 'marketing', password: 'mkt2024', role: 'marketing', name: 'Tim Marketing' },
      { username: 'budidaya',  password: 'bud2024', role: 'budidaya',  name: 'Tim Budidaya'  },
      { username: 'admin',     password: 'adm2024', role: 'budidaya',  name: 'Administrator'  }
    ]));
  }
  Logger.log('Info Panen App initialized. Update ScriptProperties with your SS ID.');
}


/* ======== AUTH MODULE ======== */
function authenticateUser(username, password) {
  try {
    if (!username || !password) return { success: false, message: 'Username dan password wajib diisi.' };
    var raw = PropertiesService.getScriptProperties().getProperty(APP.PROP_US);
    if (!raw) return { success: false, message: 'Aplikasi belum dikonfigurasi. Jalankan setupApp() dulu.' };
    var users = JSON.parse(raw);
    var user = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].username === username.trim().toLowerCase() && users[i].password === password) { user = users[i]; break; }
    }
    if (!user) return { success: false, message: 'Username atau password salah.' };
    var token = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, user.username + Date.now() + Math.random())
      .map(function(b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
    var sessions = getSessions_();
    sessions[token] = {
      username: user.username,
      role: user.role,
      name: user.name,
      expiry: Date.now() + APP.SESSION_TTL_MS
    };
    PropertiesService.getScriptProperties().setProperty(APP.PROP_SESSIONS, JSON.stringify(sessions));
    return { success: true, role: user.role, name: user.name, token: token };
  } catch (e) {
    return { success: false, message: 'Kesalahan sistem saat autentikasi.' };
  }
}

function getSessions_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(APP.PROP_SESSIONS) || '{}');
  } catch (e) { return {}; }
}

function getSessionUser_(token) {
  if (!token) return null;
  var all = getSessions_();
  var s = all[token];
  if (!s) return null;
  if (s.expiry < Date.now()) {
    delete all[token];
    PropertiesService.getScriptProperties().setProperty(APP.PROP_SESSIONS, JSON.stringify(all));
    return null;
  }
  return s;
}


/* ======== DATA ACCESS MODULE ======== */
function fetchPanenData(role, token) {
  try {
    var sess = getSessionUser_(token);
    if (!sess) return { success: false, message: 'Sesi berakhir. Silakan login ulang.' };
    if (role !== 'marketing' && role !== 'budidaya') return { success: false, message: 'Role tidak valid.' };
    if (sess.role !== role) return { success: false, message: 'Role tidak sesuai dengan sesi login.' };
    var ss = getSS_();
    if (!ss) return { success: false, message: 'Spreadsheet SIMSTOK tidak ditemukan.' };
    var sh = ss.getSheetByName(APP.SH_MAIN);
    if (!sh) return { success: false, message: 'Sheet "Ringkasan Stok" tidak ditemukan.' };

    var kodeMap = buildKodeAsalMap_(ss);
    var logMap  = buildLatestLogMap_(ss);
    var kelayakanMap = buildKelayakanMap_();
    var items  = parseRingkasanStok_(sh, kodeMap, logMap, kelayakanMap);
    var ranges = getDateRanges_();

    var result, meta;
    if (role === 'marketing') {
      result = filterMarketing_(items, ranges);
      meta = {
        period: ranges.marketing.label,
        month: ranges.marketing.month,
        year: ranges.marketing.year,
        totalItems: result.length,
        totalSisaStok: sumField_(result, 'sisaStok'),
        totalPetani: countUnique_(result, 'idPetani')
      };
    } else {
      result = filterBudidaya_(items, ranges);
      var flat = [];
      for (var g = 0; g < result.length; g++) for (var j = 0; j < result[g].items.length; j++) flat.push(result[g].items[j]);
      meta = {
        periodStart: ranges.budidaya.months[0].label,
        periodEnd: ranges.budidaya.months[ranges.budidaya.months.length - 1].label,
        totalItems: flat.length,
        totalSisaStok: sumField_(flat, 'sisaStok'),
        activeMonths: result.length
      };
    }
    return { success: true, data: stripDateFields_(result), meta: meta };
  } catch (e) {
    return { success: false, message: 'Gagal mengambil data: ' + e.message };
  }
}

function stripDateFields_(list) {
  var i, j;
  for (i = 0; i < list.length; i++) {
    var group = list[i];
    if (group && Array.isArray(group.items)) {
      for (j = 0; j < group.items.length; j++) stripItem_(group.items[j]);
    } else if (group) {
      stripItem_(group);
    }
  }
  return list;
}

function stripItem_(it) {
  delete it.estAwalPanen;
  delete it.panenDate;
  return it;
}


/* ======== AI INTEGRATION: baca hasil terbaru dari sheet Analisa AI ======== */
function getAiInsights(kodeProject, fase, idPetani, token) {
  try {
    var sess = getSessionUser_(token);
    if (!sess) return { status: 'auth_failed', message: 'Sesi berakhir. Silakan login ulang.', kodeProject: kodeProject };
    var ss = getSS_();
    if (!ss) return { status: 'error', message: 'Spreadsheet SIMSTOK tidak ditemukan.', kodeProject: kodeProject };
    var sh = ss.getSheetByName(APP.SH_AI);
    if (!sh || sh.getLastRow() < 2) return { status: 'empty', message: 'Belum ada data analisa AI. Jalankan generate analisa di SIMSTOK dulu.', kodeProject: kodeProject };
    var vals = sh.getDataRange().getValues();
    var kp = String(kodeProject || '').trim();
    if (!kp) return { status: 'empty', message: 'Kode tidak valid.', kodeProject: kodeProject };
    var tFase = String(fase || '').trim();
    /* Analisa AI tidak punya kolom ID Petani; padankan Kode (+Fase jika diberikan),
       prioritaskan baris dengan fase yang sama, sisanya ambil entri terbaru per kode. */
    var best = null, bestFase = null;
    for (var i = vals.length - 1; i >= 1; i--) {
      var r = vals[i];
      var c1 = String(r[1] || '').trim();            // Kode Project
      var c9 = String(r[9] || '').trim();            // Kode Asal
      if (c1 !== kp && !(c9 && c9 === kp)) continue;
      if (!best || bestFase) best = r;
      if (tFase && String(r[3] || '').trim() === tFase) {
        best = r; bestFase = tFase; break;
      }
    }
    if (best) {
      var r = sanitizeAiRows_([best])[0];
      var dijual = Number(r[7]) || 0;
      var harga = Number(r[13]) || 0;
      return {
        status: 'ok',
        kodeProject: r[1],
        kodeAsal: c9,
        namaProduk: r[2],
        fase: r[3],
        namaPetani: r[4],
        keunikan: r[10],
        qtyNormal: Number(r[5]) || 0,
        dibesarkan: Number(r[6]) || 0,
        dijual: dijual,
        omzet: Math.round(dijual * harga),
        alasan: r[8],
        bulan: r[0],
        message: 'Rekomendasi AI (' + r[0] + '): besarkan ' + (Number(r[6]) || 0) + ' & jual ' + dijual + ' unit.'
      };
    }
    return { status: 'empty', kodeProject: kodeProject, message: 'Belum ada rekomendasi AI untuk kode ' + kodeProject + (tFase ? ' (fase ' + tFase + ')' : '') + ' di sheet Analisa AI.' };
  } catch (e) {
    return { status: 'error', message: 'Gagal mengambil rekomendasi: ' + e.message, kodeProject: kodeProject };
  }
}

/* Fallback: kirim semua baris Analisa AI mentah (array-of-array) — Date diserbari jadi string agar GAS tidak drop respons */
function fetchAiRows(token) {
  var sess = getSessionUser_(token);
  if (!sess) return ['ERR', 'Sesi berakhir. Silakan login ulang.'];
  try {
    var ss = getSS_();
    if (!ss) return ['ERR', 'Spreadsheet SIMSTOK tidak ditemukan.'];
    var sh = ss.getSheetByName(APP.SH_AI);
    if (!sh || sh.getLastRow() < 2) return [];
    return sanitizeAiRows_(sh.getDataRange().getValues());
  } catch (e) {
    return ['ERR', String(e)];
  }
}

function sanitizeAiRows_(rows) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], nr = [];
    for (var j = 0; j < r.length; j++) {
      var v = r[j];
      if (v instanceof Date && !isNaN(v.getTime())) {
        nr.push(Utilities.formatDate(v, APP.TZ, 'yyyy-MM-dd'));
      } else {
        nr.push(v);
      }
    }
    out.push(nr);
  }
  return out;
}


/* ======== DIAGNOSTIK SETUP ======== */
function diagnoseApp() {
  var p = PropertiesService.getScriptProperties();
  var ssId = p.getProperty(APP.PROP_SS);
  var info = {
    propSS: !!(ssId && ssId !== 'PASTE_SPREADSHEET_ID_SIMSTOK_DISINI'),
    usersConfigured: !!p.getProperty(APP.PROP_US),
    spreadsheetsAccessible: null,
    sheetsPresent: {},
    error: ''
  };
  if (info.propSS) {
    try {
      var ss = SpreadsheetApp.openById(ssId);
      info.spreadsheetsAccessible = true;
      ['Ringkasan Stok', 'List Kode Silangan', 'Log Validasi Panen', 'Analisa AI'].forEach(function(n) {
        info.sheetsPresent[n] = !!ss.getSheetByName(n);
      });
      try {
        var sh = ss.getSheetByName(APP.SH_MAIN);
        var kodeMap = buildKodeAsalMap_(ss);
        var logMap = buildLatestLogMap_(ss);
        var kel = buildKelayakanMap_();
        var items = (sh && sh.getLastRow() >= 2) ? parseRingkasanStok_(sh, kodeMap, logMap, kel) : [];
        var ranges = getDateRanges_();
        info.itemCount = items.length;
        info.marketingCount = filterMarketing_(items, ranges).length;
        info.budidayaGroups = filterBudidaya_(items, ranges).length;
        if (items.length) {
          info.sample = { kode: items[0].kodeProject, petani: items[0].namaPetani, sisaStok: items[0].sisaStok, estStr: items[0].estPanenStr, status: items[0].statusValidasi };
        }
      } catch (e2) {
        info.pipelineError = String(e2);
      }
    } catch (e) {
      info.spreadsheetsAccessible = false;
      info.error = String(e);
    }
  }
  return info;
}


/* ======== PRIVATE FUNCTIONS ======== */

function getSS_() {
  var id = PropertiesService.getScriptProperties().getProperty(APP.PROP_SS);
  if (!id || id === 'PASTE_SPREADSHEET_ID_SIMSTOK_DISINI') return null;
  try { return SpreadsheetApp.openById(id); } catch (e) { return null; }
}


/* --- Parse Ringkasan Stok --- */
function parseRingkasanStok_(sheet, kodeMap, logMap, kelayakanMap) {
  var lr = sheet.getLastRow();
  var lc = sheet.getLastColumn();
  if (lr < 2) return [];
  var raw = sheet.getRange(2, 1, lr - 1, lc).getValues();
  var items = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    var kp = String(r[C.KP] || '').trim();
    if (!kp) continue;
    var estPanen = parseDate_(r[C.EP]);
    if (!estPanen) continue;

    var fase = normFase_(String(r[C.FA] || '').trim());
    var idP  = String(r[C.IP] || '').trim();
    var logKey = kp + '|' + fase + '|' + idP;

    var kodeInfo = kodeMap[kp] || { kodeAsal: '', genus: '', produk: '' };
    var logInfo  = logMap[logKey] || null;
    var lkKey    = kodeInfo.kodeAsal || kp;
    var kelayakan = kelayakanMap[lkKey] || kelayakanMap[kp] || null;
    var namaProduk = (logInfo && logInfo.namaProduk) ? logInfo.namaProduk : (kodeInfo.produk || '');
    var status = (logInfo && logInfo.statusValidasi) ? logInfo.statusValidasi : normStatus_(String(r[C.SV] || '').trim());
    var panenDate = (logInfo && logInfo.tglPanenAktualDate) ? logInfo.tglPanenAktualDate : estPanen;

    items.push({
      kodeProject:     kp,
      fase:            fase,
      idPetani:        idP,
      namaPetani:      String(r[C.NP] || '').trim(),
      tglValidasi:     fmtDate_(r[C.TV]),
      qtyAwal:         Number(r[C.QA]) || 0,
      totalPanen:      Number(r[C.TP]) || 0,
      sisaStok:        Number(r[C.SS]) || 0,
      estAwalPanen:    estPanen,
      estPanenStr:     Utilities.formatDate(panenDate, APP.TZ, 'd MMM yyyy'),
      hst:             parseInt(r[C.HS]) || 0,
      statusValidasi:  status,
      kodeAsal:        kodeInfo.kodeAsal,
      genus:           kodeInfo.genus,
      namaProduk:      namaProduk,
      keunikan:        kelayakan ? kelayakan.keunikan : '',
      hargaSeedling:   kelayakan ? kelayakan.harga : 0,
      tglPanenAktual:  (logInfo && logInfo.tglPanenAktual) ? logInfo.tglPanenAktual : '',
      qtyNormal:       (logInfo) ? logInfo.qtyNormal : 0,
      qtyAfkir:        (logInfo) ? logInfo.qtyAfkir : 0,
      panenDate:       panenDate
    });
  }
  return items;
}


/* --- List Kode Silangan: A=kode kebun, E=kode asal, B=genus, C=produk --- */
function buildKodeAsalMap_(ss) {
  var sh = ss.getSheetByName(APP.SH_KODE);
  var map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  for (var i = 0; i < data.length; i++) {
    var kk = String(data[i][0] || '').trim();
    if (kk) map[kk] = { kodeAsal: String(data[i][4] || '').trim(), genus: String(data[i][1] || '').trim(), produk: String(data[i][2] || '').trim() };
  }
  return map;
}


/* --- Log Validasi Panen: latest entry per key Kode Project|Fase|ID Petani ---
   Key fase disimpan dua varian (mentah & ternormalisasi) agar cocok dengan
   lookup Ringkasan yang memakai normFase_. */
function buildLatestLogMap_(ss) {
  var sh = ss.getSheetByName(APP.SH_LOG);
  var map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  var lr = sh.getLastRow();
  var lc = Math.min(sh.getLastColumn(), 16);
  var data = sh.getRange(2, 1, lr - 1, lc).getValues();
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var kp = String(r[L.KP] || '').trim();
    if (!kp) continue;
    var ip = String(r[L.IP] || '').trim();
    var tglInput = r[L.TI];
    var tglAktualRaw = r[L.PA];
    var tglAktualDate = (tglAktualRaw instanceof Date && !isNaN(tglAktualRaw.getTime())) ? tglAktualRaw : null;
    var tglAktualStr = tglAktualDate ? Utilities.formatDate(tglAktualDate, APP.TZ, 'd MMM yyyy') : '';
    var record = {
      namaProduk:      String(r[L.PR] || '').trim(),
      kodeGenus:       String(r[L.KG] || '').trim(),
      tglPanenAktual:  tglAktualStr,
      tglPanenAktualDate: tglAktualDate,
      qtyNormal:       Number(r[L.QN]) || 0,
      qtyAfkir:        Number(r[L.QA]) || 0,
      statusValidasi:  normStatus_(String(r[L.SV] || '').trim()),
      tglInput:        (tglInput instanceof Date) ? tglInput : new Date(0)
    };

    var faseRaw = String(r[L.FA] || '').trim();
    var faseNorm = normFase_(faseRaw);
    var faseKeys = [faseRaw];
    if (faseNorm && faseNorm !== faseRaw) faseKeys.push(faseNorm);

    for (var c = 0; c < faseKeys.length; c++) {
      if (!faseKeys[c]) continue;
      var key = kp + '|' + faseKeys[c] + '|' + ip;
      var existing = map[key];
      if (!existing || (tglInput instanceof Date && existing.tglInput instanceof Date && tglInput.getTime() > existing.tglInput.getTime())) {
        map[key] = record;
      }
    }
  }
  return map;
}


/* --- DATABASE KELAYAKAN (external SS): Kode Project -> Keunikan, Harga Seedling --- */
function buildKelayakanMap_() {
  var map = {};
  try {
    var extSS = SpreadsheetApp.openById(APP.EXT_ID);
    var sh = extSS.getSheetByName(APP.EXT_S1) || extSS.getSheetByName(APP.EXT_S2);
    if (!sh || sh.getLastRow() < 2) return map;
    var lr = sh.getLastRow();
    var lc = sh.getLastColumn();
    var data = sh.getRange(1, 1, lr, lc).getValues();
    var headers = data[0];
    var colKP = -1, colU = -1, colH = -1;
    for (var h = 0; h < headers.length; h++) {
      var hd = String(headers[h] || '').trim().toLowerCase();
      if (hd === 'kode project' && colKP < 0) colKP = h;
      if (hd === 'keunikan' && colU < 0) colU = h;
    }
    for (var h2 = 0; h2 < headers.length; h2++) {
      var hd2 = String(headers[h2] || '').trim().toLowerCase();
      if (hd2 === 'harga seedling') { colH = h2; break; }
    }
    if (colH < 0) {
      for (var h3 = 0; h3 < headers.length; h3++) {
        if (String(headers[h3] || '').trim().toLowerCase().indexOf('harga') >= 0) { colH = h3; break; }
      }
    }
    if (colKP < 0) return map;
    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][colKP] || '').trim();
      if (!key) continue;
      if (!(key in map)) {
        map[key] = {
          keunikan: (colU >= 0) ? String(data[i][colU] || '').trim() : '',
          harga: (colH >= 0) ? Number(data[i][colH]) || 0 : 0
        };
      }
    }
  } catch (e) {
    console.error('Kelayakan read error (sheet mungkin belum di-share):', e);
  }
  return map;
}


/* --- DATE RANGES --- */
function getDateRanges_() {
  var tz = APP.TZ;
  var now = new Date();
  var curM = parseInt(Utilities.formatDate(now, tz, 'M'));
  var curY = parseInt(Utilities.formatDate(now, tz, 'yyyy'));

  var mkM = curM + 1, mkY = curY;
  if (mkM > 12) { mkM = 1; mkY++; }
  var mkStart = new Date(mkY, mkM - 1, 1);
  var mkEnd   = new Date(mkY, mkM, 0, 23, 59, 59);
  var mkLabel = Utilities.formatDate(mkStart, tz, 'MMMM yyyy');

  var bMonths = [];
  for (var i = 1; i <= 5; i++) {
    var m = curM + i, y = curY;
    while (m > 12) { m -= 12; y++; }
    bMonths.push({ month: m, year: y, label: Utilities.formatDate(new Date(y, m - 1, 15), tz, 'MMMM yyyy') });
  }
  var bStart = new Date(bMonths[0].year, bMonths[0].month - 1, 1);
  var bLast  = bMonths[bMonths.length - 1];
  var bEnd   = new Date(bLast.year, bLast.month, 0, 23, 59, 59);

  return {
    marketing: { start: mkStart, end: mkEnd, month: mkM, year: mkY, label: mkLabel },
    budidaya:  { start: bStart, end: bEnd, months: bMonths }
  };
}


/* --- FILTER: Marketing --- */
function filterMarketing_(items, ranges) {
  var s = ranges.marketing.start, e = ranges.marketing.end;
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.statusValidasi === 'Tervalidasi' && it.panenDate >= s && it.panenDate <= e) out.push(it);
  }
  return out;
}


/* --- FILTER: Budidaya --- */
function filterBudidaya_(items, ranges) {
  var s = ranges.budidaya.start, e = ranges.budidaya.end, months = ranges.budidaya.months;
  var inRange = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].panenDate >= s && items[i].panenDate <= e) inRange.push(items[i]);
  }
  var groups = [];
  for (var m = 0; m < months.length; m++) {
    var mi = months[m];
    var mS = new Date(mi.year, mi.month - 1, 1);
    var mE = new Date(mi.year, mi.month, 0, 23, 59, 59);
    var mItems = [];
    for (var j = 0; j < inRange.length; j++) {
      if (inRange[j].panenDate >= mS && inRange[j].panenDate <= mE) mItems.push(inRange[j]);
    }
    if (mItems.length === 0) continue;
    var faseSum = { Seedling: 0, Remaja: 0, Dewasa: 0 };
    var totalSisa = 0;
    for (var k = 0; k < mItems.length; k++) {
      if (faseSum.hasOwnProperty(mItems[k].fase)) faseSum[mItems[k].fase] += mItems[k].sisaStok;
      totalSisa += mItems[k].sisaStok;
    }
    groups.push({
      monthKey: mi.year + '-' + (mi.month < 10 ? '0' : '') + mi.month,
      label: mi.label, month: mi.month, year: mi.year,
      items: mItems, faseSummary: faseSum, totalSisaStok: totalSisa
    });
  }
  return groups;
}


/* --- NORMALIZE STATUS (SIMSTOK: Belum / Tervalidasi / Tertunda) --- */
function normStatus_(raw) {
  if (!raw) return 'Belum';
  var n = String(raw).toLowerCase().trim();
  if (n.indexOf('tervalidasi') >= 0 || n === 'valid' || n === 'validated') return 'Tervalidasi';
  if (n.indexOf('tertunda') >= 0 || n.indexOf('ditunda') >= 0) return 'Tertunda';
  if (n.indexOf('belum') >= 0 || n === 'pending' || n === 'draft' || n === '-') return 'Belum';
  return String(raw).trim();
}

function normFase_(raw) {
  if (!raw) return 'N/A';
  var n = raw.toLowerCase().trim();
  if (n.indexOf('seedling') >= 0 || n.indexOf('semai') >= 0 || n.indexOf('bibit') >= 0) return 'Seedling';
  if (n.indexOf('remaja') >= 0 || n.indexOf('youth') >= 0 || n.indexOf('vegetatif') >= 0) return 'Remaja';
  if (n.indexOf('dewasa') >= 0 || n.indexOf('mature') >= 0 || n.indexOf('produktif') >= 0) return 'Dewasa';
  return raw;
}


/* --- DATE PARSER --- */
function parseDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === 'string' && val.trim()) {
    var d = new Date(val);
    if (!isNaN(d.getTime())) return d;
    var m = val.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    return null;
  }
  if (typeof val === 'number' && val > 40000) return new Date((val - 25569) * 86400000);
  return null;
}

function fmtDate_(val) {
  var d = parseDate_(val);
  return d ? Utilities.formatDate(d, APP.TZ, 'd MMM yyyy') : '-';
}


/* --- HELPERS --- */
function sumField_(arr, field) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += (arr[i][field] || 0);
  return s;
}

function countUnique_(arr, field) {
  var seen = {};
  var c = 0;
  for (var i = 0; i < arr.length; i++) {
    var v = arr[i][field];
    if (v && !seen[v]) { seen[v] = true; c++; }
  }
  return c;
}