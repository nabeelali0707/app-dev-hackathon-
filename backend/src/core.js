'use strict';
const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}
const err = (status, code, message, details) => new ApiError(status, code, message, details);
const vErr = (fields, message) => err(400, 'VALIDATION_ERROR', message || 'Validation failed: ' + fields.join(', '), { fields });

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;
};
const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const today = () => new Date().toISOString().slice(0, 10);

// Canonical JSON (Section 5.3): sorted keys, no whitespace, non-ASCII unescaped.
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function sign(id, payload) {
  const salt = process.env.DAY1_SALT || '';
  return crypto.createHmac('sha256', Buffer.from(salt, 'utf8'))
    .update(Buffer.from(id + '|' + canonical(payload), 'utf8'))
    .digest('hex');
}

const sha256hex = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

module.exports = { ApiError, err, vErr, isId, isInt, isObj, isDate, addDays, nowIso, today, canonical, sign, sha256hex, clone };
