#!/usr/bin/env node
/**
 * ClawGod Bun section extractor
 *
 * Parses the .bun (PE/ELF) or __BUN,__bun (Mach-O) section embedded in a
 * Bun standalone executable, walks the module graph, and extracts:
 *   - the entry-point module      → <out>/cli.original.js
 *   - every loader=napi module    → <out>/vendor/<name>/<arch>-<os>/<name>.node
 *
 * Everything else is dropped (e.g. auto-generated *.js napi shims aren't
 * needed because cli.js already inlines the require('/$bunfs/root/X.node')
 * calls that post-process.mjs rewrites to the vendor lookup).
 *
 * Adapted from /home/kaiju/code/python/parse-bun/main.js (which itself
 * implements the format documented in docs/bun-section-format.md). Lazy
 * Bun.file reads were replaced with readFileSync so the script runs under
 * the existing `node` invocation in install.sh / install.ps1.
 *
 * Usage:
 *   node extract-natives.mjs <binary-path> <output-dir>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Format constants ────────────────────────────────────────────────

const TRAILER             = Buffer.from('\n---- Bun! ----\n');
const BUN_SECTION_NAME    = '.bun';
const OFFSET_STRUCT_SIZE  = 32;
const MODULE_RECORD_SIZE  = 52;

// loader id → name (subset; only `napi` is acted on, rest informational)
const LOADERS = {
  0:'jsx', 1:'js', 2:'ts', 3:'tsx', 4:'css', 5:'file', 6:'json', 7:'jsonc',
  8:'toml', 9:'wasm', 10:'napi', 11:'base64', 12:'dataurl', 13:'text',
  14:'bunsh', 15:'sqlite', 16:'sqlite_embedded', 17:'html', 18:'yaml',
  19:'json5', 20:'md',
};

// ELF
const ELF_MAGIC_LE          = 0x464c457f; // "\x7fELF" LE u32
const ELF_EI_CLASS          = 0x04;
const ELF_EI_DATA           = 0x05;
const ELF_CLASS_64          = 0x02;
const ELF_DATA_LE           = 0x01;
const ELF_E_MACHINE         = 0x12;       // u16
const ELF_EHDR_SIZE         = 0x40;
const ELF64_E_SHOFF         = 0x28;
const ELF64_E_SHENTSIZE     = 0x3a;
const ELF64_E_SHNUM         = 0x3c;
const ELF64_E_SHSTRNDX      = 0x3e;
const ELF64_SH_NAME         = 0x00;
const ELF64_SH_OFFSET       = 0x18;
const ELF64_SH_SIZE         = 0x20;
const EM_X86_64             = 0x3e;
const EM_AARCH64            = 0xb7;

// Mach-O (thin LE 64-bit; fat / 32-bit / BE rejected with clear message)
const MH_MAGIC_64           = 0xfeedfacf;
const MH_CIGAM_64           = 0xcffaedfe;
const MH_MAGIC              = 0xfeedface;
const MH_CIGAM              = 0xcefaedfe;
const MACH_CPUTYPE_OFF      = 0x04;        // u32
const MACH_NCMDS_OFF        = 0x10;
const MACH_SIZEOFCMDS_OFF   = 0x14;
const MACH_HDR_SIZE_64      = 0x20;
const LC_SEGMENT_64         = 0x19;
const LC_CMDSIZE_OFF        = 0x04;
const LC_SEGNAME_OFF        = 0x08;
const LC_SEGNAME_LEN        = 0x10;
const SEG64_NSECTS_OFF      = 0x40;
const SEG64_SECTS_OFF       = 0x48;
const SECT64_ENTRY_SIZE     = 0x50;
const SECT64_SIZE_OFF       = 0x28;
const SECT64_OFFSET_OFF     = 0x30;
const CPU_TYPE_X86_64       = 0x01000007;
const CPU_TYPE_ARM64        = 0x0100000c;

// PE
const PE_OFFSET_PTR         = 0x3c;
const PE_MACHINE_OFF        = 0x04;       // relative to PE sig
const PE_NUM_SECTIONS_OFF   = 0x06;
const PE_OPT_HDR_SIZE_OFF   = 0x14;
const PE_COFF_HDR_SIZE      = 0x18;
const PE_OPT_MAGIC_OFF      = 0x18;
const PE_OPT_MAGIC_PE32P    = 0x20b;
const PE_SECTION_ENTRY_SIZE = 0x28;
const PE_SECT_RAW_SIZE_OFF  = 0x10;
const PE_SECT_RAW_OFF_OFF   = 0x14;
const PE_SECT_NAME_LEN      = 0x08;
const IMAGE_MACHINE_AMD64   = 0x8664;
const IMAGE_MACHINE_ARM64   = 0xaa64;

// ─── Helpers ─────────────────────────────────────────────────────────

function die(msg) { throw new Error(`error: ${msg}`); }

function readU64LE(buf, off, what) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) die(`${what} exceeds JS safe integer: ${v}`);
  return Number(v);
}

function checkedSlice(buf, off, size, what) {
  if (off < 0 || size < 0 || off + size > buf.length) {
    die(`${what} out of bounds: offset=${off} size=${size} buf=${buf.length}`);
  }
  return buf.subarray(off, off + size);
}

function decodeName(buf) {
  return buf.toString('utf8').replace(/\u0000+$/u, '');
}

// ─── Section locators (per format) ───────────────────────────────────

function findSectionElf(buf) {
  if (buf.length < ELF_EHDR_SIZE) die('ELF too small');
  if (buf[ELF_EI_CLASS] !== ELF_CLASS_64) die('ELF: only 64-bit supported');
  if (buf[ELF_EI_DATA]  !== ELF_DATA_LE) die('ELF: only little-endian supported');

  const eMachine = buf.readUInt16LE(ELF_E_MACHINE);
  const arch = eMachine === EM_X86_64  ? 'x64'
             : eMachine === EM_AARCH64 ? 'arm64'
             : die(`ELF: unsupported e_machine 0x${eMachine.toString(16)}`);

  const shoff     = readU64LE(buf, ELF64_E_SHOFF, 'ELF e_shoff');
  const shentsize = buf.readUInt16LE(ELF64_E_SHENTSIZE);
  const shnum     = buf.readUInt16LE(ELF64_E_SHNUM);
  const shstrndx  = buf.readUInt16LE(ELF64_E_SHSTRNDX);
  if (shstrndx >= shnum) die('ELF e_shstrndx out of range');

  const shstrEntry  = buf.subarray(shoff + shstrndx * shentsize, shoff + (shstrndx + 1) * shentsize);
  const shstrOffset = readU64LE(shstrEntry, ELF64_SH_OFFSET, 'shstrtab offset');
  const shstrSize   = readU64LE(shstrEntry, ELF64_SH_SIZE,   'shstrtab size');
  const shstr       = checkedSlice(buf, shstrOffset, shstrSize, 'shstrtab');

  let match = null;
  for (let i = 0; i < shnum; i++) {
    const entry   = buf.subarray(shoff + i * shentsize, shoff + (i + 1) * shentsize);
    const nameIdx = entry.readUInt32LE(ELF64_SH_NAME);
    if (nameIdx >= shstr.length) continue;
    let nameEnd = nameIdx;
    while (nameEnd < shstr.length && shstr[nameEnd] !== 0) nameEnd++;
    if (shstr.toString('ascii', nameIdx, nameEnd) !== BUN_SECTION_NAME) continue;
    if (match) die('ELF has multiple .bun sections');
    const rawOffset = readU64LE(entry, ELF64_SH_OFFSET, '.bun sh_offset');
    const rawSize   = readU64LE(entry, ELF64_SH_SIZE,   '.bun sh_size');
    if (rawOffset + rawSize > buf.length) die('.bun out of file bounds');
    match = { format: 'ELF', os: 'linux', arch, rawOffset, rawSize };
  }
  if (!match) die('ELF has no .bun section');
  return match;
}

function findSectionMacho(buf) {
  if (buf.length < MACH_HDR_SIZE_64) die('Mach-O too small');
  const cputype = buf.readUInt32LE(MACH_CPUTYPE_OFF);
  const arch = cputype === CPU_TYPE_X86_64 ? 'x64'
             : cputype === CPU_TYPE_ARM64  ? 'arm64'
             : die(`Mach-O: unsupported cputype 0x${cputype.toString(16)}`);

  const ncmds      = buf.readUInt32LE(MACH_NCMDS_OFF);
  const sizeofcmds = buf.readUInt32LE(MACH_SIZEOFCMDS_OFF);
  if (sizeofcmds === 0 || MACH_HDR_SIZE_64 + sizeofcmds > buf.length) die('Mach-O sizeofcmds invalid');
  const cmds = buf.subarray(MACH_HDR_SIZE_64, MACH_HDR_SIZE_64 + sizeofcmds);

  let match = null;
  let off = 0;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > sizeofcmds) die(`Mach-O LC ${i} truncated`);
    const cmd     = cmds.readUInt32LE(off);
    const cmdsize = cmds.readUInt32LE(off + LC_CMDSIZE_OFF);
    if (cmdsize < 8 || off + cmdsize > sizeofcmds) die(`Mach-O LC ${i} cmdsize invalid: ${cmdsize}`);
    if (cmd === LC_SEGMENT_64) {
      const segname = cmds.toString('ascii', off + LC_SEGNAME_OFF, off + LC_SEGNAME_OFF + LC_SEGNAME_LEN).replace(/\0+$/, '');
      if (segname === '__BUN') {
        const nsects = cmds.readUInt32LE(off + SEG64_NSECTS_OFF);
        if (SEG64_SECTS_OFF + nsects * SECT64_ENTRY_SIZE > cmdsize) die(`Mach-O LC_SEGMENT_64(__BUN) sections exceed cmdsize`);
        for (let j = 0; j < nsects; j++) {
          const s = off + SEG64_SECTS_OFF + j * SECT64_ENTRY_SIZE;
          const sectname = cmds.toString('ascii', s, s + LC_SEGNAME_LEN).replace(/\0+$/, '');
          if (sectname === '__bun') {
            const rawSize   = readU64LE(cmds, s + SECT64_SIZE_OFF, '__bun size');
            const rawOffset = cmds.readUInt32LE(s + SECT64_OFFSET_OFF);
            if (rawOffset + rawSize > buf.length) die('__bun out of file bounds');
            if (match) die('Mach-O has multiple __BUN,__bun sections');
            match = { format: 'Mach-O', os: 'darwin', arch, rawOffset, rawSize };
          }
        }
      }
    }
    off += cmdsize;
  }
  if (!match) die('Mach-O has no __BUN,__bun section');
  return match;
}

function findSectionPe(buf) {
  if (buf.length < 0x40) die('PE too small');
  if (buf.toString('ascii', 0, 2) !== 'MZ') die('PE missing MZ header');
  const peOff = buf.readUInt32LE(PE_OFFSET_PTR);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') die('PE missing PE signature');

  const machine = buf.readUInt16LE(peOff + PE_MACHINE_OFF);
  const arch = machine === IMAGE_MACHINE_AMD64 ? 'x64'
             : machine === IMAGE_MACHINE_ARM64 ? 'arm64'
             : die(`PE: unsupported machine 0x${machine.toString(16)}`);

  const optMagic = buf.readUInt16LE(peOff + PE_OPT_MAGIC_OFF);
  if (optMagic !== PE_OPT_MAGIC_PE32P) die(`PE: only 64-bit (PE32+) supported, got 0x${optMagic.toString(16)}`);

  const numSect    = buf.readUInt16LE(peOff + PE_NUM_SECTIONS_OFF);
  const optHdrSize = buf.readUInt16LE(peOff + PE_OPT_HDR_SIZE_OFF);
  const sectTable  = peOff + PE_COFF_HDR_SIZE + optHdrSize;

  let match = null;
  for (let i = 0; i < numSect; i++) {
    const entry  = sectTable + i * PE_SECTION_ENTRY_SIZE;
    const rawNm  = buf.subarray(entry, entry + PE_SECT_NAME_LEN);
    const nul    = rawNm.indexOf(0);
    const name   = rawNm.subarray(0, nul === -1 ? rawNm.length : nul).toString('ascii');
    if (name !== BUN_SECTION_NAME) continue;
    if (match) die('PE has multiple .bun sections');
    const rawSize   = buf.readUInt32LE(entry + PE_SECT_RAW_SIZE_OFF);
    const rawOffset = buf.readUInt32LE(entry + PE_SECT_RAW_OFF_OFF);
    if (rawOffset + rawSize > buf.length) die('.bun out of file bounds');
    match = { format: 'PE', os: 'win32', arch, rawOffset, rawSize };
  }
  if (!match) die('PE has no .bun section');
  return match;
}

function findBunSection(buf) {
  if (buf.length < 4) die('file too small');
  const magic = buf.readUInt32LE(0);
  if (magic === ELF_MAGIC_LE)                       return findSectionElf(buf);
  if (magic === MH_MAGIC_64)                        return findSectionMacho(buf);
  if (magic === MH_CIGAM_64 || magic === MH_CIGAM)  die('Mach-O: only little-endian supported');
  if (magic === MH_MAGIC)                           die('Mach-O: only 64-bit supported');
  return findSectionPe(buf);
}

// ─── Payload + module records ────────────────────────────────────────

function parsePayload(sectionData) {
  if (sectionData.length < 8) die('.bun too small for length prefix');
  const payloadSize = readU64LE(sectionData, 0, '.bun payload length');
  if (payloadSize + 8 > sectionData.length) die('.bun payload exceeds raw section');
  const payload = sectionData.subarray(8, 8 + payloadSize);
  if (payload.length < OFFSET_STRUCT_SIZE + TRAILER.length) die('.bun payload too small');
  if (!payload.subarray(payload.length - TRAILER.length).equals(TRAILER)) die('.bun trailer mismatch');
  return payload;
}

function parseOffsets(payload) {
  const start = payload.length - TRAILER.length - OFFSET_STRUCT_SIZE;
  return {
    modules_offset: payload.readUInt32LE(start + 8),
    modules_size:   payload.readUInt32LE(start + 12),
    entry_point_id: payload.readUInt32LE(start + 16),
  };
}

function parseModules(payload, offsets) {
  if (offsets.modules_size % MODULE_RECORD_SIZE !== 0) {
    die(`modules table size not a multiple of ${MODULE_RECORD_SIZE}: ${offsets.modules_size}`);
  }
  const count = offsets.modules_size / MODULE_RECORD_SIZE;
  if (offsets.entry_point_id >= count) die(`entry_point_id ${offsets.entry_point_id} >= ${count}`);
  const table = checkedSlice(payload, offsets.modules_offset, offsets.modules_size, 'modules table');
  const out = [];
  for (let i = 0; i < count; i++) {
    const rec        = table.subarray(i * MODULE_RECORD_SIZE, (i + 1) * MODULE_RECORD_SIZE);
    const nameOff    = rec.readUInt32LE(0);
    const nameSize   = rec.readUInt32LE(4);
    const contentOff = rec.readUInt32LE(8);
    const contentSize= rec.readUInt32LE(12);
    const loaderId   = rec.readUInt8(49);
    const name = decodeName(checkedSlice(payload, nameOff, nameSize, `module[${i}].name`));
    const content = checkedSlice(payload, contentOff, contentSize, `module[${i}].content`);
    out.push({
      index: i,
      entry: i === offsets.entry_point_id,
      name,
      content,
      loader: LOADERS[loaderId] ?? `unknown(${loaderId})`,
    });
  }
  return out;
}

// ─── Output dispatch ─────────────────────────────────────────────────

function napiBasename(name) {
  // Bun records may use either '/' (POSIX builds) or '\\' (PE) as separator;
  // always normalize so basename grabs the right tail.
  const flat = name.replaceAll('\\', '/');
  const tail = flat.split('/').pop() ?? '';
  return tail.replace(/\.node$/i, '');
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  const [,, binaryPath, outputDir] = process.argv;
  if (!binaryPath || !outputDir) {
    console.error('Usage: extract-natives.mjs <binary-path> <output-dir>');
    process.exit(1);
  }
  if (!existsSync(binaryPath)) {
    console.error(`Binary not found: ${binaryPath}`);
    process.exit(1);
  }

  const buf = readFileSync(binaryPath);
  console.log(`Size:    ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  const section = findBunSection(buf);
  console.log(`Format:  ${section.format} (${section.arch}-${section.os})`);

  const sectionData = checkedSlice(buf, section.rawOffset, section.rawSize, '.bun section');
  const payload     = parsePayload(sectionData);
  const offsets     = parseOffsets(payload);
  const modules     = parseModules(payload, offsets);
  console.log(`Modules: ${modules.length} (entry id=${offsets.entry_point_id})`);

  mkdirSync(outputDir, { recursive: true });

  let cliCount = 0, napiCount = 0, dropped = 0;
  for (const m of modules) {
    if (m.entry) {
      const out = join(outputDir, 'cli.original.js');
      writeFileSync(out, m.content);
      console.log(`  cli.js   ${(m.content.length / 1024 / 1024).toFixed(2)} MB → ${out} (${m.name})`);
      cliCount++;
    } else if (m.loader === 'napi') {
      const base = napiBasename(m.name);
      if (!base) { console.warn(`  skip napi ${m.name}: empty basename`); dropped++; continue; }
      const dir = join(outputDir, 'vendor', base, `${section.arch}-${section.os}`);
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${base}.node`);
      writeFileSync(out, m.content);
      console.log(`  napi     ${(m.content.length / 1024).toFixed(0).padStart(5)} KB → ${out}`);
      napiCount++;
    } else {
      dropped++;
    }
  }
  console.log(`Extracted: ${cliCount} cli.js + ${napiCount} napi (${dropped} dropped)`);
  if (cliCount !== 1) {
    console.error(`error: expected exactly 1 entry-point, got ${cliCount}`);
    process.exit(2);
  }
}

main();
