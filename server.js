const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// 🔒 v2 (1 พ.ย. 2569): ไม่มีรหัสสำรองแล้ว — ต้องตั้ง ADMIN_PASS ใน Vercel › Environment Variables ไม่งั้น login ไม่ได้
// ADT_PASS (ถ้าตั้ง) ใช้แทน ADMIN_PASS — เพิ่มตัวใหม่ใน Vercel ได้โดยไม่ต้องแก้/ลบตัวเดิม
const ADMIN_PASS = process.env.ADT_PASS || process.env.ADMIN_PASS || '';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';
const PROJECT = 'Alignment Doc Tracking';
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =========================================================
// PIN UTILITIES
// =========================================================
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin + 'alignment-salt-2025').digest('hex');
}
function verifyPin(pin, hash) {
  return hashPin(pin) === hash;
}

// =========================================================
// 🔒 SESSION TOKEN (v2) — ทุกคำสั่งหลังบ้านต้องมีบัตรผ่าน ไม่ใช่กั้นแค่หน้าเว็บ
// pre  = ผ่านขั้น 1 (รหัส admin) แล้ว · อายุ 10 นาที · ใช้ได้แค่เลือก email / ใส่ PIN / ตั้ง PIN ครั้งแรก
// user = ผ่าน PIN แล้ว · อายุ 12 ชม. · ใช้ได้ทุกคำสั่ง
// ลายเซ็นใช้ SESSION_SECRET (ถ้าไม่ตั้ง จะสร้างจากคีย์ลับ Google + ADMIN_PASS ที่มีใน Vercel อยู่แล้ว)
// =========================================================
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('adt-session|' + (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '') + '|' + ADMIN_PASS).digest('hex');
const PRE_TTL = 10 * 60 * 1000, USER_TTL = 12 * 60 * 60 * 1000;
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return body + '.' + sig;
}
function readToken(tok) {
  try {
    const [body, sig] = String(tok || '').split('.');
    if (!body || !sig) return null;
    const good = b64u(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
// คำสั่งที่ไม่ต้องมีบัตรผ่าน: login + หน้า Supplier (เปิดจาก QR)
const PUBLIC_ACTIONS = new Set(['login', 'getJobById', 'supplierSubmit']);
// คำสั่งที่ใช้บัตร pre ได้ (ระหว่าง login)
const PRE_ACTIONS = new Set(['getMembers', 'verifyPin', 'setPin']);

// In-memory lockout (acceptable for Vercel serverless)
const lockouts = {};
function getLockout(email) {
  if (!lockouts[email]) lockouts[email] = { attempts: 0, lockedUntil: null };
  return lockouts[email];
}
function isLocked(email) {
  const l = getLockout(email);
  if (l.lockedUntil && Date.now() < l.lockedUntil) return true;
  if (l.lockedUntil && Date.now() >= l.lockedUntil) { l.attempts = 0; l.lockedUntil = null; }
  return false;
}
function recordFailedAttempt(email) {
  const l = getLockout(email);
  l.attempts += 1;
  if (l.attempts >= 3) { l.lockedUntil = Date.now() + 15 * 60 * 1000; l.attempts = 0; }
}
function resetAttempts(email) { lockouts[email] = { attempts: 0, lockedUntil: null }; }
function getLockRemainingMinutes(email) {
  const l = getLockout(email);
  if (!l.lockedUntil) return 0;
  return Math.ceil((l.lockedUntil - Date.now()) / 60000);
}

// =========================================================
// GOOGLE SHEETS
// =========================================================
function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheet(title) {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const has = meta.data.sheets.some(s => s.properties.title === title);
  if (!has) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
  }
}

// --- JOBS ---
async function readJobs() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A2:R' });
    const rows = res.data.values || [];
    return rows.map(r => ({
      id: r[0]||'', proj: r[1]||'', ref: r[2]||'', supplier: r[3]||'',
      type: r[4]||'', deadline: r[5]||'', email: r[6]||'', note: r[7]||'',
      createdBy: r[8]||'', createdAt: r[9]||'', status: r[10]||'pending',
      receivedAt: r[11]||null, photo: r[12]||null, location: r[13]||null, submittedAt: r[14]||null,
      notify: r[15]||'', site: r[16]||'', rtoken: r[17]||''  // 🏭 v3: ผู้รับแจ้งเตือนรายงาน · สถานที่รับซอง · รหัสลิงก์ยืนยันรับซอง
    }));
  } catch (e) { console.error('readJobs error:', e.message); return []; }
}

async function appendJob(job) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
    requestBody: { values: [[job.id,job.proj,job.ref,job.supplier,job.type,job.deadline,job.email,job.note,job.createdBy,job.createdAt,job.status,job.receivedAt||'',job.photo||'',job.location||'',job.submittedAt||'',job.notify||'',job.site||'',job.rtoken||'']] }
  });
}

async function updateJob(jobId, updates) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A2:A' });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === jobId);
  if (rowIndex === -1) return false;
  const sheetRow = rowIndex + 2;
  const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Sheet1!A${sheetRow}:R${sheetRow}` });
  const row = (cur.data.values||[[]])[0]||[];
  while (row.length < 18) row.push('');
  if (updates.status)      row[10] = updates.status;
  if (updates.receivedAt)  row[11] = updates.receivedAt;
  if (updates.photo)       row[12] = updates.photo;
  if (updates.location)    row[13] = updates.location;
  if (updates.submittedAt) row[14] = updates.submittedAt;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `Sheet1!A${sheetRow}:R${sheetRow}`,
    valueInputOption: 'RAW', requestBody: { values: [row] }
  });
  return true;
}

async function ensureHeader() {
  try {
    const sheets = getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'Sheet1!A1:R1', valueInputOption: 'RAW',
      requestBody: { values: [['id','proj','ref','supplier','type','deadline','email','note','createdBy','createdAt','status','receivedAt','photo','location','submittedAt','notify','site','rtoken']] }
    });
  } catch (e) { console.error('ensureHeader error:', e.message); }
}

// --- CONFIG ---
async function readConfig() {
  try {
    await ensureSheet('Config');
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Config!A2:B' });
    const rows = res.data.values || [];
    const config = {};
    rows.forEach(r => { if (r[0]) config[r[0]] = r[1]||''; });
    return { notifyEmails: config['notifyEmails'] ? config['notifyEmails'].split(',').map(e=>e.trim()).filter(Boolean) : [] };
  } catch (e) { return { notifyEmails: [] }; }
}

async function saveConfig(config) {
  try {
    await ensureSheet('Config');
    const sheets = getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'Config!A1:B10', valueInputOption: 'RAW',
      requestBody: { values: [['key','value'],['notifyEmails',(config.notifyEmails||[]).join(',')]] }
    });
  } catch (e) { console.error('saveConfig error:', e.message); }
}

// --- MEMBERS (A=email, B=pin_hash, C=active) ---
async function ensureMembersSheet() {
  try {
    await ensureSheet('Members');
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Members!A1:C1' });
    if (!res.data.values || res.data.values[0]?.[0] !== 'email') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'Members!A1:C1', valueInputOption: 'RAW',
        requestBody: { values: [['email','pin_hash','active']] }
      });
    }
  } catch (e) { console.error('ensureMembersSheet error:', e.message); }
}

// --- LOGIN LOG (A=timestamp, B=email, C=status, D=detail, E=ip) ---
async function ensureLoginLogSheet() {
  try {
    await ensureSheet('LoginLog');
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'LoginLog!A1:E1' });
    if (!res.data.values || res.data.values[0]?.[0] !== 'timestamp') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'LoginLog!A1:E1', valueInputOption: 'RAW',
        requestBody: { values: [['timestamp', 'email', 'status', 'detail', 'ip']] }
      });
    }
  } catch (e) { console.error('ensureLoginLogSheet error:', e.message); }
}

async function writeLoginLog(email, status, detail, ip) {
  try {
    const sheets = getSheets();
    const timestamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'LoginLog!A1', valueInputOption: 'RAW',
      requestBody: { values: [[timestamp, email, status, detail, ip || '—']] }
    });
  } catch (e) { console.error('writeLoginLog error:', e.message); }
}

async function readLoginLog() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'LoginLog!A2:E' });
    const rows = res.data.values || [];
    return rows.map(r => ({
      timestamp: r[0]||'', email: r[1]||'', status: r[2]||'', detail: r[3]||'', ip: r[4]||''
    })).reverse();
  } catch (e) { console.error('readLoginLog error:', e.message); return []; }
}

async function readMembers() {
  try {
    await ensureMembersSheet();
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Members!A2:C' });
    const rows = res.data.values || [];
    return rows.map(r => ({ email: r[0]||'', pin_hash: r[1]||'', active: r[2]!=='false' })).filter(m=>m.email);
  } catch (e) { console.error('readMembers error:', e.message); return []; }
}

async function saveMember(email, pinHash) {
  await ensureMembersSheet();
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Members!A2:A' });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === email);
  if (rowIndex !== -1) {
    const sheetRow = rowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `Members!A${sheetRow}:C${sheetRow}`, valueInputOption: 'RAW',
      requestBody: { values: [[email, pinHash, 'true']] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'Members!A1', valueInputOption: 'RAW',
      requestBody: { values: [[email, pinHash, 'true']] }
    });
  }
}

async function deleteMember(email) {
  await ensureMembersSheet();
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Members!A2:A' });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === email);
  if (rowIndex === -1) return false;
  const sheetRow = rowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `Members!C${sheetRow}`, valueInputOption: 'RAW',
    requestBody: { values: [['false']] }
  });
  return true;
}

// =========================================================
// EMAIL
// =========================================================
function getTransporter() {
  return nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
}

// 🏭 v3 (22 พ.ย. 2569) แจ้งเตือนตามงาน — งานที่เปิดจากมุม Plant (เช่น WNB) ส่ง notify + site มาด้วย
//   มี notify  = แจ้งเฉพาะรายชื่อของงานนั้น (ส่วนกลางไม่ได้รับ — งาน Plant ไม่เกิน 5 ล้าน ไม่ต้องแจ้งทีมกลาง)
//   ไม่มี notify = ใช้รายชื่อในหน้าตั้งค่าเหมือนเดิม (งานส่วนกลาง / งานเก่า)
const DEFAULT_SITE = 'Singha Complex';
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function cleanEmails(v) {
  const list = String(v || '').split(/[,;\s]+/).map(x => x.trim()).filter(x => EMAIL_RE.test(x));
  return [...new Set(list)].slice(0, 5);
}
function cleanSite(v) { return String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120); }
function siteOf(job) { return job.site || DEFAULT_SITE; }
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function appUrl() { return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''); }
function receiveUrl(job) { return job.rtoken ? `${appUrl()}/receive/${encodeURIComponent(job.id)}?t=${encodeURIComponent(job.rtoken)}` : ''; }

async function sendNotify(job) {
  const own = cleanEmails(job.notify);
  const to = own.length ? own : (await readConfig()).notifyEmails;
  if (!to.length) return;
  const rl = job.status === 'pending' ? receiveUrl(job) : '';
  try {
    const t = getTransporter();
    await t.sendMail({
      from: process.env.GMAIL_USER, to: to.join(','),
      subject: `[${PROJECT}] เอกสารมาถึงแล้ว — ${job.proj}`,
      text: `มีเอกสารส่งมาถึง ${siteOf(job)}\n${rl ? '\n✅ ได้รับซองแล้ว กดยืนยันที่นี่ (Vendor จะได้รับอีเมลยืนยันอัตโนมัติ):\n' + rl + '\n' : ''}\nโครงการ: ${job.proj}\nเลขที่: ${job.ref}\nSupplier: ${job.supplier}\nประเภท: ${job.type}\nวันที่ Supplier กดส่ง: ${job.submittedAt||'—'}\nส่งเมื่อ: ${job.receivedAt}\nสร้างโดย: ${job.createdBy}\n${job.photo?'\nดูรูปซอง: '+job.photo:''}${job.location?'\nตำแหน่ง GPS: '+job.location:''}${job.note?'\nหมายเหตุ: '+job.note:''}\n\n— ${PROJECT}`
    });
  } catch(e) { console.error('Notify error:', e.message); }
}

async function sendSupplierReceived(job) {
  try {
    const t = getTransporter();
    await t.sendMail({
      from: process.env.GMAIL_USER, to: job.email,
      subject: `[Alignment Doc Tracking] ✅ ได้รับเอกสารของท่านแล้ว — ${job.proj}`, // 🏭 v3 ชื่อสถานที่ตามงาน
      html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:28px;border:1px solid #e0d0a0;border-radius:6px;background:#fffdf0;"><h2 style="color:#8B6914;font-size:16px;margin-bottom:4px;">✅ ได้รับเอกสารของท่านแล้ว</h2><p style="color:#6B5520;font-size:13px;margin-bottom:16px;">เรียน <b>${job.supplier}</b></p><p style="font-size:14px;color:#3A2E0E;margin-bottom:16px;">${job.site ? 'ฝ่ายจัดซื้อ <b>' + escHtml(job.site) + '</b>' : 'กลุ่มงานจัดซื้อกลาง <b>Singha Complex</b>'} ได้รับซองเอกสารของท่านเรียบร้อยแล้ว</p><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;"><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">โครงการ</td><td style="padding:6px 10px;">${job.proj}</td></tr><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">เลขที่</td><td style="padding:6px 10px;">${job.ref}</td></tr><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">ประเภทเอกสาร</td><td style="padding:6px 10px;">${job.type}</td></tr>${job.note?`<tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">หมายเหตุ</td><td style="padding:6px 10px;">${job.note}</td></tr>`:''}<tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">วันที่ Supplier กดส่ง</td><td style="padding:6px 10px;">${job.submittedAt||'—'}</td></tr><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">เวลารับ</td><td style="padding:6px 10px;">${job.receivedAt}</td></tr></table>${job.photo?`<p style="font-size:12px;color:#6B5520;">📷 รูปยืนยัน: <a href="${job.photo}" style="color:#C9A84C;">ดูรูป</a></p>`:''}<hr style="border:none;border-top:1px solid #e0d0a0;margin:16px 0;"><p style="font-size:11px;color:#9A7C3A;">— Alignment Doc Tracking · ${escHtml(siteOf(job))}</p></div>`
    });
  } catch(e) { console.error('Supplier notify error:', e.message); }
}

async function uploadPhoto(base64Data, jobId) {
  try {
    const result = await cloudinary.uploader.upload(base64Data, { folder: 'alignment-doc-tracking', public_id: jobId, overwrite: true });
    return result.secure_url;
  } catch (e) { console.error('Cloudinary upload error:', e.message); return null; }
}

// =========================================================
// ROUTES
// =========================================================
// =========================================================
// CPG BIDDING TRACKER INTEGRATION — read-only status API
// ให้ระบบ CPG อ่านสถานะการรับเอกสารตาม "เลขที่โครงการ" (= รหัสงาน CPG)
// อ่านอย่างเดียว ไม่แก้ไขข้อมูลใดๆ · เปลี่ยน key ได้ด้วย env CPG_API_KEY (ถ้าเปลี่ยน ต้องแก้ ADT_KEY ฝั่ง CPG ให้ตรงกัน)
// =========================================================
const CPG_API_KEY = process.env.CPG_API_KEY || 'cpg-adt-2026';
app.get('/api/cpg-status', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if ((req.query.key || '') !== CPG_API_KEY) return res.status(403).json({ ok: false, error: 'forbidden' });
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.json({ ok: true, jobs: [] });
    const jobs = await readJobs();
    const match = jobs.filter(j => String(j.ref || '').trim() === ref);
    res.json({ ok: true, jobs: match.map(j => ({ id: j.id, supplier: j.supplier, type: j.type, status: j.status, deadline: j.deadline || '', submittedAt: j.submittedAt || '', receivedAt: j.receivedAt || '' })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// =========================================================
// 🏭 v3 ลิงก์ยืนยันรับซองจากอีเมล (ไม่ต้อง login — ใช้รหัสลับรายงาน rtoken)
// GET  = แสดงหน้ายืนยันเท่านั้น (ไม่เปลี่ยนข้อมูล · กัน Outlook Safe Links / ตัวสแกนลิงก์กดแทนคน)
// POST = ยืนยันจริง → ปิดงาน + แจ้ง Vendor เหมือนกด Mark Received
// =========================================================
async function doReceive(jobId, photoUrl) {
  const receivedAt = new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'});
  const ok = await updateJob(jobId, { status:'received', receivedAt, photo:photoUrl||null });
  if (!ok) return false;
  const j = (await readJobs()).find(x => x.id === jobId);
  if (j) await Promise.all([sendNotify(j).catch(()=>{}), j.email ? sendSupplierReceived(j).catch(()=>{}) : null]);
  return true;
}
async function findByToken(jobId, tok) {
  const j = (await readJobs()).find(x => x.id === jobId);
  if (!j || !j.rtoken || !tok || !safeEqual(j.rtoken, tok)) return null;
  return j;
}
function receivePage(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(title)}</title>
<style>body{font-family:'Sarabun',system-ui,sans-serif;background:#fffdf0;color:#3A2E0E;margin:0;padding:24px}.c{max-width:480px;margin:24px auto;background:#fff;border:1px solid #e0d0a0;border-radius:10px;padding:24px}h2{color:#8B6914;font-size:18px;margin:0 0 12px}td{padding:5px 8px;font-size:14px;vertical-align:top}td:first-child{color:#8B6914;font-weight:bold;white-space:nowrap}button{width:100%;margin-top:16px;padding:14px;font-size:16px;font-weight:bold;border:0;border-radius:8px;background:#1F7A3A;color:#fff;cursor:pointer}.m{font-size:12px;color:#9A7C3A;margin-top:14px}</style></head><body><div class="c">${body}<div class="m">— ${PROJECT}</div></div></body></html>`;
}
function jobTable(j) {
  return `<table><tr><td>โครงการ</td><td>${escHtml(j.proj)}</td></tr><tr><td>เลขที่</td><td>${escHtml(j.ref)}</td></tr><tr><td>Supplier</td><td>${escHtml(j.supplier)}</td></tr><tr><td>ประเภท</td><td>${escHtml(j.type)}</td></tr><tr><td>สถานที่</td><td>${escHtml(siteOf(j))}</td></tr>${j.submittedAt ? `<tr><td>Supplier กดส่ง</td><td>${escHtml(j.submittedAt)}</td></tr>` : ''}${j.photo ? `<tr><td>รูปซอง</td><td><a href="${escHtml(j.photo)}" target="_blank" rel="noreferrer">ดูรูป</a></td></tr>` : ''}</table>`;
}
app.get('/receive/:jobId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  const j = await findByToken(req.params.jobId, req.query.t);
  if (!j) return res.status(404).send(receivePage('ไม่พบงาน', '<h2>⚠ ลิงก์ไม่ถูกต้อง</h2><p>ลิงก์นี้ใช้ไม่ได้ หรือไม่พบงานนี้ — ติดต่อจัดซื้อกลาง</p>'));
  if (j.status !== 'pending') return res.send(receivePage('ปิดงานแล้ว', `<h2>${j.status === 'received' ? '✅ รับซองไปแล้ว' : '⛔ งานนี้ถูกยกเลิกแล้ว'}</h2>${jobTable(j)}${j.receivedAt ? `<p class="m">เมื่อ ${escHtml(j.receivedAt)}</p>` : ''}`));
  res.send(receivePage('ยืนยันรับซอง', `<h2>📦 ยืนยันรับซองเอกสาร</h2>${jobTable(j)}<form method="post" action="/receive/${encodeURIComponent(j.id)}"><input type="hidden" name="t" value="${escHtml(req.query.t)}"><button type="submit">✅ ได้รับซองแล้ว — ยืนยัน</button></form><p class="m">กดแล้วระบบปิดงานนี้ และส่งอีเมลแจ้ง Supplier ว่าได้รับเอกสารแล้ว</p>`));
});
app.post('/receive/:jobId', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  const j = await findByToken(req.params.jobId, (req.body || {}).t);
  if (!j) return res.status(404).send(receivePage('ไม่พบงาน', '<h2>⚠ ลิงก์ไม่ถูกต้อง</h2>'));
  if (j.status !== 'pending') return res.send(receivePage('ปิดงานแล้ว', `<h2>${j.status === 'received' ? '✅ รับซองไปแล้ว' : '⛔ งานนี้ถูกยกเลิกแล้ว'}</h2>${jobTable(j)}`));
  const ok = await doReceive(j.id, null);
  if (!ok) return res.status(500).send(receivePage('ผิดพลาด', '<h2>⚠ บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง</h2>'));
  res.send(receivePage('รับซองแล้ว', `<h2>✅ บันทึกรับซองเรียบร้อย</h2>${jobTable(j)}<p>ระบบส่งอีเมลยืนยันถึง Supplier แล้ว${j.email ? '' : ' (งานนี้ไม่มีอีเมล Supplier)'}</p>`));
});

app.get('/sup/:jobId', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'supplier.html')); });
app.get('*', (req, res) => {
  if (req.query.sup) res.sendFile(path.join(__dirname, 'public', 'supplier.html'));
  else res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api', async (req, res) => {
  const { action } = req.body || {};

  // 🔒 ตรวจบัตรผ่านก่อนทำทุกคำสั่ง
  let session = null;
  if (!PUBLIC_ACTIONS.has(action)) {
    session = readToken(req.body.token);
    const okType = session && (session.t === 'user' || (session.t === 'pre' && PRE_ACTIONS.has(action)));
    if (!okType) return res.status(401).json({ ok: false, auth: false, error: 'กรุณาเข้าสู่ระบบใหม่' });
  }

  // Step 1: Username + Password
  if (action === 'login') {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '—';
    if (!ADMIN_PASS) return res.json({ ok: false, error: 'ระบบยังไม่ได้ตั้งรหัส ADMIN_PASS — ติดต่อผู้ดูแล' });
    if (safeEqual(username || '', ADMIN_USER) && safeEqual(password || '', ADMIN_PASS)) {
      writeLoginLog(username, 'success', 'Login ผ่าน Username/Password', ip).catch(()=>{});
      const members = await readMembers();
      // ยังไม่มีสมาชิกเลย → เข้าได้เลย (เหมือนเดิม) · มีสมาชิก → ต้องผ่าน PIN ก่อน
      if (!members.some(m => m.active)) return res.json({ ok: true, name: ADMIN_NAME, token: signToken({ t: 'user', email: '', exp: Date.now() + USER_TTL }), noMembers: true });
      return res.json({ ok: true, name: ADMIN_NAME, token: signToken({ t: 'pre', exp: Date.now() + PRE_TTL }) });
    }
    writeLoginLog(username||'(ไม่ระบุ)', 'failed', 'Username หรือ Password ผิด', ip).catch(()=>{});
    return res.json({ ok: false, error: 'Invalid credentials' });
  }

  // Step 2: Get active members for selection
  if (action === 'getMembers') {
    const members = await readMembers();
    return res.json({ ok: true, members: members.filter(m=>m.active).map(m=>({ email: m.email, hasPin: !!m.pin_hash })) });
  }

  // Step 3: Verify PIN
  if (action === 'verifyPin') {
    const { email, pin } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '—';
    if (!email || !pin) return res.json({ ok: false, error: 'ข้อมูลไม่ครบ' });
    if (isLocked(email)) {
      const mins = getLockRemainingMinutes(email);
      writeLoginLog(email, 'locked', `บัญชีถูกล็อก เหลือ ${mins} นาที`, ip).catch(()=>{});
      return res.json({ ok: false, error: `บัญชีถูกล็อก กรุณารอ ${mins} นาที`, locked: true, minutes: mins });
    }
    const members = await readMembers();
    const member = members.find(m => m.email === email && m.active);
    if (!member) return res.json({ ok: false, error: 'ไม่พบสมาชิกนี้' });
    if (!member.pin_hash) return res.json({ ok: false, error: 'ยังไม่ได้ตั้ง PIN กรุณาติดต่อ Admin', noPin: true });
    if (verifyPin(pin, member.pin_hash)) {
      resetAttempts(email);
      writeLoginLog(email, 'success', 'เข้าระบบสำเร็จ', ip).catch(()=>{});
      return res.json({ ok: true, email, token: signToken({ t: 'user', email, exp: Date.now() + USER_TTL }) });
    }
    recordFailedAttempt(email);
    const l = getLockout(email);
    if (l.lockedUntil) {
      writeLoginLog(email, 'locked', 'PIN ผิด 3 ครั้ง — ล็อกบัญชี 15 นาที', ip).catch(()=>{});
      return res.json({ ok: false, error: 'PIN ผิด 3 ครั้ง — บัญชีถูกล็อก 15 นาที', locked: true, minutes: 15 });
    }
    writeLoginLog(email, 'failed', `PIN ไม่ถูกต้อง (ครั้งที่ ${l.attempts})`, ip).catch(()=>{});
    return res.json({ ok: false, error: `PIN ไม่ถูกต้อง เหลืออีก ${3 - l.attempts} ครั้ง` });
  }

  // Set PIN (each member sets their own)
  if (action === 'setPin') {
    const { email, currentPin, newPin } = req.body;
    if (!email || !newPin || newPin.length !== 6 || !/^\d{6}$/.test(newPin)) {
      return res.json({ ok: false, error: 'PIN ต้องเป็นตัวเลข 6 หลัก' });
    }
    const members = await readMembers();
    const member = members.find(m => m.email === email && m.active);
    if (!member) return res.json({ ok: false, error: 'ไม่พบสมาชิกนี้' });
    if (member.pin_hash) {
      // 🔒 มี PIN อยู่แล้ว → ต้องเป็นเจ้าของ email ที่ login อยู่ + ใส่ PIN เดิมถูก
      if (session.t !== 'user' || session.email !== email) return res.json({ ok: false, error: 'เปลี่ยน PIN ได้เฉพาะของตัวเอง' });
      if (!currentPin || !verifyPin(currentPin, member.pin_hash)) return res.json({ ok: false, error: 'PIN เดิมไม่ถูกต้อง' });
    }
    await saveMember(email, hashPin(newPin));
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '—';
    writeLoginLog(email, 'success', member.pin_hash ? 'เปลี่ยน PIN' : 'ตั้ง PIN ครั้งแรก', ip).catch(()=>{});
    return res.json({ ok: true, token: signToken({ t: 'user', email, exp: Date.now() + USER_TTL }) });
  }

  // Admin: add / remove / reset PIN
  if (action === 'addMember') {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.json({ ok: false, error: 'Email ไม่ถูกต้อง' });
    await saveMember(email, '');
    return res.json({ ok: true });
  }

  if (action === 'removeMember') {
    const ok = await deleteMember(req.body.email);
    return res.json({ ok });
  }

  if (action === 'resetMemberPin') {
    const members = await readMembers();
    const member = members.find(m => m.email === req.body.email);
    if (!member) return res.json({ ok: false, error: 'ไม่พบสมาชิก' });
    await saveMember(req.body.email, '');
    return res.json({ ok: true });
  }

  // Jobs
  if (action === 'createJob') {
    const jobs = await readJobs();
    const now = new Date();
    const pad = n => String(n).padStart(2,'0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const jobId = `JOB-${dateStr}-${String(jobs.length+1).padStart(4,'0')}`;
    const job = { id:jobId, proj:req.body.proj, ref:req.body.ref, supplier:req.body.supplier, type:req.body.type, deadline:req.body.deadline||'', email:req.body.email||'', note:req.body.note||'', createdBy:session.email||req.body.createdBy||'Admin', createdAt:now.toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}), status:'pending', receivedAt:null, photo:null, submittedAt:null,
      notify: cleanEmails(req.body.notify).join(','), site: cleanSite(req.body.site) };
    if (job.notify) job.rtoken = crypto.randomBytes(18).toString('hex'); // 🏭 v3 ลิงก์ยืนยันรับซองในอีเมลแจ้งเตือน (ใช้ได้เฉพาะงานนี้ · ปิดงานแล้วใช้ไม่ได้)
    await appendJob(job);
    if (job.email) {
      const supplierUrl = `${process.env.APP_URL||'http://localhost:3000'}/?sup=${encodeURIComponent(jobId)}`;
      getTransporter().sendMail({ from:process.env.GMAIL_USER, to:job.email, subject:`[${PROJECT}] QR Code สำหรับส่งเอกสาร — ${job.proj}`, text:`เรียน ${job.supplier}\n\nกรุณาเปิดลิงค์นี้ตอนนำส่งเอกสาร\n${supplierUrl}\n\nรายละเอียด:\n- โครงการ: ${job.proj}\n- เลขที่: ${job.ref}\n- ประเภท: ${job.type}\n${job.deadline?'- Deadline: '+job.deadline:''}${job.note?'\n- หมายเหตุ: '+job.note:''}\n\n— ${PROJECT} · ${siteOf(job)}` }).catch(e=>console.error('Email error:',e.message));
    }
    return res.json({ ok:true, jobId });
  }

  if (action === 'getJobs') { const jobs = (await readJobs()).map(({ rtoken, ...j }) => j); return res.json({ ok:true, jobs:[...jobs].reverse() }); } // 🏭 v3 ไม่ส่งรหัสลิงก์รับซองออกหน้าเว็บ

  if (action === 'markReceived') {
    let photoUrl = null;
    if (req.body.photoBase64) photoUrl = await uploadPhoto(req.body.photoBase64, req.body.jobId+'_admin');
    const ok = await doReceive(req.body.jobId, photoUrl);
    if (!ok) return res.json({ ok:false, error:'Not found' });
    return res.json({ ok:true });
  }

  if (action === 'supplierSubmit') {
    { const jobs=await readJobs(); const j=jobs.find(x=>x.id===req.body.jobId);
      if (!j) return res.json({ ok:false, error:'Not found' });
      if (j.status !== 'pending') return res.json({ ok:false, error:'งานนี้ปิดแล้ว' }); }
    let photoUrl = null;
    if (req.body.photoBase64) photoUrl = await uploadPhoto(req.body.photoBase64, req.body.jobId);
    const submittedAt = new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'});
    const ok = await updateJob(req.body.jobId, { status:'pending', photo:photoUrl, location:req.body.location||null, submittedAt });
    if (!ok) return res.json({ ok:false, error:'Not found' });
    readJobs().then(jobs => { const j=jobs.find(x=>x.id===req.body.jobId); if(j)sendNotify(j).catch(()=>{}); });
    return res.json({ ok:true });
  }

  if (action === 'cancelJob') {
    const cancelledAt = new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'});
    const ok = await updateJob(req.body.jobId, { status:'cancelled', receivedAt:cancelledAt });
    if (!ok) return res.json({ ok:false, error:'Not found' });
    return res.json({ ok:true });
  }

  if (action === 'getJobById') {
    const jobs=await readJobs(); const j=jobs.find(x=>x.id===req.body.jobId);
    // หน้า Supplier ไม่ต้อง login → ส่งเฉพาะข้อมูลที่หน้านั้นใช้ (ไม่ส่ง email / ผู้สร้าง)
    const job = j ? { id:j.id, proj:j.proj, ref:j.ref, supplier:j.supplier, type:j.type, deadline:j.deadline, note:j.note, status:j.status, photo:j.photo, location:j.location, receivedAt:j.receivedAt, submittedAt:j.submittedAt } : null;
    return res.json({ ok:true, job });
  }

  if (action === 'getConfig') { const config=await readConfig(); return res.json({ ok:true, config:{ adminUser:ADMIN_USER, adminName:ADMIN_NAME, notifyEmails:config.notifyEmails } }); }
  if (action === 'saveConfig') { await saveConfig({ notifyEmails:req.body.config.notifyEmails||[] }); return res.json({ ok:true }); }

  if (action === 'sendQREmail') {
    // 🔒 ใช้ข้อมูลงานจากชีตเท่านั้น (ไม่รับข้อความจากหน้าเว็บ) + ส่งได้ทีละ 1 ผู้รับ
    const job = (await readJobs()).find(x=>x.id===req.body.jobId);
    if (!job) return res.json({ ok:false, error:'ไม่พบงาน' });
    const to = String(req.body.email||'').trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return res.json({ ok:false, error:'Email ไม่ถูกต้อง' });
    const supplierUrl = `${process.env.APP_URL||'http://localhost:3000'}/?sup=${encodeURIComponent(job.id)}`;
    try {
      await getTransporter().sendMail({ from:process.env.GMAIL_USER, to, subject:`[${PROJECT}] QR Code สำหรับส่งเอกสาร — ${job.proj}`, text:`เรียน ${job.supplier}\n\nกรุณาเปิดลิงค์นี้ตอนนำส่งเอกสาร\n${supplierUrl}\n\n— ${PROJECT} · ${siteOf(job)}` });
      return res.json({ ok:true });
    } catch(e) { return res.json({ ok:false, error:e.message }); }
  }

  if (action === 'getLoginLog') {
    const logs = await readLoginLog();
    return res.json({ ok: true, logs });
  }

  res.json({ ok:false, error:'Unknown action' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await ensureHeader();
  await ensureMembersSheet();
  await ensureLoginLogSheet();
});
