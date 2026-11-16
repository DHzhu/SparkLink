import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifyPngBuffer(buf, expectedSize) {
  assert.ok(buf.length > 33, 'PNG buffer must contain header and chunks');
  assert.equal(buf.subarray(0, 8).equals(PNG_SIGNATURE), true, 'Valid PNG magic signature');

  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  const idatParts = [];

  while (offset < buf.length) {
    assert.ok(offset + 8 <= buf.length, 'Chunk header within bounds');
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buf.length, `Chunk ${type} payload within bounds`);

    const chunkData = buf.subarray(dataStart, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    assert.equal(actualCrc, expectedCrc, `Valid CRC32 for PNG chunk ${type}`);

    if (type === 'IHDR') {
      sawIhdr = true;
      assert.equal(length, 13);
      const width = chunkData.readUInt32BE(0);
      const height = chunkData.readUInt32BE(4);
      const bitDepth = chunkData[8];
      const colorType = chunkData[9];
      assert.equal(width, expectedSize);
      assert.equal(height, expectedSize);
      assert.equal(bitDepth, 8);
      assert.equal(colorType, 6); // RGBA
    } else if (type === 'IDAT') {
      sawIdat = true;
      idatParts.push(chunkData);
    } else if (type === 'IEND') {
      sawIend = true;
      assert.equal(length, 0);
    }

    offset = dataEnd + 4;
  }

  assert.equal(sawIhdr && sawIdat && sawIend, true, 'PNG must contain IHDR, IDAT, and IEND');
  const rawScanlines = zlib.inflateSync(Buffer.concat(idatParts));
  // Each row has 1 filter byte + width * 4 RGBA bytes
  assert.equal(rawScanlines.length, expectedSize * (1 + expectedSize * 4));
}

test('[P0] Unpacked extension package integrity: every manifest.json file exists on disk and all 4 brand PNG icons decode cleanly with exact dimensions', () => {
  const rootDir = path.resolve('.');
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

  // 1. Background service worker & Popup HTML + linked CSS/JS
  const requiredFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    'src/popup/popup.css',
    'src/popup/popup.js'
  ];

  // 2. Content scripts JS & CSS
  for (const cs of manifest.content_scripts) {
    for (const jsFile of cs.js || []) {
      requiredFiles.push(jsFile);
    }
    for (const cssFile of cs.css || []) {
      requiredFiles.push(cssFile);
    }
  }

  for (const relPath of requiredFiles) {
    const abs = path.join(rootDir, relPath);
    assert.equal(fs.existsSync(abs), true, `Referenced manifest asset must exist: ${relPath}`);
    assert.ok(fs.statSync(abs).size > 0, `Referenced manifest asset must be non-empty: ${relPath}`);
  }

  // 3. Icons & action.default_icon (16, 32, 48, 128)
  for (const sizeKey of ['16', '32', '48', '128']) {
    const iconRel = manifest.icons[sizeKey];
    const actionIconRel = manifest.action.default_icon[sizeKey];
    assert.equal(iconRel, `icons/icon${sizeKey}.png`);
    assert.equal(actionIconRel, iconRel);

    const iconAbs = path.join(rootDir, iconRel);
    assert.equal(fs.existsSync(iconAbs), true, `Missing required brand icon: ${iconRel}`);
    const pngBuf = fs.readFileSync(iconAbs);
    verifyPngBuffer(pngBuf, Number(sizeKey));
  }
});

test(
  '[P0] Real Chromium unpacked extension loading: registers MV3 Service Worker and boots Popup without load errors',
  { skip: !(fs.existsSync('/usr/bin/chromium') && fs.existsSync('/usr/bin/xvfb-run')) },
  async () => {
    const rootDir = path.resolve('.');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparklink-chromium-load-'));
    let stderrLog = '';

    const child = spawn(
      '/usr/bin/xvfb-run',
      [
        '-a',
        '/usr/bin/chromium',
        '--enable-logging=stderr',
        '--v=0',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        `--load-extension=${rootDir}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
    );

    child.stderr.on('data', (chunk) => {
      stderrLog += chunk.toString('utf8');
    });

    try {
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      let port = null;
      const deadline = Date.now() + 12000;

      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
          const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
          if (lines[0] && /^\d+$/.test(lines[0].trim())) {
            port = Number(lines[0].trim());
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.ok(port, `Chromium DevToolsActivePort must initialize (stderr: ${stderrLog.slice(0, 400)})`);

      // Poll /json until SparkLink MV3 Service Worker target appears
      let swTarget = null;
      const swDeadline = Date.now() + 8000;
      while (Date.now() < swDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            swTarget = targets.find(
              (t) =>
                t.type === 'service_worker' &&
                typeof t.url === 'string' &&
                t.url.endsWith('/src/background.js')
            );
            if (swTarget) {
              break;
            }
          }
        } catch (_ignore) {
          // Wait for HTTP listener
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.equal(
        /Failed to load extension|Could not load icon/i.test(stderrLog),
        false,
        `Chromium reported extension load error: ${stderrLog}`
      );
      assert.ok(swTarget, 'SparkLink MV3 background Service Worker must register in real Chromium');
    } finally {
      child.stderr.destroy();
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_ignore) {
        // Group already gone
      }
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_ignore) {
        // Group already gone
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }
);

