const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// In-memory storage
let jobs = [];
let notifyEmails = process.env.NOTIFY_EMAILS ? process.env.NOTIFY_EMAILS.split(',') : [];
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';
const PROJECT = 'Alignment Doc Tracking';

// Email transporter
function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });app.get('/sup/:jobId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'supplier.html'));
});
}

// Routes
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
      createdAt: now.toLocaleString('th-TH'),
      status: 'pending',
      receivedAt: null,
      photo: null
    };
    jobs.push(job);

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
    return res.json({ ok: true, jobs: [...jobs].reverse() });
  }

  if (action === 'markReceived') {
    const j = jobs.find(x => x.id === req.body.jobId);
    if (!j) return res.json({ ok: false, error: 'Not found' });
    j.status = 'received';
    j.receivedAt = new Date().toLocaleString('th-TH');
    await sendNotify(j);
    return res.json({ ok: true });
  }

  if (action === 'supplierSubmit') {
    const j = jobs.find(x => x.id === req.body.jobId);
    if (!j) return res.json({ ok: false, error: 'Not found' });
    j.status = 'received';
    j.receivedAt = new Date().toLocaleString('th-TH');
    j.photo = req.body.photoBase64 || null;
    await sendNotify(j);
    return res.json({ ok: true });
  }

  if (action === 'getJobById') {
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
      text: `มีเอกสารส่งมาถึงตึก Singha Complex\n\nโครงการ: ${job.proj}\nเลขที่: ${job.ref}\nSupplier: ${job.supplier}\nประเภท: ${job.type}\nรับเมื่อ: ${job.receivedAt}\nสร้างโดย: ${job.createdBy}\n\n— ${PROJECT}`
    });
  } catch(e) { console.error('Notify error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
