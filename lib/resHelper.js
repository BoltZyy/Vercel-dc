'use strict';

/* =========================================================================
 * RES HELPER — polyfill method .status().json()/.send() di atas raw
 * Node.js ServerResponse.
 *
 * Sejak NODEJS_HELPERS=0 diaktifkan (wajib, supaya request.body Vercel
 * berhenti auto-parse dan merusak verifikasi signature Discord — lihat
 * fix sebelumnya di getRawBody), SEMUA Vercel helper properties mati
 * sekaligus, TERMASUK response.status()/response.json()/response.send().
 * `res` yang diterima tiap handler sekarang murni Node.js ServerResponse
 * mentah, yang cuma punya res.writeHead()/res.write()/res.end().
 *
 * Daripada ubah RATUSAN pemanggilan res.status(x).json(y) di seluruh
 * command files, cukup panggil augmentResponse(res) SEKALI di paling
 * awal tiap /api/*.js — ini menempelkan method .status().json() ke
 * object res yang sama, meniru persis perilaku Vercel helper lama.
 * ========================================================================= */

function augmentResponse(res) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res;
  }

  res.status = function (code) {
    res.statusCode = code;
    return res;
  };

  res.json = function (obj) {
    const body = JSON.stringify(obj);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(body);
    return res;
  };

  res.send = function (body) {
    if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
      return res.json(body);
    }
    if (!res.headersSent) {
      res.setHeader('Content-Type', typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    }
    res.end(body);
    return res;
  };

  return res;
}

module.exports = { augmentResponse };
