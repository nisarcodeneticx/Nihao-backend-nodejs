const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne } = require('./db');
const { badRequest, text } = require('./util');
const { progressDto } = require('./progress');

const ACCESS_MS = Number(process.env.JWT_EXPIRATION_MS || 86400000);
const REFRESH_MS = Number(process.env.JWT_REFRESH_EXPIRATION_MS || 604800000);

function secret() {
  return process.env.JWT_SECRET || process.env.APP_JWT_SECRET || 'dev-only-change-me';
}

function sign(user, expiresInMs) {
  return jwt.sign(
    { sub: user.email, uid: user.id, role: user.role },
    secret(),
    { expiresIn: Math.floor(expiresInMs / 1000) }
  );
}

function readToken(header) {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function verifyToken(token) {
  const payload = jwt.verify(token, secret());
  return payload.sub;
}

function normalizeEmail(email) {
  return email == null ? '' : String(email).trim().toLowerCase();
}

async function findByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
}

async function adminLogin(body) {
  const user = await findByEmail(body.email);
  if (!user || !bcrypt.compareSync(body.password || '', user.password_hash)) {
    throw badRequest('Invalid email or password');
  }
  if (user.status !== 'ACTIVE') throw badRequest('Account is not active');
  if (!['ADMIN', 'EDITOR'].includes(String(user.role).toUpperCase())) {
    throw badRequest('Admin access required');
  }
  await query('UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
  return {
    token: sign(user, ACCESS_MS),
    username: user.username,
    email: user.email,
    role: user.role,
    expiresIn: ACCESS_MS
  };
}

async function mobileLogin(body) {
  const user = await findByEmail(body.email);
  if (!user) throw badRequest('ای میل یا پاس ورڈ غلط ہے');
  if (user.status !== 'ACTIVE') throw badRequest('اکاؤنٹ فعال نہیں');
  if (String(user.auth_provider).toUpperCase() === 'GOOGLE' || !text(user.password_hash)) {
    throw badRequest('اس اکاؤنٹ کے لیے Google سے سائن ان کریں');
  }
  if (!bcrypt.compareSync(body.password || '', user.password_hash)) {
    throw badRequest('ای میل یا پاس ورڈ غلط ہے');
  }
  return issueMobile(user);
}

async function mobileRegister(body) {
  const email = normalizeEmail(body.email);
  const fullName = text(body.fullName).trim();
  if (!fullName) throw badRequest('نام لکھیں');
  if (!email.includes('@')) throw badRequest('Validation failed');
  if (!body.password || String(body.password).length < 6) throw badRequest('Validation failed');
  if (await findByEmail(email)) throw badRequest('یہ ای میل پہلے سے رجسٹرڈ ہے');
  const username = await uniqueUsername(email.slice(0, email.indexOf('@')));
  const now = new Date();
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO users
      (id, username, email, password_hash, full_name, role, status, auth_provider, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'STUDENT','ACTIVE','PASSWORD',$6,$6)`,
    [id, username, email, bcrypt.hashSync(body.password, 10), fullName.slice(0, 100), now]
  );
  return issueMobile(await queryOne('SELECT * FROM users WHERE id = $1', [id]));
}

async function googleLogin(body) {
  const profile = await verifyGoogle(body.idToken);
  let user = await queryOne('SELECT * FROM users WHERE google_id = $1', [profile.subject]);
  if (!user) user = await findByEmail(profile.email);
  if (!user) {
    const id = crypto.randomUUID();
    const username = await uniqueUsername(profile.email.slice(0, profile.email.indexOf('@')));
    const now = new Date();
    await query(
      `INSERT INTO users
        (id, username, email, password_hash, full_name, role, status, google_id, auth_provider, avatar_url, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'STUDENT','ACTIVE',$6,'GOOGLE',$7,$8,$8)`,
      [id, username, profile.email, bcrypt.hashSync(crypto.randomUUID(), 10), truncate(profile.name, 100), profile.subject, profile.pictureUrl, now]
    );
    user = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
  } else {
    if (user.status !== 'ACTIVE') throw badRequest('اکاؤنٹ فعال نہیں');
    if (!text(user.google_id)) {
      const provider = hasPassword(user) ? 'BOTH' : 'GOOGLE';
      await query('UPDATE users SET google_id = $2, auth_provider = $3, updated_at = NOW() WHERE id = $1', [user.id, profile.subject, provider]);
      user.google_id = profile.subject;
      user.auth_provider = provider;
    } else if (user.google_id !== profile.subject) {
      throw badRequest('یہ ای میل دوسرے اکاؤنٹ سے منسلک ہے');
    }
    const fullName = text(user.full_name) ? user.full_name : truncate(profile.name, 100);
    const avatar = text(profile.pictureUrl) ? profile.pictureUrl : user.avatar_url;
    await query('UPDATE users SET full_name = $2, avatar_url = $3, updated_at = NOW() WHERE id = $1', [user.id, fullName, avatar]);
    user.full_name = fullName;
    user.avatar_url = avatar;
  }
  return issueMobile(user);
}

async function currentSession(user) {
  const full = user.id ? await queryOne('SELECT * FROM users WHERE id = $1', [user.id]) : null;
  return toMobile(full || user, false);
}

async function issueMobile(user) {
  await query('UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
  user.last_login = new Date();
  return toMobile(user, true);
}

async function toMobile(user) {
  return {
    token: sign(user, ACCESS_MS),
    refreshToken: sign(user, REFRESH_MS),
    userId: user.id,
    username: user.username,
    email: user.email,
    fullName: text(user.full_name, user.username),
    role: user.role,
    status: user.status,
    expiresIn: ACCESS_MS,
    progress: await progressDto(user.id)
  };
}

async function uniqueUsername(seed) {
  let base = String(seed).replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
  if (base.length < 3) base = 'user' + base;
  if (base.length > 32) base = base.slice(0, 32);
  let candidate = base;
  let suffix = 0;
  while (await queryOne('SELECT 1 FROM users WHERE username = $1', [candidate])) {
    suffix += 1;
    const ending = String(suffix);
    candidate = base.slice(0, Math.min(base.length, 50 - ending.length)) + ending;
  }
  return candidate;
}

function hasPassword(user) {
  return text(user.password_hash) && String(user.auth_provider).toUpperCase() !== 'GOOGLE';
}

function truncate(value, max) {
  if (value == null) return null;
  const string = String(value);
  return string.length <= max ? string : string.slice(0, max);
}

async function verifyGoogle(idToken) {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID || '';
  if (!clientId.trim()) throw badRequest('Google Sign-In server پر ترتیب نہیں دیا گیا');
  if (!text(idToken)) throw badRequest('Google ٹوکن درست نہیں');
  try {
    const response = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    const payload = await response.json();
    if (!response.ok || payload.error || payload.error_description) throw badRequest('Google ٹوکن درست نہیں');
    if (clientId.trim() !== payload.aud) throw badRequest('Google ٹوکن درست نہیں');
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) {
      throw badRequest('Google ٹوکن درست نہیں');
    }
    if (String(payload.email_verified).toLowerCase() !== 'true') throw badRequest('Google ای میل تصدیق شدہ نہیں');
    const email = normalizeEmail(payload.email);
    if (!email.includes('@')) throw badRequest('Google اکاؤنٹ سے ای میل نہیں ملی');
    if (!text(payload.sub)) throw badRequest('Google ٹوکن درست نہیں');
    return {
      subject: payload.sub,
      email,
      name: text(payload.name, email.slice(0, email.indexOf('@'))),
      pictureUrl: payload.picture || null
    };
  } catch (error) {
    if (error.status) throw error;
    throw badRequest('Google ٹوکن تصدیق نہیں ہو سکا');
  }
}

async function requireUser(req, res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Unauthorized' });
  }
}

async function optionalUser(req, res, next) {
  try {
    req.user = await userFromRequest(req);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Unauthorized' });
  }
}

async function userFromRequest(req) {
  const token = readToken(req.headers.authorization);
  if (!token) return null;
  const payload = jwt.verify(token, secret());
  if (payload.uid) {
    return {
      id: payload.uid,
      email: payload.sub,
      username: payload.sub,
      role: payload.role || 'STUDENT',
      status: 'ACTIVE'
    };
  }
  const user = await findByEmail(payload.sub);
  if (!user || user.status !== 'ACTIVE') {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
  return user;
}

function requireAdmin(req, res, next) {
  const role = String(req.user.role || '').toUpperCase();
  if (role !== 'ADMIN' && role !== 'EDITOR') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

module.exports = {
  adminLogin, mobileLogin, mobileRegister, googleLogin, currentSession, requireUser, optionalUser, requireAdmin
};
