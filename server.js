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

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Upload base64 image to Cloudinary
async function uploadPhoto(base64Data, jobId) {
  try {
    const result = await cloudinary.uploader.upload(base64Data, {
      folder: 'alignment-doc-tracking',
      public_id: jobId,
      overwrite: true,
    });
    return result.secure_url;
  } catch (e) {
    console.error('Cloudinary upload error:', e.message);
    return null;
  }
}

// Google Sheets auth
function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Read all jobs from sheet
async function readJobs() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A2:N',
    });
    const rows = res.data.values || [];
    return rows.map(r => ({
      id:         r[0]  || '',
      proj:       r[1]  || '',
      ref:        r[2]  || '',
      supplier:   r[3]  || '',
      type:       r[4]  || '',
      deadline:   r[5]  || '',
      email:      r[6]  || '',
      note:       r[7]  || '',
      createdBy:  r[8]  || '',
      createdAt:  r[9]  || '',
      status:     r[10] || 'pending',
      receivedAt: r[11] || null,
      photo:      r[12] || null,
      location:   r[13] || null,
    }));
  } catch (e) {
    console.error('readJobs error:', e.message);
    return [];
  }
}

// Write a new job row
async function appendJob(job) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        job.id, job.proj, job.ref, job.supplier, job.type,
        job.deadline, job.email, job.note, job.createdBy,
        job.createdAt, job.status, job.receivedAt || '', job.photo || '', job.location || ''
      ]]
    }
  });
}

// Update a job row by jobId
async function updateJob(jobId, updates) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A2:A',
  });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === jobId);
  if (rowIndex === -1) return false;
  const sheetRow = rowIndex + 2;

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!A${sheetRow}:N${sheetRow}`,
  });
  const row = (cur.data.values || [[]])[0] || [];
  while (row.length < 14) row.push('');

  if (updates.status)     row[10] = updates.status;
  if (updates.receivedAt) row[11] = updates.receivedAt;
  if (updates.photo)      row[12] = updates.photo;
  if (updates.location)   row[13] = updates.location;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!A${sheetRow}:N${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
  return true;
}

// Ensure header row exists
async function ensureHeader() {
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1:N1',
    });
    if (!res.data.values || !res.data.values[0] || res.data.values[0][0] !== 'id') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A1:N1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [['id','proj','ref','supplier','type','deadline','email','note','createdBy','createdAt','status','receivedAt','photo','location']]
        }
      });
    }
  } catch (e) {
    console.error('ensureHeader error:', e.message);
  }
}

// Email transporter
function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

let notifyEmails = process.env.NOTIFY_EMAILS ? process.env.NOTIFY_EMAILS.split(',') : [];

// Routes
app.get('/sup/:jobId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'supplier.html'));
});

app.get('*', (req, res) => {
  if (req.query.sup) {
    res.sendFile(path.join(__dirname, 'public', 'supplier.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.post('/api', async (req, res) => {
  const { action } = req.body;

  if (action === 'login') {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      return res.json({ ok: true, name: ADMIN_NAME });
    }
    return res.json({ ok: false, error: 'Invalid credentials' });
  }

  if (action === 'createJob') {
    const jobs = await readJobs();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const jobId = `JOB-${dateStr}-${String(jobs.length + 1).padStart(4, '0')}`;
    const job = {
      id: jobId,
      proj: req.body.proj,
      ref: req.body.ref,
      supplier: req.body.supplier,
      type: req.body.type,
      deadline: req.body.deadline || '',
      email: req.body.email || '',
      note: req.body.note || '',
      createdBy: req.body.createdBy || 'Admin',
      createdAt: now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      status: 'pending',
      receivedAt: null,
      photo: null
    };
    await appendJob(job);

    if (job.email) {
      const supplierUrl = `${process.env.APP_URL || 'http://localhost:3000'}/?sup=${encodeURIComponent(jobId)}`;
      try {
        const t = getTransporter();
        await t.sendMail({
          from: process.env.GMAIL_USER,
          to: job.email,
          subject: `[${PROJECT}] QR Code สำหรับส่งเอกสาร — ${job.proj}`,
          text: `เรียน ${job.supplier}\n\nกรุณาเปิดลิงค์นี้ตอนนำส่งเอกสาร แล้วถ่ายรูปซอง\n${supplierUrl}\n\nรายละเอียด:\n- โครงการ: ${job.proj}\n- เลขที่: ${job.ref}\n- ประเภท: ${job.type}\n${job.deadline ? '- Deadline: ' + job.deadline : ''}\n\n— ${PROJECT} · Singha Complex`
        });
      } catch(e) { console.error('Email error:', e.message); }
    }
    return res.json({ ok: true, jobId });
  }

  if (action === 'getJobs') {
    const jobs = await readJobs();
    return res.json({ ok: true, jobs: [...jobs].reverse() });
  }

  if (action === 'markReceived') {
    const receivedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const ok = await updateJob(req.body.jobId, { status: 'received', receivedAt });
    if (!ok) return res.json({ ok: false, error: 'Not found' });
    const jobs = await readJobs();
    const j = jobs.find(x => x.id === req.body.jobId);
    if (j) await sendNotify(j);
    return res.json({ ok: true });
  }

  if (action === 'supplierSubmit') {
    const receivedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    let photoUrl = null;

    if (req.body.photoBase64) {
      photoUrl = await uploadPhoto(req.body.photoBase64, req.body.jobId);
    }

    const ok = await updateJob(req.body.jobId, {
      status: 'received',
      receivedAt,
      photo: photoUrl,
      location: req.body.location || null
    });
    if (!ok) return res.json({ ok: false, error: 'Not found' });
    const jobs = await readJobs();
    const j = jobs.find(x => x.id === req.body.jobId);
    if (j) await sendNotify(j);
    return res.json({ ok: true });
  }

  if (action === 'cancelJob') {
    const cancelledAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const ok = await updateJob(req.body.jobId, {
      status: 'cancelled',
      receivedAt: cancelledAt,
    });
    if (!ok) return res.json({ ok: false, error: 'Not found' });
    return res.json({ ok: true });
  }

  if (action === 'getJobById') {
    const jobs = await readJobs();
    const j = jobs.find(x => x.id === req.body.jobId);
    return res.json({ ok: true, job: j || null });
  }

  if (action === 'getConfig') {
    return res.json({ ok: true, config: { adminUser: ADMIN_USER, adminName: ADMIN_NAME, notifyEmails } });
  }

  if (action === 'saveConfig') {
    notifyEmails = req.body.config.notifyEmails || [];
    return res.json({ ok: true });
  }

  if (action === 'sendQREmail') {
    const supplierUrl = `${process.env.APP_URL || 'http://localhost:3000'}/?sup=${encodeURIComponent(req.body.jobId)}`;
    try {
      const t = getTransporter();
      await t.sendMail({
        from: process.env.GMAIL_USER,
        to: req.body.email,
        subject: `[${PROJECT}] QR Code สำหรับส่งเอกสาร — ${req.body.proj}`,
        text: `เรียน ${req.body.supplier}\n\nกรุณาเปิดลิงค์นี้ตอนนำส่งเอกสาร\n${supplierUrl}\n\n— ${PROJECT} · Singha Complex`
      });
      return res.json({ ok: true });
    } catch(e) {
      return res.json({ ok: false, error: e.message });
    }
  }

  res.json({ ok: false, error: 'Unknown action' });
});

async function sendNotify(job) {
  if (!notifyEmails.length) return;
  try {
    const t = getTransporter();
    await t.sendMail({
      from: process.env.GMAIL_USER,
      to: notifyEmails.join(','),
      subject: `[${PROJECT}] เอกสารมาถึงแล้ว — ${job.proj}`,
      text: `มีเอกสารส่งมาถึงตึก Singha Complex\n\nโครงการ: ${job.proj}\nเลขที่: ${job.ref}\nSupplier: ${job.supplier}\nประเภท: ${job.type}\nส่งเมื่อ: ${job.receivedAt}\nสร้างโดย: ${job.createdBy}\n${job.photo ? '\nดูรูปซอง: ' + job.photo : ''}\n\n— ${PROJECT}`
    });
  } catch(e) { console.error('Notify error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await ensureHeader();
});
