'use strict';
const fs   = require('fs');
const path = require('path');

const SESSION_DIR = process.env.SESSION_DIR || './session';

function encodeSession(dir = SESSION_DIR) {
  try {
    if (!fs.existsSync(dir)) return null;
    const files = {};
    const walk  = (d) => {
      for (const entry of fs.readdirSync(d)) {
        const full = path.join(d, entry);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        const rel  = path.relative(dir, full);
        files[rel] = fs.readFileSync(full).toString('base64');
      }
    };
    walk(dir);
    if (!Object.keys(files).length) return null;
    return Buffer.from(JSON.stringify(files)).toString('base64');
  } catch (_) { return null; }
}

module.exports = { SESSION_DIR, encodeSession };
