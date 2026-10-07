function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) out[key] = compact(item);
    }
    return out;
  }
  return value;
}

function ok(first, second) {
  if (second === undefined) {
    return compact({ success: true, message: 'Success', data: first });
  }
  if (typeof first === 'string') {
    return compact({ success: true, message: first, data: second });
  }
  return compact({
    success: true,
    message: typeof second === 'string' ? second : 'Success',
    data: first
  });
}

function fail(message, error) {
  return compact({ success: false, message, error });
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function text(value, fallback = '') {
  return value == null || String(value).trim() === '' ? fallback : String(value);
}

function num(value, fallback = 0) {
  return value == null || value === '' ? fallback : Number(value);
}

function isLive(status) {
  return status != null && String(status).trim().toUpperCase() !== 'ARCHIVED';
}

function isGuestUser(user) {
  return !!user && String(user.email || '').toLowerCase() === 'student@nihao-urdu.com';
}

function blankToNull(value) {
  return value == null || String(value).trim() === '' ? null : String(value);
}

function pageOf(content, total, page, size) {
  const totalPages = size <= 0 ? 0 : Math.ceil(total / size);
  return {
    content,
    pageNumber: page,
    pageSize: size,
    totalElements: total,
    totalPages,
    last: totalPages === 0 || page >= totalPages - 1,
    first: page === 0
  };
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function badRequest(message, details) {
  return new HttpError(400, message, details);
}

function notFound(message) {
  return new HttpError(404, message);
}

module.exports = {
  compact, ok, fail, iso, text, num, isLive, isGuestUser, blankToNull, pageOf, HttpError, badRequest, notFound
};
