/**
 * Minimal ZIP (STORE / no compression) builder for already-compressed images.
 * Works in window and service worker contexts.
 */
(function (global) {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function encodeName(name) {
    // Prefer UTF-8; ZIP general-purpose bit 11 marks UTF-8 names.
    return new TextEncoder().encode(String(name || 'file'));
  }

  function u16(n) {
    const b = new Uint8Array(2);
    b[0] = n & 0xff;
    b[1] = (n >>> 8) & 0xff;
    return b;
  }

  function u32(n) {
    const b = new Uint8Array(4);
    b[0] = n & 0xff;
    b[1] = (n >>> 8) & 0xff;
    b[2] = (n >>> 16) & 0xff;
    b[3] = (n >>> 24) & 0xff;
    return b;
  }

  function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /**
   * @param {{ name: string, data: ArrayBuffer|Uint8Array }[]} files
   * @returns {Uint8Array}
   */
  function buildZipStoreBytes(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const list = Array.isArray(files) ? files : [];

    for (const file of list) {
      const nameBytes = encodeName(file.name || 'file');
      const data =
        file.data instanceof Uint8Array
          ? file.data
          : new Uint8Array(file.data || new ArrayBuffer(0));
      const crc = crc32(data);
      const size = data.length;
      const gpFlag = 0x0800; // UTF-8

      const localHeader = concat([
        u32(0x04034b50),
        u16(20),
        u16(gpFlag),
        u16(0), // store
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
      ]);

      localParts.push(localHeader, data);

      const central = concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(gpFlag),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]);
      centralParts.push(central);
      offset += localHeader.length + data.length;
    }

    const centralDir = concat(centralParts);
    const end = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(list.length),
      u16(list.length),
      u32(centralDir.length),
      u32(offset),
      u16(0),
    ]);

    return concat([...localParts, centralDir, end]);
  }

  /**
   * @param {{ name: string, data: ArrayBuffer|Uint8Array }[]} files
   * @returns {Blob}
   */
  function buildZipStore(files) {
    return new Blob([buildZipStoreBytes(files)], { type: 'application/zip' });
  }

  function safeZipEntryName(name, used) {
    let base = String(name || 'image')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
      .replace(/^\.+/, '')
      .trim() || 'image';
    if (base.length > 80) base = base.slice(0, 80);
    let candidate = base;
    let n = 1;
    while (used.has(candidate.toLowerCase())) {
      const dot = base.lastIndexOf('.');
      if (dot > 0) {
        candidate = `${base.slice(0, dot)} (${n})${base.slice(dot)}`;
      } else {
        candidate = `${base} (${n})`;
      }
      n += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  global.HLS_ZIP_STORE = {
    buildZipStore,
    buildZipStoreBytes,
    safeZipEntryName,
  };
})(typeof self !== 'undefined' ? self : globalThis);
