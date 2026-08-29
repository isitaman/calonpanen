// ============================================
// KONFIGURASI
// Jika script dibuat langsung di dalam Spreadsheet (bound script),
// biarkan SPREADSHEET_ID kosong. Jika standalone, isi ID spreadsheet.
// ============================================
const SPREADSHEET_ID = '';

// Nama sheet — sesuaikan dengan nama sheet di Spreadsheet Anda
const SHEET_LOGIN = 'LOGIN';
const SHEET_BULAN_INI = 'BULAN INI / BULAN DEPAN';
const SHEET_LEBIH_2_BULAN = 'LEBIH DARI 2 BULAN';
const SHEET_DATA_AKAN_PANEN = 'DATA AKAN PANEN';

// Token berlaku 6 jam (dalam detik)
const TOKEN_TTL = 21600;

// ============================================
// HELPER
// ============================================
function getSpreadsheet() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function jsonResp(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// WEB APP ENTRY POINT
// ============================================
function doGet(e) {
  try {
    var action = e.parameter.action;
    switch (action) {
      case 'login':  return jsonResp(doLogin(e.parameter));
      case 'getData': return jsonResp(doGetData(e.parameter));
      case 'verify':  return jsonResp(doVerify(e.parameter));
      default:        return jsonResp({ error: 'Aksi tidak valid' });
    }
  } catch (err) {
    return jsonResp({ error: err.message });
  }
}

// ============================================
// LOGIN
// Struktur sheet LOGIN: A=Username, B=Password, C=Role, D=Nama
// ============================================
function doLogin(p) {
  var username = (p.username || '').trim();
  var password = p.password || '';

  if (!username || !password) {
    return { success: false, error: 'Username dan password wajib diisi' };
  }

  var sheet = getSpreadsheet().getSheetByName(SHEET_LOGIN);
  if (!sheet) return { success: false, error: 'Sheet LOGIN tidak ditemukan' };

  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (
      String(row[0]).trim().toLowerCase() === username.toLowerCase() &&
      String(row[1]).trim() === password
    ) {
      var token = Utilities.getUuid();
      var userData = {
        username: String(row[0]).trim(),
        name:     row[3] ? String(row[3]).trim() : String(row[0]).trim(),
        role:     String(row[2]).trim().toLowerCase()
      };
      CacheService.getScriptCache().put('tk_' + token, JSON.stringify(userData), TOKEN_TTL);
      return { success: true, token: token, name: userData.name, role: userData.role };
    }
  }

  return { success: false, error: 'Username atau password salah' };
}

// ============================================
// VERIFY TOKEN
// ============================================
function doVerify(p) {
  var cached = CacheService.getScriptCache().get('tk_' + (p.token || ''));
  if (!cached) return { valid: false };
  var u = JSON.parse(cached);
  return { valid: true, name: u.name, role: u.role, username: u.username };
}

// ============================================
// GET DATA
// ============================================
function doGetData(p) {
  var token = p.token || '';
  var sheetKey = p.sheet || '';

  // Verifikasi token
  var cached = CacheService.getScriptCache().get('tk_' + token);
  if (!cached) return { error: 'Sesi berakhir, silakan login kembali' };

  var user = JSON.parse(cached);

  // Peta sheet key → nama sheet
  var sheetName;
  if (sheetKey === 'bulan_ini') {
    sheetName = SHEET_BULAN_INI;
  } else if (sheetKey === 'lebih_2_bulan') {
    sheetName = SHEET_LEBIH_2_BULAN;
  } else if (sheetKey === 'data_akan_panen') {
    sheetName = SHEET_DATA_AKAN_PANEN;
  } else {
    return { error: 'Sheet tidak dikenali' };
  }

  // Hak akses: sales hanya boleh akses bulan ini
  if (sheetKey === 'lebih_2_bulan' && user.role !== 'budidaya') {
    return { error: 'Akses ditolak' };
  }

  var sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { error: 'Sheet "' + sheetName + '" tidak ditemukan' };

  var rawData = sheet.getDataRange().getValues();
  if (rawData.length <= 1) {
    return { success: true, data: [], headers: rawData[0] ? rawData[0].map(String) : [] };
  }

  var headers = rawData[0].map(function(h) { return String(h).trim(); });
  var rows = [];

  for (var i = 1; i < rawData.length; i++) {
    var row = rawData[i];
    // Skip baris kosong
    var isEmpty = true;
    for (var j = 0; j < row.length; j++) {
      if (row[j] !== '' && row[j] !== null && row[j] !== undefined) {
        isEmpty = false;
        break;
      }
    }
    if (isEmpty) continue;

    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = j < row.length ? row[j] : '';
      // Format otomatis untuk kolom tanggal
      if (val instanceof Date) {
        obj[headers[j]] = Utilities.formatDate(val, 'Asia/Jakarta', 'dd/MM/yyyy');
      } else {
        obj[headers[j]] = val;
      }
    }
    rows.push(obj);
  }

  return { success: true, data: rows, headers: headers };
}