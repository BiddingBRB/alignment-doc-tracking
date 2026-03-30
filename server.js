const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';
const PROJECT = 'Alignment Doc Tracking';
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadPhoto(base64Data, jobId) {
  try {
    const result = await cloudinary.uploader.upload(base64Data, { folder: 'alignment-doc-tracking', public_id: jobId, overwrite: true });
    return result.secure_url;
  } catch (e) { console.error('Cloudinary upload error:', e.message); return null; }
}

function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

// =========================================================
// DATA SHEET: คอลัมน์ A-O (เพิ่ม submittedAt = col O index 14)
// =========================================================
// A=id, B=proj, C=ref, D=supplier, E=type, F=deadline,
// G=email, H=note, I=createdBy, J=createdAt, K=status,
// L=receivedAt, M=photo, N=location, O=submittedAt

async function readJobs() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A2:O' });
    const rows = res.data.values || [];
    return rows.map(r => ({
      id: r[0]||'', proj: r[1]||'', ref: r[2]||'', supplier: r[3]||'',
      type: r[4]||'', deadline: r[5]||'', email: r[6]||'', note: r[7]||'',
      createdBy: r[8]||'', createdAt: r[9]||'', status: r[10]||'pending',
      receivedAt: r[11]||null, photo: r[12]||null, location: r[13]||null,
      submittedAt: r[14]||null
    }));
  } catch (e) { console.error('readJobs error:', e.message); return []; }
}

async function appendJob(job) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: 'Sheet1!A1', valueInputOption: 'RAW',
    requestBody: { values: [[
      job.id, job.proj, job.ref, job.supplier, job.type, job.deadline,
      job.email, job.note, job.createdBy, job.createdAt, job.status,
      job.receivedAt||'', job.photo||'', job.location||'', job.submittedAt||''
    ]] }
  });
}

async function updateJob(jobId, updates) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A2:A' });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === jobId);
  if (rowIndex === -1) return false;
  const sheetRow = rowIndex + 2;
  const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Sheet1!A${sheetRow}:O${sheetRow}` });
  const row = (cur.data.values || [[]])[0] || [];
  while (row.length < 15) row.push('');
  if (updates.status)      row[10] = updates.status;
  if (updates.receivedAt)  row[11] = updates.receivedAt;
  if (updates.photo)       row[12] = updates.photo;
  if (updates.location)    row[13] = updates.location;
  if (updates.submittedAt) row[14] = updates.submittedAt;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `Sheet1!A${sheetRow}:O${sheetRow}`,
    valueInputOption: 'RAW', requestBody: { values: [row] }
  });
  return true;
}

async function ensureHeader() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A1:O1' });
    // อัปเดต header ทุกครั้งเพื่อให้แน่ใจว่าครบทุก column รวม submittedAt
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'Sheet1!A1:O1', valueInputOption: 'RAW',
      requestBody: { values: [['id','proj','ref','supplier','type','deadline','email','note','createdBy','createdAt','status','receivedAt','photo','location','submittedAt']] }
    });
  } catch (e) { console.error('ensureHeader error:', e.message); }
}

// =========================================================
// CONFIG SHEET: เก็บ notifyEmails ถาวรใน Sheet "Config"
// =========================================================

async function readConfig() {
  try {
    const sheets = getSheets();
    // ตรวจว่ามี sheet Config หรือยัง
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const hasConfig = meta.data.sheets.some(s => s.properties.title === 'Config');
    if (!hasConfig) {
      // สร้าง sheet Config ใหม่
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Config' } } }] }
      });
      // ใส่ header
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'Config!A1:B1', valueInputOption: 'RAW',
        requestBody: { values: [['key', 'value']] }
      });
      return { notifyEmails: [] };
    }
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Config!A2:B' });
    const rows = res.data.values || [];
    const config = {};
    rows.forEach(r => { if (r[0]) config[r[0]] = r[1] || ''; });
    return {
      notifyEmails: config['notifyEmails'] ? config['notifyEmails'].split(',').map(e => e.trim()).filter(Boolean) : []
    };
  } catch (e) {
    console.error('readConfig error:', e.message);
    return { notifyEmails: [] };
  }
}

async function saveConfig(config) {
  try {
    const sheets = getSheets();
    // ตรวจว่ามี sheet Config
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const hasConfig = meta.data.sheets.some(s => s.properties.title === 'Config');
    if (!hasConfig) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Config' } } }] }
      });
    }
    // เขียน header + ข้อมูล
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'Config!A1:B10', valueInputOption: 'RAW',
      requestBody: { values: [
        ['key', 'value'],
        ['notifyEmails', (config.notifyEmails || []).join(',')]
      ] }
    });
  } catch (e) { console.error('saveConfig error:', e.message); }
}

function getTransporter() {
  return nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
}

// =========================================================
// ROUTES
// =========================================================

app.get('/sup/:jobId', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'supplier.html')); });
app.get('*', (req, res) => { if (req.query.sup) { res.sendFile(path.join(__dirname, 'public', 'supplier.html')); } else { res.sendFile(path.join(__dirname, 'public', 'index.html')); } });

app.post('/api', async (req, res) => {
  const { action } = req.body;

  if (action === 'login') {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) return res.json({ ok: true, name: ADMIN_NAME });
    return res.json({ ok: false, error: 'Invalid credentials' });
  }

  if (action === 'createJob') {
    const jobs = await readJobs();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const jobId = `JOB-${dateStr}-${String(jobs.length + 1).padStart(4, '0')}`;
    const job = {
      id: jobId, proj: req.body.proj, ref: req.body.ref, supplier: req.body.supplier,
      type: req.body.type, deadline: req.body.deadline||'', email: req.body.email||'',
      note: req.body.note||'', createdBy: req.body.createdBy||'Admin',
      createdAt: now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      status: 'pending', receivedAt: null, photo: null, submittedAt: null
    };
    await appendJob(job);

    // ✅ FIX 1: ส่ง Email แบบ non-blocking (ไม่ await) → ตอบ user ทันที
    if (job.email) {
      const supplierUrl = `${process.env.APP_URL || 'http://localhost:3000'}/?sup=${encodeURIComponent(jobId)}`;
      const t = getTransporter();
      t.sendMail({
        from: process.env.GMAIL_USER, to: job.email,
        subject: `[${PROJECT}] QR Code สำหรับส่งเอกสาร — ${job.proj}`,
        text: `เรียน ${job.supplier}\n\nกรุณาเปิดลิงค์นี้ตอนนำส่งเอกสาร แล้วถ่ายรูปซอง\n${supplierUrl}\n\nรายละเอียด:\n- โครงการ: ${job.proj}\n- เลขที่: ${job.ref}\n- ประเภท: ${job.type}\n${job.deadline ? '- Deadline: ' + job.deadline : ''}${job.note ? '\n- หมายเหตุ: ' + job.note : ''}\n\n— ${PROJECT} · Singha Complex`
      }).catch(e => console.error('Email error:', e.message)); // non-blocking
    }
    return res.json({ ok: true, jobId });
  }

  if (action === 'getJobs') {
    const jobs = await readJobs();
    return res.json({ ok: true, jobs: [...jobs].reverse() });
  }

  if (action === 'markReceived') {
    const receivedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    let photoUrl = null;
    if (req.body.photoBase64) photoUrl = await uploadPhoto(req.body.photoBase64, req.body.jobId + '_admin');
    const ok = await updateJob(req.body.jobId, { status: 'received', receivedAt, photo: photoUrl });
    if (!ok) return res.json({ ok: false, error: 'Not found' });

    // ส่ง Notify แบบ non-blocking
    readJobs().then(jobs => {
      const j = jobs.find(x => x.id === req.body.jobId);
      if (j) {
        sendNotify(j).catch(e => console.error('sendNotify error:', e.message));
        if (j.email) sendSupplierReceived(j).catch(e => console.error('sendSupplierReceived error:', e.message));
      }
    });
    return res.json({ ok: true });
  }

  if (action === 'supplierSubmit') {
    let photoUrl = null;
    if (req.body.photoBase64) photoUrl = await uploadPhoto(req.body.photoBase64, req.body.jobId);
    // ✅ บันทึก submittedAt = เวลาที่ Supplier กดส่งซอง
    const submittedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const ok = await updateJob(req.body.jobId, { status: 'pending', photo: photoUrl, location: req.body.location || null, submittedAt });
    if (!ok) return res.json({ ok: false, error: 'Not found' });

    // ส่ง Notify แบบ non-blocking
    readJobs().then(jobs => {
      const j = jobs.find(x => x.id === req.body.jobId);
      if (j) sendNotify(j).catch(e => console.error('sendNotify error:', e.message));
    });
    return res.json({ ok: true });
  }

  if (action === 'cancelJob') {
    const cancelledAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const ok = await updateJob(req.body.jobId, { status: 'cancelled', receivedAt: cancelledAt });
    if (!ok) return res.json({ ok: false, error: 'Not found' });
    return res.json({ ok: true });
  }

  if (action === 'getJobById') {
    const jobs = await readJobs();
    const j = jobs.find(x => x.id === req.body.jobId);
    return res.json({ ok: true, job: j || null });
  }

  // ✅ FIX 2: getConfig/saveConfig อ่าน-เขียนจาก Google Sheets (ไม่ใช่ in-memory)
  if (action === 'getConfig') {
    const config = await readConfig();
    return res.json({ ok: true, config: { adminUser: ADMIN_USER, adminName: ADMIN_NAME, notifyEmails: config.notifyEmails } });
  }

  if (action === 'saveConfig') {
    await saveConfig({ notifyEmails: req.body.config.notifyEmails || [] });
    return res.json({ ok: true });
  }

  if (action === 'sendQREmail') {
    const supplierUrl = `${process.env.APP_URL || 'http://localhost:3000'}/?sup=${encodeURIComponent(req.body.jobId)}`;
    try {
      const t = getTransporter();
      await t.sendMail({ from: process.env.GMAIL_USER, to: req.body.email, subject: `[${PROJECT}] QR Code สำหรับส่งเอกสาร — ${req.body.proj}`, text: `เรียน ${req.body.supplier}\n\nกรุณาเปิดลิงค์นี้ตอนนำส่งเอกสาร\n${supplierUrl}\n\n— ${PROJECT} · Singha Complex` });
      return res.json({ ok: true });
    } catch(e) { return res.json({ ok: false, error: e.message }); }
  }

  res.json({ ok: false, error: 'Unknown action' });
});

// =========================================================
// EMAIL HELPERS
// =========================================================

async function sendNotify(job) {
  const config = await readConfig();
  if (!config.notifyEmails.length) return;
  try {
    const t = getTransporter();
    await t.sendMail({
      from: process.env.GMAIL_USER, to: config.notifyEmails.join(','),
      subject: `[${PROJECT}] เอกสารมาถึงแล้ว — ${job.proj}`,
      text: `มีเอกสารส่งมาถึงตึก Singha Complex\n\nโครงการ: ${job.proj}\nเลขที่: ${job.ref}\nSupplier: ${job.supplier}\nประเภท: ${job.type}\nวันที่ Supplier กดส่ง: ${job.submittedAt||'—'}\nส่งเมื่อ: ${job.receivedAt}\nสร้างโดย: ${job.createdBy}\n${job.photo ? '\nดูรูปซอง: ' + job.photo : ''}${job.location ? '\nตำแหน่ง GPS: ' + job.location : ''}${job.note ? '\nหมายเหตุ: ' + job.note : ''}\n\n— ${PROJECT}`
    });
  } catch(e) { console.error('Notify error:', e.message); }
}

async function sendSupplierReceived(job) {
  try {
    const t = getTransporter();
    await t.sendMail({
      from: process.env.GMAIL_USER, to: job.email,
      subject: `[Alignment Doc Tracking] ✅ ได้รับเอกสารของท่านแล้ว — ${job.proj}`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:28px;border:1px solid #e0d0a0;border-radius:6px;background:#fffdf0;"><h2 style="color:#8B6914;font-size:16px;margin-bottom:4px;">✅ ได้รับเอกสารของท่านแล้ว</h2><p style="color:#6B5520;font-size:13px;margin-bottom:16px;">เรียน <b>${job.supplier}</b></p><p style="font-size:14px;color:#3A2E0E;margin-bottom:16px;">กลุ่มงานจัดซื้อกลาง <b>Singha Complex</b> ได้รับซองเอกสารของท่านเรียบร้อยแล้ว</p><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;"><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">โครงการ</td><td style="padding:6px 10px;">${job.proj}</td></tr><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">เลขที่</td><td style="padding:6px 10px;">${job.ref}</td></tr><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">ประเภทเอกสาร</td><td style="padding:6px 10px;">${job.type}</td></tr>${job.note ? `<tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">หมายเหตุ</td><td style="padding:6px 10px;">${job.note}</td></tr>` : ''}<tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">วันที่ Supplier กดส่ง</td><td style="padding:6px 10px;">${job.submittedAt||'—'}</td></tr><tr><td style="padding:6px 10px;background:#f5edcc;color:#8B6914;font-weight:bold;">เวลารับ</td><td style="padding:6px 10px;">${job.receivedAt}</td></tr></table>${job.photo ? `<p style="font-size:12px;color:#6B5520;">📷 รูปยืนยัน: <a href="${job.photo}" style="color:#C9A84C;">ดูรูป</a></p>` : ''}<hr style="border:none;border-top:1px solid #e0d0a0;margin:16px 0;"><p style="font-size:11px;color:#9A7C3A;">— Alignment Doc Tracking · Singha Complex</p></div>`
    });
  } catch(e) { console.error('Supplier notify error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await ensureHeader();
});
