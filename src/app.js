const path = require('path');
const express = require('express');
const { ensureReady } = require('./db');
const { ok, fail, compact, HttpError } = require('./util');
const { adminLogin, mobileLogin, mobileRegister, googleLogin, currentSession, requireUser, optionalUser } = require('./auth');
const { completeLesson } = require('./progress');
const mobile = require('./mobile');
const admin = require('./admin');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', !origin || origin === 'null' ? (origin === 'null' ? 'null' : '*') : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization, Content-Type, Accept, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) => send(compact(body));
  next();
});
const page = path.join(__dirname, '..', 'index.html');
app.get(['/', '/index.html', '/admin', '/admin.html', '/api', '/api/', '/api/index.html', '/api/admin', '/api/admin.html'], (req, res) => {
  res.type('html').sendFile(page);
});

app.use(async (req, res, next) => {
  try {
    await ensureReady();
    next();
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try { res.json(ok(await adminLogin(req.body), 'Login successful')); } catch (error) { next(error); }
});
app.post('/api/v1/api/login', async (req, res, next) => {
  try { res.json(ok('Login successful', await mobileLogin(req.body))); } catch (error) { next(error); }
});
app.post('/api/v1/api/register', async (req, res, next) => {
  try { res.json(ok('Account created', await mobileRegister(req.body))); } catch (error) { next(error); }
});
app.post('/api/v1/api/auth/google', async (req, res, next) => {
  try { res.json(ok('Google sign-in successful', await googleLogin(req.body))); } catch (error) { next(error); }
});

app.get('/api/v1/api/me', requireUser, async (req, res, next) => {
  try { res.json(ok('Session restored', await currentSession(req.user))); } catch (error) { next(error); }
});
app.post('/api/v1/api/lessons/:lessonId/complete', requireUser, async (req, res, next) => {
  try {
    res.json(ok('Lesson completed successfully', await completeLesson(req.user.id, req.params.lessonId, req.body || {})));
  } catch (error) { next(error); }
});

app.use('/api', optionalUser, mobile);
app.use('/api', requireUser, admin);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === '23503' ? 409 : 500);
  const message = status === 409
    ? 'Could not delete this item because related records still exist. Try deleting nested content first, or restart the backend so cascade delete is active.'
    : status === 500
      ? 'An unexpected error occurred: ' + error.message
      : error.message;
  res.status(status).json(fail(message, error.details));
});

module.exports = app;
