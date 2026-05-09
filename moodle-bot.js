// ============================================================================
// Moodle AI Briefing Bot — n8n Code Node (Schedule Filter + Test Mode)
// ----------------------------------------------------------------------------
// Author:  Johannes Uth · https://github.com/johannesuth
// License: MIT
// Repo:    https://github.com/johannesuth/moodle-ai-briefing-bot
// ========================================================================================================================================================
// Was drin ist:
// - Login via Moodle Web Service API (zuverlaessig, kein HTML-Scraping)
// - Filter: abgelaufene + erledigte Aufgaben werden ausgeblendet
// - Aufgaben-Cache: offene Aufgaben werden bei jedem Lauf gezeigt mit gecachten Briefings
// - ADAPTIVE Summary-Tiefe: bei 137-Seiten-PDF -> ~20 Seiten Summary (Sonnet 4.6)
//   bei kurzen PDFs -> Haiku, bei langen -> Sonnet mit grossem max_tokens
// - PDF-Generator nativ (Helvetica, multi-page)
// - Datei-Umbenennung intelligent via Anthropic
// - Handschrift-Erkennung (handgeschriebene PDFs werden NICHT zusammengefasst)
// - Kompakte Email mit Lesezeit-Anzeige + "Bald faellig"-Sektion + Subject mit Dringlichkeit
// - ZIP_MAX_MB 12 (Gmail-sicher), DEFLATE-Compression
// - Schedule-Filter: nur Mo/Mi/Fr 13:00 Berlin-Zeit (weil n8n-Cron kaputt ist)
// - Cost-Tracking in Logs
// - TESTMODUS (ganz oben): TEST_MODE=true ueberspringt den Schedule-Filter
// ============================================================================

// === TESTMODUS ===
// true  = Schedule-Filter wird IGNORIERT, Workflow laeuft bei jedem Klick auf "Execute Workflow"
// false = Schedule-Filter aktiv, Workflow laeuft nur Mo/Mi/Fr 13:00-14:30 Berlin-Zeit
const TEST_MODE = false;

const CONFIG = {
  MOODLE_USERNAME:    '',  // dein Moodle-Login
  MOODLE_PASSWORD:    '',  // dein Moodle-Passwort
  ANTHROPIC_API_KEY:  '',
  ZIP_MAX_MB:         12,    // Gmail-sicher (15-16MB nach base64 = unter 25MB)
  FIRST_RUN_LIMIT:    999,   // Kein Limit beim Erstlauf
  PER_FILE_MAX_MB:    40,
  HIDE_OVERDUE:       true,
  HIDE_COMPLETED:     true,
  RENAME_FILES:       true,
  MODEL_LIGHT:        'claude-haiku-4-5-20251001',  // Aufgaben-Hinweise, kurze PDFs (<10 Seiten)
  MODEL_SUMMARY:      'claude-sonnet-4-6',           // Zusammenfassungen langer PDFs
  MODEL_BRIEFING:     'claude-sonnet-4-6',           // Aufgaben-Briefings
  LINK_RESOURCES:     true,  // Course-Resources die in Aufgaben erwaehnt werden in Aufgaben-Ordner kopieren
};

const BASE_URL = 'https://your-moodle-instance.example.com';  // z.B. https://moodle.deine-hochschule.de
const NOW = new Date();
const NOW_TS = Math.floor(NOW.getTime() / 1000);
const DATE_STR = NOW.toISOString().slice(0, 10);
const DAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DATE_DE = `${DAYS_DE[NOW.getDay()]}, ${String(NOW.getDate()).padStart(2,'0')}.${String(NOW.getMonth()+1).padStart(2,'0')}.${NOW.getFullYear()}`;

const staticData = $getWorkflowStaticData('global');
if (!staticData.seenFiles) staticData.seenFiles = {};

// === SCHEDULE FILTER (weil Cron auf diesem n8n-Server nicht zuverlaessig triggert) ===
// Workflow ist im Schedule Trigger auf "every 1 hour" gestellt (Interval, NICHT Cron).
// Hier filtern wir: nur wenn Wochentag + Stundenfenster passt + heute noch nicht gelaufen.
const SCHEDULE = {
  enabled: true,
  weekdays: [1, 3, 5],          // Mo=1, Di=2, Mi=3, Do=4, Fr=5, Sa=6, So=0
  hour: 13,                     // 13:00 Berlin-Zeit
  toleranceMinutes: 90,         // Trigger bis 90 Min nach Ziel ist noch OK
};
if (SCHEDULE.enabled && !TEST_MODE) {
  const berlinNow = new Date(NOW.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const dayOK = SCHEDULE.weekdays.includes(berlinNow.getDay());
  const target = new Date(berlinNow);
  target.setHours(SCHEDULE.hour, 0, 0, 0);
  const minutesSinceTarget = (berlinNow - target) / 60000;
  const inWindow = minutesSinceTarget >= 0 && minutesSinceTarget <= SCHEDULE.toleranceMinutes;
  const todayKey = `${berlinNow.getFullYear()}-${berlinNow.getMonth()}-${berlinNow.getDate()}-h${SCHEDULE.hour}`;
  const alreadyRanToday = staticData.lastScheduledRun === todayKey;
  if (!dayOK || !inWindow || alreadyRanToday) {
    const reason = !dayOK ? 'falscher Wochentag' : !inWindow ? `nicht im Fenster (${minutesSinceTarget.toFixed(0)} Min nach Ziel)` : 'heute schon gelaufen';
    console.log(`Schedule-Filter SKIP: ${['So','Mo','Di','Mi','Do','Fr','Sa'][berlinNow.getDay()]} ${berlinNow.getHours()}:${String(berlinNow.getMinutes()).padStart(2,'0')} → ${reason}`);
    return [{ json: { skipped: true, reason } }];
  }
  staticData.lastScheduledRun = todayKey;
  console.log(`Schedule-Filter PASS: ${['So','Mo','Di','Mi','Do','Fr','Sa'][berlinNow.getDay()]} ${berlinNow.getHours()}:${String(berlinNow.getMinutes()).padStart(2,'0')} → laeuft`);
}

if (!staticData.seenAssignments) staticData.seenAssignments = {};
if (staticData.firstRun === undefined) staticData.firstRun = true;
const isFirstRun = staticData.firstRun;
const seenFiles = staticData.seenFiles;
const seenAssignments = staticData.seenAssignments;

console.log(`=== Moodle AI Briefing Bot — ${DATE_DE} ===`);
console.log(`State: ${Object.keys(seenFiles).length} Files, ${Object.keys(seenAssignments).length} Aufgaben bekannt. Erstlauf: ${isFirstRun}`);

const helpers = this.helpers;

// === UTILITIES ===

function htmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeFilename(name, maxLen = 120) {
  return String(name ?? 'unnamed').normalize('NFKD').replace(/[^\w\.\- äöüÄÖÜß()]/g, '_').trim().slice(0, maxLen) || 'unnamed';
}
function safeFolder(name, maxLen = 60) {
  // Filesystem-sichere Zeichen, aber Spaces erlauben (lesbarer)
  return String(name ?? 'Kurs').normalize('NFKD').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, maxLen) || 'Kurs';
}
function prettifyCourseName(name) {
  // Entfernt Suffixe wie (SoSe26), (WiSe25/26), (Zug 1) etc.
  return String(name || '')
    .replace(/\s*\(SoSe\s*\d{2,4}(?:\/\d{2,4})?\)\s*/gi, '')
    .replace(/\s*\(WiSe\s*\d{2,4}(?:\/\d{2,4})?\)\s*/gi, '')
    .replace(/\s*\(Zug\s*\d+\)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || name;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function estimateReadingMinutes(sizeBytes, isPdf) {
  // Heuristik: ~50KB pro Seite bei PDFs, 250 Worte/Seite, 200 Worte/Min Lesegeschwindigkeit
  if (!isPdf) return Math.max(1, Math.round(sizeBytes / 50000));
  const estPages = Math.max(1, Math.round(sizeBytes / 50000));
  const estMinutes = Math.round(estPages * 1.25);
  return estMinutes;
}
function formatReadTime(min) {
  if (min < 1) return '<1 Min';
  if (min < 60) return `~${min} Min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `~${h} Std` : `~${h}h ${m}min`;
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function formatDeadline(ts) {
  if (!ts) return '';
  const dl = new Date(ts * 1000);
  return `${String(dl.getDate()).padStart(2,'0')}.${String(dl.getMonth()+1).padStart(2,'0')}.${dl.getFullYear()} ${String(dl.getHours()).padStart(2,'0')}:${String(dl.getMinutes()).padStart(2,'0')} Uhr`;
}
function daysUntil(ts) {
  if (!ts) return null;
  return Math.floor((new Date(ts * 1000) - NOW) / 86400000);
}

// === ZIP-BUILDER mit DEFLATE Compression ===

let _zlibDeflate = null;
try {
  const _zlib = require('zlib');
  if (_zlib && _zlib.deflateRawSync) _zlibDeflate = _zlib.deflateRawSync;
} catch (e) { /* zlib nicht verfuegbar in sandbox */ }
console.log(`Compression: ${_zlibDeflate ? 'DEFLATE' : 'STORE only'}`);


const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
let _zlib;
try { _zlib = require('zlib'); } catch (e) { _zlib = null; }

function buildZip(files) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.filename, 'utf-8');
    const data = f.data;
    const crc = crc32(data);
    const uncompSize = data.length;
    
    // Komprimierung versuchen falls zlib verfuegbar
    let compData = data;
    let method = 0; // store
    let compSize = uncompSize;
    if (_zlib && uncompSize > 0) {
      try {
        const def = _zlib.deflateRawSync(data, { level: 6 });
        if (def.length < uncompSize) {
          compData = def;
          method = 8; // deflate
          compSize = def.length;
        }
      } catch (e) { /* fallback to store */ }
    }
    
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(compSize, 18);
    lh.writeUInt32LE(uncompSize, 22); lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, compData);
    
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0x0800, 8); ce.writeUInt16LE(method, 10);
    ce.writeUInt16LE(0, 12); ce.writeUInt16LE(0x21, 14);
    ce.writeUInt32LE(crc, 16); ce.writeUInt32LE(compSize, 20);
    ce.writeUInt32LE(uncompSize, 24); ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(0, 30); ce.writeUInt16LE(0, 32);
    ce.writeUInt16LE(0, 34); ce.writeUInt16LE(0, 36);
    ce.writeUInt32LE(0, 38); ce.writeUInt32LE(offset, 42);
    centralParts.push(ce, nameBuf);
    offset += 30 + nameBuf.length + compSize;
  }
  const localPart = Buffer.concat(localParts);
  const centralPart = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// === PDF-GENERATOR (pure JS, multi-page, Helvetica) ===
// Akzeptiert Liste von Bloecken: [{type:'h1'|'h2'|'p'|'li'|'meta'|'spacer', text:'...'}]

function escapePdfStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
// Rudimentaeres Latin-1-Encoding: nicht-ASCII zu '?' wenn ausserhalb
function pdfText(s) {
  // Latin-1 (0x00-0xFF) wird direkt als Bytes durchgereicht.
  // WinAnsi-spezifische Zeichen (Smart Quotes, Bullets, Em/En-Dash) werden zu WinAnsi-Bytes gemappt.
  let out = '';
  for (const ch of String(s)) {
    const code = ch.charCodeAt(0);
    if (code < 128) { out += ch; continue; }
    if (code >= 0x00A0 && code <= 0x00FF) { out += ch; continue; }  // Latin-1 inkl. Umlaute
    // WinAnsi-spezifische Zeichen
    if (code === 0x20AC) out += '\x80';        // €
    else if (code === 0x201A) out += '\x82';   // ‚
    else if (code === 0x201E) out += '\x84';   // „
    else if (code === 0x2026) out += '\x85';   // …
    else if (code === 0x2018) out += '\x91';   // '
    else if (code === 0x2019) out += '\x92';   // '
    else if (code === 0x201C) out += '\x93';   // "
    else if (code === 0x201D) out += '\x94';   // "
    else if (code === 0x2022) out += '\x95';   // •
    else if (code === 0x2013) out += '\x96';   // –
    else if (code === 0x2014) out += '\x97';   // —
    else out += '?';
  }
  return escapePdfStr(out);
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let buf = '';
  for (const w of words) {
    if (!buf) { buf = w; continue; }
    if ((buf + ' ' + w).length > maxChars) { lines.push(buf); buf = w; }
    else buf += ' ' + w;
  }
  if (buf) lines.push(buf);
  return lines.length ? lines : [''];
}

function generatePdf(blocks) {
  // A4 Format. Helvetica WinAnsi (kann Umlaute).
  const PAGE_W = 595, PAGE_H = 842, MARGIN = 55;
  const F_BODY = 12, F_H1 = 22, F_H2 = 16, F_META = 10, F_HEADER = 24, F_HEADER_SUB = 13;
  const LH_BODY = 17, LH_H1 = 28, LH_H2 = 22, LH_META = 14;
  const C_BODY = 75, C_H1 = 30, C_H2 = 50;  // chars per line
  
  // Farben (RGB 0-1 fuer PDF)
  const COL_PRIMARY = '0.118 0.227 0.541';     // Primaer-Blau (#1e3a8a)
  const COL_ACCENT = '0.000 0.443 0.890';  // helles Blau (#0071e3)
  const COL_TEXT = '0.114 0.114 0.122';    // fast schwarz (#1d1d1f)
  const COL_GRAY = '0.522 0.522 0.541';    // grau (#86868b)
  const COL_LIGHT = '0.961 0.961 0.969';   // hellgrau (#f5f5f7)
  const COL_WHITE = '1 1 1';
  
  const pages = [];
  let curStream = '';
  let y = PAGE_H - MARGIN;
  
  function newPage() {
    if (curStream) pages.push(curStream);
    curStream = '';
    y = PAGE_H - MARGIN;
  }
  function ensureSpace(needed) {
    if (y - needed < MARGIN) newPage();
  }
  function writeText(font, size, color, x, yy, text) {
    curStream += `BT ${color} rg /${font} ${size} Tf ${x} ${yy} Td (${pdfText(text)}) Tj ET\n`;
  }
  function drawRect(x, yy, w, h, color) {
    curStream += `q ${color} rg ${x} ${yy} ${w} ${h} re f Q\n`;
  }
  function drawLine(x1, y1, x2, y2, color, width) {
    curStream += `q ${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S Q\n`;
  }
  
  for (const b of blocks) {
    if (b.type === 'header') {
      // Schoene Header-Box mit Primaer-Blau Hintergrund
      const boxH = 90;
      ensureSpace(boxH + 12);
      drawRect(MARGIN, y - boxH, PAGE_W - 2 * MARGIN, boxH, COL_PRIMARY);
      writeText('F2', F_HEADER, COL_WHITE, MARGIN + 22, y - 38, b.title);
      if (b.subtitle) writeText('F1', F_HEADER_SUB, COL_WHITE, MARGIN + 22, y - 62, b.subtitle);
      if (b.meta) writeText('F1', F_META, COL_WHITE, MARGIN + 22, y - 78, b.meta);
      y -= boxH + 18;
    } else if (b.type === 'h1') {
      ensureSpace(LH_H1 + 6);
      for (const line of wrapText(b.text, C_H1)) {
        writeText('F2', F_H1, COL_PRIMARY, MARGIN, y - F_H1, line);
        y -= LH_H1;
      }
      y -= 6;
    } else if (b.type === 'h2') {
      ensureSpace(LH_H2 + 12);
      y -= 8;
      for (const line of wrapText(b.text, C_H2)) {
        writeText('F2', F_H2, COL_ACCENT, MARGIN, y - F_H2, line);
        y -= LH_H2;
      }
      // Akzent-Linie unter h2
      drawLine(MARGIN, y + 4, MARGIN + 80, y + 4, COL_ACCENT, 1.5);
      y -= 6;
    } else if (b.type === 'p') {
      for (const line of wrapText(b.text, C_BODY)) {
        ensureSpace(LH_BODY);
        writeText('F1', F_BODY, COL_TEXT, MARGIN, y - F_BODY, line);
        y -= LH_BODY;
      }
      y -= 4;
    } else if (b.type === 'li') {
      const lines = wrapText(b.text, C_BODY - 4);
      ensureSpace(LH_BODY * lines.length);
      // Akzent-Bullet
      writeText('F2', F_BODY + 1, COL_ACCENT, MARGIN, y - F_BODY, '\u2022');
      writeText('F1', F_BODY, COL_TEXT, MARGIN + 14, y - F_BODY, lines[0]);
      y -= LH_BODY;
      for (let i = 1; i < lines.length; i++) {
        ensureSpace(LH_BODY);
        writeText('F1', F_BODY, COL_TEXT, MARGIN + 14, y - F_BODY, lines[i]);
        y -= LH_BODY;
      }
    } else if (b.type === 'numli') {
      const lines = wrapText(b.text, C_BODY - 5);
      ensureSpace(LH_BODY * lines.length);
      writeText('F2', F_BODY, COL_ACCENT, MARGIN, y - F_BODY, b.num + '.');
      writeText('F1', F_BODY, COL_TEXT, MARGIN + 18, y - F_BODY, lines[0]);
      y -= LH_BODY;
      for (let i = 1; i < lines.length; i++) {
        ensureSpace(LH_BODY);
        writeText('F1', F_BODY, COL_TEXT, MARGIN + 18, y - F_BODY, lines[i]);
        y -= LH_BODY;
      }
    } else if (b.type === 'meta') {
      ensureSpace(LH_META);
      writeText('F3', F_META, COL_GRAY, MARGIN, y - F_META, b.text);
      y -= LH_META;
    } else if (b.type === 'link') {
      // Blau unterstrichener Linktext (text)
      ensureSpace(LH_BODY);
      const txt = b.text || b.url;
      writeText('F1', F_BODY, COL_ACCENT, MARGIN, y - F_BODY, txt);
      // Unterstrich
      const approxWidth = txt.length * F_BODY * 0.55;  // grob
      drawLine(MARGIN, y - F_BODY - 2, MARGIN + approxWidth, y - F_BODY - 2, COL_ACCENT, 0.6);
      y -= LH_BODY;
    } else if (b.type === 'divider') {
      ensureSpace(20);
      y -= 8;
      drawLine(MARGIN, y, PAGE_W - MARGIN, y, COL_GRAY, 0.4);
      y -= 12;
    } else if (b.type === 'spacer') {
      y -= b.size || 10;
    } else if (b.type === 'note') {
      // Info-Box mit hellgrauem Hintergrund
      const lines = wrapText(b.text, C_BODY - 6);
      const h = lines.length * LH_BODY + 18;
      ensureSpace(h + 8);
      drawRect(MARGIN, y - h, PAGE_W - 2 * MARGIN, h, COL_LIGHT);
      let yy = y - 8;
      for (const line of lines) {
        writeText('F1', F_BODY, COL_TEXT, MARGIN + 14, yy - F_BODY, line);
        yy -= LH_BODY;
      }
      y -= h + 8;
    }
  }
  if (curStream) pages.push(curStream);
  if (pages.length === 0) pages.push('BT /F1 12 Tf 60 750 Td (Leer) Tj ET\n');
  
  // PDF-Objekte
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  
  const pageRefs = [];
  for (let i = 0; i < pages.length; i++) pageRefs.push(`${6 + i * 2} 0 R`);
  objs.push(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`);
  
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  
  for (let i = 0; i < pages.length; i++) {
    const contentNum = 7 + i * 2;
    objs.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentNum} 0 R >>`);
    const stream = pages[i];
    objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  }
  
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += String(o).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  
  return Buffer.from(pdf, 'latin1');
}

// Helper: parse Markdown-ish Text in Bloecke
function mdToBlocks(md) {
  const out = [];
  for (const line of String(md).split('\n')) {
    const t = line.trim();
    if (!t) { out.push({ type: 'spacer' }); continue; }
    if (/^---+$/.test(t)) { out.push({ type: 'divider' }); continue; }
    if (/^# /.test(t)) { out.push({ type: 'h1', text: t.replace(/^# /, '').replace(/\*\*/g, '') }); continue; }
    if (/^## /.test(t)) { out.push({ type: 'h2', text: t.replace(/^## /, '').replace(/\*\*/g, '') }); continue; }
    if (/^### /.test(t)) { out.push({ type: 'h2', text: t.replace(/^### /, '').replace(/\*\*/g, '') }); continue; }
    if (/^[\*\-] /.test(t)) { out.push({ type: 'li', text: t.replace(/^[\*\-] /, '').replace(/\*\*/g, '') }); continue; }
    const numM = t.match(/^(\d+)\. (.+)$/);
    if (numM) { out.push({ type: 'numli', num: numM[1], text: numM[2].replace(/\*\*/g, '') }); continue; }
    if (/^_.*_$/.test(t)) { out.push({ type: 'meta', text: t.replace(/^_|_$/g, '') }); continue; }
    // Markdown link [text](url) — nur Linktext im PDF zeigen, blau unterstrichen
    const linkM = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkM) { out.push({ type: 'link', text: linkM[1], url: linkM[2] }); continue; }
    // Sonst Paragraph - Markdown-Markup entfernen
    let para = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
    // Inline-Links auch im Text bereinigen: [text](url) -> text
    para = para.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    out.push({ type: 'p', text: para });
  }
  return out;
}

// === MOODLE WEB SERVICE API ===

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function getMoodleToken() {
  console.log('Hole Moodle-Token...');
  const body = `username=${encodeURIComponent(CONFIG.MOODLE_USERNAME)}&password=${encodeURIComponent(CONFIG.MOODLE_PASSWORD)}&service=moodle_mobile_app`;
  const r = await helpers.httpRequest({
    method: 'POST', url: `${BASE_URL}/login/token.php`,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body, returnFullResponse: true, json: false, ignoreHttpStatusErrors: true,
  });
  let data;
  try { data = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; }
  catch (e) { throw new Error(`Token-Endpoint kein JSON: ${String(r.body).slice(0,300)}`); }
  if (data.error) throw new Error(`Login abgelehnt: ${data.error}`);
  if (!data.token) throw new Error(`Kein Token: ${JSON.stringify(data).slice(0,300)}`);
  console.log(`✓ Token erhalten`);
  return data.token;
}

async function wsCall(token, wsfunction, params = {}) {
  await sleep(150);
  const allParams = { wstoken: token, wsfunction, moodlewsrestformat: 'json', ...params };
  function enc(obj, prefix) {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      const fk = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) {
        v.forEach((it, idx) => {
          if (typeof it === 'object' && it !== null) parts.push(enc(it, `${fk}[${idx}]`));
          else parts.push(`${encodeURIComponent(fk + '[' + idx + ']')}=${encodeURIComponent(it)}`);
        });
      } else if (typeof v === 'object' && v !== null) parts.push(enc(v, fk));
      else parts.push(`${encodeURIComponent(fk)}=${encodeURIComponent(v)}`);
    }
    return parts.join('&');
  }
  const r = await helpers.httpRequest({
    method: 'POST', url: `${BASE_URL}/webservice/rest/server.php`,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: enc(allParams), returnFullResponse: true, json: false, ignoreHttpStatusErrors: true,
  });
  let data;
  try { data = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; }
  catch (e) { throw new Error(`WS ${wsfunction}: kein JSON. ${String(r.body).slice(0,200)}`); }
  if (data && data.exception) throw new Error(`WS ${wsfunction}: ${data.errorcode || ''} ${data.message || ''}`);
  return data;
}

async function downloadFile(fileurl, token) {
  const sep = fileurl.includes('?') ? '&' : '?';
  await sleep(150);
  const r = await helpers.httpRequest({
    method: 'GET', url: `${fileurl}${sep}token=${encodeURIComponent(token)}`,
    headers: { 'User-Agent': UA }, returnFullResponse: true,
    encoding: 'arraybuffer', json: false, ignoreHttpStatusErrors: true,
  });
  if (r.statusCode !== 200) throw new Error(`Download ${r.statusCode}`);
  const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
  if (buf.length > CONFIG.PER_FILE_MAX_MB * 1024 * 1024) throw new Error(`File zu gross: ${(buf.length/1024/1024).toFixed(1)} MB`);
  return buf;
}

// === ANTHROPIC API ===

async function anthropicCall(payload) {
  const r = await helpers.httpRequest({
    method: 'POST', url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload), json: false,
    returnFullResponse: true, ignoreHttpStatusErrors: true,
  });
  if (r.statusCode >= 400) throw new Error(`Anthropic ${r.statusCode}: ${String(r.body).slice(0,200)}`);
  const data = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
  return data.content?.[0]?.text?.trim() || '';
}

// === ADAPTIVE SUMMARY STRATEGY ===

function estimatePdfPages(buffer) {
  try {
    // Zaehle echte /Type /Page Vorkommen in PDF (ignoriert /Pages, /PageNumber etc.)
    const text = buffer.toString('latin1');
    const matches = text.match(/\/Type[\s\n]*\/Page[\s\n>\/]/g);
    if (matches && matches.length > 0) return matches.length;
  } catch (e) {}
  // Fallback: Datei-Groesse
  return Math.max(1, Math.round(buffer.length / 50000));
}

function getStrategyForPdf(pages) {
  // Adaptive Output-Laenge basierend auf PDF-Seitenzahl
  if (pages <= 10) return {
    model: CONFIG.MODEL_LIGHT, maxTokens: 1500,
    goalDesc: 'eine kompakte Zusammenfassung von 1-2 Seiten',
    estCost: 0.05
  };
  if (pages <= 30) return {
    model: CONFIG.MODEL_SUMMARY, maxTokens: 4000,
    goalDesc: 'eine ausfuehrliche Zusammenfassung von 3-5 Seiten',
    estCost: 0.10
  };
  if (pages <= 60) return {
    model: CONFIG.MODEL_SUMMARY, maxTokens: 6000,
    goalDesc: 'eine sehr ausfuehrliche Zusammenfassung von 6-10 Seiten',
    estCost: 0.20
  };
  if (pages <= 100) return {
    model: CONFIG.MODEL_SUMMARY, maxTokens: 10000,
    goalDesc: 'eine umfassende Zusammenfassung von 12-18 Seiten mit allen Kapiteln',
    estCost: 0.35
  };
  return {
    model: CONFIG.MODEL_SUMMARY, maxTokens: 14000,
    goalDesc: 'eine vollstaendige Zusammenfassung von 18-25 Seiten — alle Hauptinhalte detailliert',
    estCost: 0.55
  };
}

// Globale Kostentracking
let _runCostUSD = 0;
function trackCost(model, inputBytes, outputBytes) {
  // Grobe Schaetzung: 1 Token = ~4 Zeichen
  const inTokens = Math.round(inputBytes / 4);
  const outTokens = Math.round(outputBytes / 4);
  let inRate, outRate;
  if (model.includes('haiku')) { inRate = 1; outRate = 5; }
  else if (model.includes('sonnet')) { inRate = 3; outRate = 15; }
  else if (model.includes('opus')) { inRate = 15; outRate = 75; }
  else { inRate = 3; outRate = 15; }
  const cost = (inTokens * inRate + outTokens * outRate) / 1000000;
  _runCostUSD += cost;
  return cost;
}

// Kombinierter Call: Filename-Vorschlag + Handschrift-Check + Summary
// Gibt zurueck: { isHandwritten: bool, betterFilename: string|null, summary: string }
async function analyzePdf(pdfBuffer, courseName, originalFilename, context) {
  const sysPrompt = `Du analysierst Studienunterlagen fuer eine:n Studierende:n.
Antworte NUR mit gueltigem JSON in diesem Format:
{
  "isHandwritten": true|false,
  "betterFilename": "ein-klar-beschreibender-Dateiname-ohne-Endung",
  "summary": "Markdown-formatierte Zusammenfassung (2-5 Saetze + 3-5 Bullets)"
}

Regeln:
- isHandwritten=true wenn das Dokument hauptsaechlich handschriftliche Mitschriften, Notizen oder gescannte handgeschriebene Inhalte enthaelt. Dann lass summary leer ("").
- betterFilename: kurz, klar, max 35 Zeichen (!), ohne Sonderzeichen ausser Bindestrichen, ohne ".pdf" Endung. Bevorzuge Worte wie "Skript", "Uebung", "Anleitung" mit Nummer. Beispiele: "VHDL Crashkurs", "LTspice Kurzanleitung", "UE 1 Hello World", "Pruefungsmodalitaeten". Wenn der Originalname schon gut und kurz ist, nimm den.
- summary: kompakte Markdown-Zusammenfassung. Format: kurzer Einleitungssatz, dann 3-5 Bullets mit "- " als Praefix. Keine Floskeln, keine Wiederholung des Titels.
- Antworte AUSSCHLIESSLICH mit JSON, kein Code-Fence, kein Erklaer-Text davor oder danach.`;

  const userText = `Kurs: ${courseName}\nOriginal-Dateiname: ${originalFilename}${context ? `\nKontext: ${context}` : ''}`;
  
  const raw = await anthropicCall({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: userText },
      ],
    }],
  });
  
  // JSON parsen, defensiv
  let parsed;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch (e) {
    console.error(`  JSON-Parse fail, nutze Rohtext: ${e.message}`);
    return { isHandwritten: false, betterFilename: null, summary: raw };
  }
  return {
    isHandwritten: !!parsed.isHandwritten,
    betterFilename: parsed.betterFilename ? safeFilename(parsed.betterFilename, 60) : null,
    summary: parsed.summary || '',
  };
}

async function assignmentBriefingFull(courseName, name, description, deadline, fileSummaries) {
  const filesPart = fileSummaries.length ? '\n\nVerlinkte Dateien:\n' + fileSummaries.map(fs => `- ${fs.filename}: ${fs.summary}`).join('\n') : '';
  const userMsg = `Kurs: ${courseName}\nAufgabe: ${name}\nDeadline: ${deadline || 'nicht angegeben'}\n\nAufgabenbeschreibung:\n${description}${filesPart}\n\nErstelle das ausfuehrliche Briefing.`;
  return await anthropicCall({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: [{
      type: 'text',
      text: 'Du bist ein Studien-Assistent. Schreibe ein praegnantes, hilfreiches Aufgaben-Briefing in Markdown, deutsch. Format:\n\n## Was zu tun ist\n2-3 Saetze in eigenen Worten.\n\n## Form der Abgabe\nKurz: Datei hochladen / nur Lektüre / etc.\n\n## Loesungsansatz\n1. ...\n2. ...\n3. ...\n4. (optional)\n\n## Wichtige Konzepte\n- Konzept 1\n- Konzept 2\n\n## Aufwand\n~X Stunden\n\nKeine fertigen Loesungen, nur Hinweise.',
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: userMsg }],
  });
}

async function assignmentHintShort(courseName, name, description) {
  const userMsg = `Kurs: ${courseName}\nAufgabe: ${name}\n\nBeschreibung:\n${description.slice(0, 1500)}\n\nWas ist zu tun? Genau EIN Satz, max 25 Worte.`;
  return await anthropicCall({
    model: 'claude-haiku-4-5-20251001', max_tokens: 80,
    messages: [{ role: 'user', content: userMsg }],
  });
}

// === EMAIL HTML (kompakt) ===

function deadlineBadge(ts) {
  if (!ts) return '';
  const days = daysUntil(ts);
  let color, label;
  if (days < 0) return '';
  else if (days === 0) { color = '#ff3b30'; label = 'heute'; }
  else if (days <= 3) { color = '#ff3b30'; label = `in ${days} Tag${days===1?'':'en'}`; }
  else if (days <= 7) { color = '#ff9500'; label = `in ${days} Tagen`; }
  else { color = '#34c759'; label = `in ${days} Tagen`; }
  return `<span style="display:inline-block;background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;margin-left:8px;vertical-align:middle;">${label}</span>`;
}

function buildEmailHtml(coursesData, totalAssigns, totalFiles, zipMb, hasAttachment, totalReadMin) {
  const cssLink = 'color:#0071e3;text-decoration:none;font-weight:500;';
  let parts = [];
  parts.push(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moodle Update</title></head><body style="margin:0;padding:0;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;color:#1d1d1f;font-size:14px;line-height:1.5;"><div style="max-width:640px;margin:0 auto;padding:20px 16px;">`);
  parts.push(`<div style="background:linear-gradient(135deg,#1e3a5f,#2c5282);color:#fff;border-radius:12px;padding:16px 20px;margin-bottom:18px;">
    <div style="font-size:12px;opacity:0.85;">📚 Moodle Update Update${isFirstRun ? ' · Erstlauf' : ''}</div>
    <div style="font-size:18px;font-weight:700;margin-top:2px;">${htmlEscape(DATE_DE)}</div>
    <div style="font-size:13px;opacity:0.9;margin-top:6px;">${totalAssigns} Aufgabe${totalAssigns===1?'':'n'} · ${totalFiles} Datei${totalFiles===1?'':'en'}${hasAttachment ? ' · ZIP ' + zipMb.toFixed(1) + ' MB' : ''}</div>
    ${totalReadMin > 0 ? `<div style="font-size:12px;opacity:0.8;margin-top:4px;">Geschaetzte Lesezeit gesamt: ${formatReadTime(totalReadMin)}</div>` : ''}
  </div>`);
  
  if (totalAssigns + totalFiles === 0) {
    parts.push(`<div style="text-align:center;padding:40px 20px;color:#6e6e73;">
      <div style="font-size:40px;">✅</div>
      <div style="font-size:16px;color:#1d1d1f;font-weight:600;margin-top:8px;">Alles ruhig.</div>
      <div style="margin-top:4px;">Keine neuen Materialien seit dem letzten Lauf.</div>
    </div>`);
  } else {
    // Heute/Morgen-Sektion: dringende Aufgaben prominent oben
    const allUrgent = [];
    for (const [cn, cd] of Object.entries(coursesData)) {
      for (const a of cd.assignments) {
        if (a.duedate) {
          const d = daysUntil(a.duedate);
          if (d >= 0 && d <= 2) allUrgent.push({...a, courseName: cn});
        }
      }
    }
    allUrgent.sort((a, b) => a.duedate - b.duedate);
    if (allUrgent.length) {
      parts.push(`<div style="margin:20px 0 8px;font-size:12px;font-weight:700;color:#ff3b30;letter-spacing:0.5px;text-transform:uppercase;">🔥 Bald faellig</div>`);
      for (const a of allUrgent) {
        parts.push(`<div style="background:#fff5f5;border-left:3px solid #ff3b30;border-radius:8px;padding:12px 14px;margin:6px 0;">
          <div style="font-weight:600;font-size:14px;">${htmlEscape(a.name)}${deadlineBadge(a.duedate)}</div>
          <div style="font-size:12px;color:#6e6e73;margin-top:2px;">${htmlEscape(a.courseName)} · ${formatDeadline(a.duedate)}</div>
          ${a.shortHint ? `<div style="font-size:13px;color:#1d1d1f;margin-top:8px;">${htmlEscape(a.shortHint)}</div>` : ''}
          <div style="margin-top:8px;"><a href="${htmlEscape(a.moodle_url)}" style="${cssLink}font-size:12px;">→ Moodle</a></div>
        </div>`);
      }
    }
    
    const sorted = Object.entries(coursesData)
      .filter(([, c]) => c.assignments.length || c.newFiles.length)
      .sort(([, a], [, b]) => {
        const aDates = a.assignments.filter(x => x.duedate).map(x => x.duedate);
        const bDates = b.assignments.filter(x => x.duedate).map(x => x.duedate);
        const aMin = aDates.length ? Math.min(...aDates) : Infinity;
        const bMin = bDates.length ? Math.min(...bDates) : Infinity;
        return aMin - bMin;
      });
    for (const [cname, cdata] of sorted) {
      parts.push(`<div style="margin:18px 0 8px;font-size:16px;font-weight:700;color:#1d1d1f;border-left:3px solid #0071e3;padding-left:10px;">${htmlEscape(cname)}</div>`);
      const nonUrgentAssigns = cdata.assignments.filter(a => {
        if (!a.duedate) return true;
        const d = daysUntil(a.duedate);
        return d > 2 || d < 0;
      });
      for (const a of nonUrgentAssigns) {
        const dlStr = a.duedate ? formatDeadline(a.duedate) : '';
        parts.push(`<div style="background:#f5f5f7;border-radius:10px;padding:12px 14px;margin:8px 0;">
          <div style="font-weight:600;font-size:14px;">📝 ${htmlEscape(a.name)}${deadlineBadge(a.duedate)}</div>
          ${dlStr ? `<div style="font-size:12px;color:#6e6e73;margin-top:2px;">${dlStr}</div>` : ''}
          ${a.shortHint ? `<div style="font-size:13px;color:#1d1d1f;margin-top:8px;">${htmlEscape(a.shortHint)}</div>` : ''}
          <div style="margin-top:8px;"><a href="${htmlEscape(a.moodle_url)}" style="${cssLink}font-size:12px;">→ Moodle</a></div>
        </div>`);
      }
      if (cdata.newFiles.length) {
        parts.push(`<div style="background:#f5f5f7;border-radius:10px;padding:10px 14px;margin:8px 0;">
          <div style="font-size:12px;color:#6e6e73;margin-bottom:6px;">📄 Neue Mitschriften (${cdata.newFiles.length})</div>`);
        for (const f of cdata.newFiles) {
          const tag = f.isHandwritten ? ' <span style="color:#ff9500;font-size:10px;font-weight:600;">handschrift</span>' : '';
          const readTag = f.isPdf && !f.isHandwritten ? ` · ${formatReadTime(f.readMin)}` : '';
          parts.push(`<div style="font-size:13px;margin:3px 0;">• ${htmlEscape(f.displayName)}${tag} <span style="color:#86868b;font-size:11px;">${Math.round(f.size/1024)} KB${readTag}</span></div>`);
        }
        parts.push(`</div>`);
      }
    }
    if (hasAttachment) {
      parts.push(`<div style="margin-top:20px;padding:12px 14px;background:#e8f4fd;border-radius:10px;font-size:13px;color:#1d1d1f;">
        💡 Im Anhang: ZIP mit allen Originaldateien <strong>plus</strong> KI-Zusammenfassungen als PDF. Aufgaben-Briefings auch als PDF.
      </div>`);
    }
  }
  parts.push(`<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e5ea;font-size:11px;color:#86868b;text-align:center;">
    Generiert ${String(NOW.getHours()).padStart(2,'0')}:${String(NOW.getMinutes()).padStart(2,'0')} via n8n + Moodle Web API
  </div>`);
  parts.push(`</div></body></html>`);
  return parts.join('');
}

// === HAUPTLAUF ===

let coursesData = {};
let zipFilesArr = [];
let zipBytes = 0;
const zipMaxBytes = CONFIG.ZIP_MAX_MB * 1024 * 1024;
let scanCounter = 0;
const itemLimit = isFirstRun ? CONFIG.FIRST_RUN_LIMIT : 9999;
let runError = null;

function addToZip(filename, data) {
  let unique = filename;
  let counter = 2;
  while (zipFilesArr.some(f => f.filename === unique)) {
    const m = filename.match(/^(.+?)(\.[^./]+)?$/);
    unique = `${m[1]}_${counter}${m[2] || ''}`;
    counter++;
  }
  zipFilesArr.push({ filename: unique, data });
  zipBytes += data.length;
  return unique;
}

try {
  const token = await getMoodleToken();
  console.log('Hole Site-Info...');
  const siteInfo = await wsCall(token, 'core_webservice_get_site_info');
  const userid = siteInfo.userid;
  console.log(`✓ User: ${siteInfo.fullname}`);
  
  console.log('Hole Kursliste...');
  const courses = await wsCall(token, 'core_enrol_get_users_courses', { userid });
  console.log(`✓ ${courses.length} Kurse`);
  
  let assignsByCourse = {};
  if (courses.length > 0) {
    const ad = await wsCall(token, 'mod_assign_get_assignments', { courseids: courses.map(c => c.id) });
    for (const c of (ad.courses || [])) assignsByCourse[c.id] = c.assignments || [];
  }
  
  let completionByCmid = {};
  if (CONFIG.HIDE_COMPLETED) {
    for (const course of courses) {
      try {
        const cs = await wsCall(token, 'core_completion_get_activities_completion_status', {
          courseid: course.id, userid,
        });
        for (const s of (cs.statuses || [])) if (s.state >= 1) completionByCmid[s.cmid] = s.state;
      } catch (e) { /* completion not enabled */ }
    }
    console.log(`  ${Object.keys(completionByCmid).length} Items als erledigt markiert`);
  }
  
  // Reserviere 2 MB im ZIP fuer Aufgaben-Briefings — damit grosse Mitschriften
  // die Aufgaben nicht "wegdruecken" wenn das ZIP voll wird.
  const reservedForAssignments = 2 * 1024 * 1024;
  const fileZipLimit = zipMaxBytes - reservedForAssignments;
  
  for (const course of courses) {
    if (scanCounter >= itemLimit) break;
    const cnameRaw = course.fullname;
    const cname = prettifyCourseName(cnameRaw);
    const cfolder = safeFolder(cname, 50);
    coursesData[cname] = { assignments: [], newFiles: [], allResources: [] };
    
    let sections;
    try { sections = await wsCall(token, 'core_course_get_contents', { courseid: course.id }); }
    catch (e) { console.error(`Kurs ${cname}: ${e.message}`); continue; }
    
    // Mitschriften
    for (const section of sections) {
      for (const mod of (section.modules || [])) {
        if (scanCounter >= itemLimit) break;
        if (mod.modname !== 'resource' && mod.modname !== 'folder') continue;
        if (CONFIG.HIDE_COMPLETED && completionByCmid[mod.id]) {
          console.log(`  Skip (erledigt): ${mod.name}`); continue;
        }
        for (const c of (mod.contents || [])) {
          if (scanCounter >= itemLimit) break;
          if (c.type !== 'file' || !c.fileurl) continue;
          const fkey = `${course.id}::file::${c.fileurl}`;
          if (seenFiles[fkey]) continue;
          if (zipBytes + (c.filesize || 0) > fileZipLimit) {
            console.log(`  ZIP-Resource-Limit erreicht (Aufgaben-Reserve), skip: ${c.filename}`); continue;
          }
          try {
            console.log(`  Download: ${c.filename}`);
            const buf = await downloadFile(c.fileurl, token);
            const isPdf = c.filename.toLowerCase().endsWith('.pdf');
            const origExt = c.filename.match(/\.[^.]+$/)?.[0] || '';
            
            // Default-Werte
            let displayName = c.filename;
            let baseName = c.filename.replace(/\.[^.]+$/, '');
            let isHandwritten = false;
            let summaryMd = '';
            
            // Analyse fuer PDFs (Filename + Handschrift + Summary in 1 Call)
            let estPages = 0;
            if (isPdf && CONFIG.RENAME_FILES) {
              try {
                const a = await analyzePdf(buf, cname, c.filename, mod.name);
                isHandwritten = a.isHandwritten;
                if (a.betterFilename) baseName = a.betterFilename;
                if (!isHandwritten) summaryMd = a.summary;
                estPages = a.estPages || 0;
                if (isHandwritten) console.log(`    → handschriftlich, keine Summary`);
              } catch (e) { console.error(`    Analyze fail: ${e.message}`); }
            }
            
            // === ZIP: Original ZUERST, dann Summary ===
            const finalName = safeFilename(baseName + origExt, 100);
            const origPath = `${cfolder}/${finalName}`;
            addToZip(origPath, buf);  // Original
            displayName = finalName;
            
            if (summaryMd && !isHandwritten) {
              const blocks = [
                { type: 'header', title: baseName, subtitle: cname, meta: `Original: ${c.filename}` },
                ...mdToBlocks(summaryMd),
              ];
              addToZip(`${cfolder}/${baseName} Zusammenfassung.pdf`, generatePdf(blocks));
            }
            
            coursesData[cname].newFiles.push({
              filename: c.filename, displayName, size: buf.length, isPdf, isHandwritten,
              moodle_url: mod.url || '',
            });
            seenFiles[fkey] = { ts: c.timemodified || NOW_TS };
            scanCounter++;
          } catch (e) { console.error(`  Download fail: ${e.message}`); }
        }
      }
    }
    
    // Aufgaben
    for (const a of (assignsByCourse[course.id] || [])) {
      if (scanCounter >= itemLimit) break;
      const akey = `${course.id}::assign::${a.id}`;
      // Filter: abgelaufen oder erledigt
      if (CONFIG.HIDE_OVERDUE && a.duedate && a.duedate > 0 && a.duedate < NOW_TS) {
        seenAssignments[akey] = { duedate: a.duedate, skipped: 'overdue' }; continue;
      }
      if (CONFIG.HIDE_COMPLETED && completionByCmid[a.cmid]) {
        seenAssignments[akey] = { duedate: a.duedate, skipped: 'completed' }; continue;
      }
      // Aufgabe ist offen → IMMER zeigen (mit Cache wenn bekannt)
      const cached = seenAssignments[akey];
      const isFromCache = cached && cached.briefingMd && !cached.skipped;
      
      const aSafe = safeFilename(a.name, 40);
      const aFolder = `${cfolder}/Aufgabe_${aSafe}`;
      const fileSummaries = [];
      
      for (const att of (a.introattachments || []).slice(0, 3)) {
        if (!att.fileurl) continue;
        try {
          const buf = await downloadFile(att.fileurl, token);
          if (zipBytes + buf.length > zipMaxBytes) continue;
          const isPdf = att.filename.toLowerCase().endsWith('.pdf');
          const ext = att.filename.match(/\.[^.]+$/)?.[0] || '';
          let baseName = att.filename.replace(/\.[^.]+$/, '');
          let isHandwritten = false, summaryMd = '';
          
          let estPagesAtt = 0;
          if (isPdf && CONFIG.RENAME_FILES) {
            try {
              const r = await analyzePdf(buf, cname, att.filename, `Aufgabe: ${a.name}`);
              isHandwritten = r.isHandwritten;
              if (r.betterFilename) baseName = r.betterFilename;
              if (!isHandwritten) summaryMd = r.summary;
              estPagesAtt = r.estPages || 0;
            } catch (e) { console.error(`    Anhang Analyze fail: ${e.message}`); }
          }
          
          const finalName = safeFilename(baseName + ext, 100);
          addToZip(`${aFolder}/${finalName}`, buf);  // Original
          
          if (summaryMd && !isHandwritten) {
            const blocks = [
              { type: 'header', title: baseName, subtitle: `${cname} · Aufgabe: ${a.name}`, meta: `Original: ${att.filename}` },
              ...mdToBlocks(summaryMd),
            ];
            addToZip(`${aFolder}/${baseName} Zusammenfassung.pdf`, generatePdf(blocks));
            fileSummaries.push({ filename: finalName, summary: summaryMd });
          }
        } catch (e) { console.error(`    Anhang Download fail: ${e.message}`); }
      }
      
      const description = stripHtml(a.intro).slice(0, 5000);
      const dueStr = a.duedate ? formatDeadline(a.duedate) : '';
      
      let shortHint = '';
      if (!isFromCache) {
        try { shortHint = await assignmentHintShort(cname, a.name, description); }
        catch (e) { console.error(`  Hint fail: ${e.message}`); }
      }
      
      let fullBriefing = '';
      if (isFromCache) {
        console.log(`  Briefing: ${a.name} (cached)`);
        fullBriefing = cached.briefingMd;
        shortHint = cached.shortHint || shortHint;
      } else {
        try {
          console.log(`  Briefing: ${a.name} (NEU)`);
          fullBriefing = await assignmentBriefingFull(cname, a.name, description, dueStr, fileSummaries);
        } catch (e) {
          fullBriefing = `Briefing-Generierung fehlgeschlagen: ${e.message}`;
        }
      }
      
      // Briefing als PDF mit Header-Box
      const briefingBlocks = [
        { type: 'header', title: a.name, subtitle: cname, meta: dueStr ? `Deadline: ${dueStr}` : '' },
        ...mdToBlocks(fullBriefing),
        { type: 'divider' },
        { type: 'link', text: 'In Moodle oeffnen', url: `${BASE_URL}/mod/assign/view.php?id=${a.cmid}` },
      ];
      addToZip(`${aFolder}/Briefing.pdf`, generatePdf(briefingBlocks));
      
      coursesData[cname].assignments.push({
        name: a.name,
        moodle_url: `${BASE_URL}/mod/assign/view.php?id=${a.cmid}`,
        duedate: a.duedate, shortHint,
      });
      seenAssignments[akey] = {
        duedate: a.duedate,
        briefingMd: fullBriefing,
        shortHint: shortHint,
        cachedAt: NOW_TS,
      };
      if (!isFromCache) scanCounter++;
    }
  }
} catch (e) {
  console.error(`FATAL: ${e.message}`);
  console.error(e.stack);
  runError = { message: e.message, stack: e.stack };
}

// === Output ===

const totalFiles = Object.values(coursesData).reduce((s, c) => s + c.newFiles.length, 0);
const totalAssigns = Object.values(coursesData).reduce((s, c) => s + c.assignments.length, 0);
const totalNew = totalFiles + totalAssigns;
console.log(`Total neu: ${totalNew} (${totalAssigns} Aufgaben, ${totalFiles} Dateien)`);
console.log(`Anthropic Kosten dieser Lauf: ~$${_runCostUSD.toFixed(3)} (geschaetzt)`);

if (!runError) {
  staticData.firstRun = false;
  staticData.lastRun = NOW.toISOString();
  staticData.stats = { assignments: totalAssigns, files: totalFiles };
}

let zipBuffer, zipFilename;
if (runError) {
  const errBuf = Buffer.from(`Fehler beim Lauf vom ${DATE_DE}\n\n${runError.message}\n\n${runError.stack}`, 'utf-8');
  zipFilesArr.unshift({ filename: '_FEHLER.txt', data: errBuf });
  zipBuffer = buildZip(zipFilesArr);
  const dStr = `${String(NOW.getDate()).padStart(2,'0')}.${String(NOW.getMonth()+1).padStart(2,'0')}.${NOW.getFullYear()}`;
  zipFilename = `Moodle Update FEHLER ${dStr}.zip`;
} else {
  if (zipFilesArr.length === 0) {
    zipFilesArr.push({ filename: 'README.txt', data: Buffer.from(`Lauf vom ${DATE_DE}\n\nKeine neuen Materialien.\n`, 'utf-8') });
  }
  zipBuffer = buildZip(zipFilesArr);
  const dStr = `${String(NOW.getDate()).padStart(2,'0')}.${String(NOW.getMonth()+1).padStart(2,'0')}.${NOW.getFullYear()}`;
  zipFilename = `Moodle Update ${dStr}.zip`;
}

const zipMb = zipBuffer.length / 1024 / 1024;
console.log(`ZIP: ${zipFilename} (${zipMb.toFixed(2)} MB, ${zipFilesArr.length} Files)`);

let html, subject;
if (runError) {
  subject = `⚠️ Moodle Bot Fehler — ${DATE_STR}`;
  html = `<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:680px;margin:auto;padding:20px;">
<h1 style="color:#ff3b30;">⚠️ Moodle Bot Fehler</h1>
<pre style="background:#fee;padding:14px;border-radius:8px;font-size:12px;overflow:auto;">${htmlEscape(runError.message)}</pre>
<pre style="background:#f5f5f7;padding:14px;border-radius:8px;font-size:11px;overflow:auto;">${htmlEscape(runError.stack || '')}</pre>
</body></html>`;
} else {
  const totalReadMin = Object.values(coursesData).reduce((s, c) => s + c.newFiles.reduce((a, f) => a + (f.readMin || 0), 0), 0);
  html = buildEmailHtml(coursesData, totalAssigns, totalFiles, zipMb, zipFilesArr.length > 0, totalReadMin);
  // Dringlichkeit im Subject: prüfe ob heute/morgen was fällig ist
  let urgentEmoji = '📚';
  let urgentNote = '';
  const allDeadlines = [];
  for (const c of Object.values(coursesData)) for (const a of c.assignments) if (a.duedate) allDeadlines.push(a.duedate);
  if (allDeadlines.length) {
    const minDays = Math.min(...allDeadlines.map(t => daysUntil(t)));
    if (minDays === 0) { urgentEmoji = '🔥'; urgentNote = ' HEUTE faellig!'; }
    else if (minDays === 1) { urgentEmoji = '⏰'; urgentNote = ' morgen faellig!'; }
    else if (minDays <= 3) { urgentEmoji = '⚠️'; urgentNote = ` in ${minDays} Tagen faellig`; }
  }
  subject = totalNew > 0
    ? `${urgentEmoji} Moodle: ${totalAssigns} Aufgabe${totalAssigns===1?'':'n'}, ${totalFiles} Datei${totalFiles===1?'':'en'}${urgentNote}`
    : `📚 Moodle Update: keine Updates — ${String(NOW.getDate()).padStart(2,'0')}.${String(NOW.getMonth()+1).padStart(2,'0')}.`;
}

return [{
  json: {
    subject, html, totalNew, totalFiles, totalAssigns,
    error: runError !== null,
    errorMessage: runError ? runError.message : null,
  },
  binary: {
    attachment: await helpers.prepareBinaryData(zipBuffer, zipFilename, 'application/zip'),
  },
}];