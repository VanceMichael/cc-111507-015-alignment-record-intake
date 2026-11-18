import { createHash } from 'node:crypto';

// SAM 1.6 文本解析。支持范围以 docs/来源格式.md 为准：HD/SQ/RG 声明、FLAG 位、
// 1-based POS、CIGAR、RNEXT/PNEXT 与 A/i/f/Z/H/B 标签；未覆盖的扩展保留原文并报告。
// 本模块只忠实登记来源记录，不做重新比对或变异判断。

const FLAG_BITS = [
  ['paired', 0x1],
  ['properPair', 0x2],
  ['unmapped', 0x4],
  ['mateUnmapped', 0x8],
  ['reverse', 0x10],
  ['mateReverse', 0x20],
  ['firstInPair', 0x40],
  ['secondInPair', 0x80],
  ['secondary', 0x100],
  ['qcFail', 0x200],
  ['duplicate', 0x400],
  ['supplementary', 0x800],
];

// CIGAR 操作对参考序列与读段的消耗：M/D/N/=/X 消耗参考，M/I/S/=/X 消耗读段，H/P 二者均不消耗。
const CONSUMES_REFERENCE = new Set(['M', 'D', 'N', '=', 'X']);
const CONSUMES_READ = new Set(['M', 'I', 'S', '=', 'X']);
const TAG_TYPES = new Set(['A', 'i', 'f', 'Z', 'H', 'B']);

export function parseCigar(raw) {
  const missing = { raw, operations: null, referenceLength: null, readLength: null };
  if (raw === '*') return missing;
  const operations = [];
  let referenceLength = 0;
  let readLength = 0;
  let index = 0;
  const pattern = /(\d+)([MIDNSHP=X])/y;
  while (index < raw.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(raw);
    if (!match) return { ...missing, invalid: true };
    const count = Number(match[1]);
    const op = match[2];
    operations.push({ count, op, consumesReference: CONSUMES_REFERENCE.has(op), consumesRead: CONSUMES_READ.has(op) });
    if (CONSUMES_REFERENCE.has(op)) referenceLength += count;
    if (CONSUMES_READ.has(op)) readLength += count;
    index += match[0].length;
  }
  if (operations.length === 0) return { ...missing, invalid: true };
  return { raw, operations, referenceLength, readLength };
}

function splitBufferLines(bytes) {
  const lines = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    lines.push({ text: bytes.subarray(start, end).toString('utf8'), offset: start, number });
    start = index + 1;
    number += 1;
  }
  if (start < bytes.length) {
    let end = bytes.length;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    lines.push({ text: bytes.subarray(start, end).toString('utf8'), offset: start, number });
  }
  return lines;
}

function parseHeaderLine(text) {
  const fields = text.split('\t');
  const tags = {};
  for (const field of fields.slice(1)) {
    const match = /^([A-Za-z][A-Za-z0-9]):([\s\S]*)$/.exec(field);
    if (match) tags[match[1]] = match[2];
  }
  return { type: fields[0].slice(1), tags };
}

function parseFlags(value) {
  const flags = { value };
  for (const [name, bit] of FLAG_BITS) flags[name] = (value & bit) !== 0;
  // primary 不是独立位，而是 secondary 与 supplementary 均未置位；三者分别保存。
  flags.primary = !flags.secondary && !flags.supplementary;
  return flags;
}

function parseTag(field) {
  const match = /^([A-Za-z][A-Za-z0-9]):(.):([\s\S]*)$/.exec(field);
  if (!match) return { error: 'optional 字段形态无法识别' };
  const [, tag, type, rest] = match;
  if (!TAG_TYPES.has(type)) return { error: `optional 字段类型 ${type} 不在支持范围`, tag, type, raw: field, keepRaw: true };
  if (type === 'i') {
    if (!/^[+-]?\d+$/.test(rest)) return { error: 'i 型标签值不是整数', tag, type, raw: field, keepRaw: true };
    return { tag, type, value: Number.parseInt(rest, 10) };
  }
  if (type === 'f') {
    const value = Number(rest);
    if (!Number.isFinite(value)) return { error: 'f 型标签值不是有限数值', tag, type, raw: field, keepRaw: true };
    return { tag, type, value };
  }
  if (type === 'B') {
    const [subtype, ...items] = rest.split(',');
    if (!/^[cCsSiIf]$/.test(subtype)) return { error: `B 型标签子类型 ${subtype} 不在支持范围`, tag, type, raw: field, keepRaw: true };
    if (items.length === 0) return { error: 'B 型标签缺少数组元素', tag, type, raw: field, keepRaw: true };
    if (subtype !== 'f' && items.some(item => !/^[+-]?\d+$/.test(item))) {
      return { error: 'B 型整型数组含非整数元素', tag, type, raw: field, keepRaw: true };
    }
    const values = items.map(Number);
    if (values.some(value => !Number.isFinite(value))) return { error: 'B 型数组含非数值元素', tag, type, raw: field, keepRaw: true };
    return { tag, type, subtype, values };
  }
  return { tag, type, value: rest };
}

function parseAlignment(line, source, issues) {
  const at = { source, line: line.number, offset: line.offset };
  const fields = line.text.split('\t');
  if (fields.length < 11) {
    issues.push({ ...at, message: `比对行列数不足（${fields.length}/11），该行未形成记录` });
    return null;
  }
  const [qnameRaw, flagRaw, rnameRaw, posRaw, mapqRaw, cigarRaw, rnextRaw, pnextRaw, tlenRaw, seqRaw, qualRaw, ...tagFields] = fields;
  const unsigned = (raw, max) => (/^\d+$/.test(raw) && Number(raw) <= max ? Number(raw) : null);
  const flag = unsigned(flagRaw, 65535);
  const pos = unsigned(posRaw, Number.MAX_SAFE_INTEGER);
  const mapq = unsigned(mapqRaw, 255);
  const pnext = unsigned(pnextRaw, Number.MAX_SAFE_INTEGER);
  const tlen = /^[+-]?\d+$/.test(tlenRaw) ? Number(tlenRaw) : null;
  const invalid = [];
  if (flag === null) invalid.push('FLAG');
  if (pos === null) invalid.push('POS');
  if (mapq === null) invalid.push('MAPQ');
  if (pnext === null) invalid.push('PNEXT');
  if (tlen === null) invalid.push('TLEN');
  if (invalid.length > 0) {
    issues.push({ ...at, message: `核心字段无法解释：${invalid.join('、')}，该行未形成记录` });
    return null;
  }
  const cigar = parseCigar(cigarRaw);
  if (cigar.invalid) issues.push({ ...at, message: `CIGAR 无法解释：${cigarRaw}` });
  const tags = {};
  for (const field of tagFields) {
    const parsed = parseTag(field);
    if (parsed.error) {
      issues.push({ ...at, message: parsed.error });
      if (parsed.keepRaw && parsed.tag) tags[parsed.tag] = { type: parsed.type, raw: parsed.raw };
      continue;
    }
    if (tags[parsed.tag]) issues.push({ ...at, message: `标签 ${parsed.tag} 重复出现` });
    tags[parsed.tag] = parsed.type === 'B'
      ? { type: 'B', subtype: parsed.subtype, values: parsed.values }
      : { type: parsed.type, value: parsed.value };
  }
  // 缺值 * 与数值 0 含义不同：* 记为 null，POS 0（未比对位置）保留为 0。
  const reference = rnameRaw === '*' ? null : rnameRaw;
  const readGroup = tags.RG?.type === 'Z' ? tags.RG.value : null;
  const mate = rnextRaw === '*' && pnext === 0 ? null : {
    reference: rnextRaw === '*' ? null : rnextRaw === '=' ? reference : rnextRaw,
    pos: pnext,
  };
  const record = {
    id: `${source}#${line.offset}`,
    source: { file: source, line: line.number, offset: line.offset },
    qname: qnameRaw === '*' ? null : qnameRaw,
    readGroup,
    flags: parseFlags(flag),
    reference,
    pos,
    mapq,
    cigar,
    // referenceSpan 为 0-based 半开区间；原坐标保留在 pos/reference 中。
    referenceSpan: reference !== null && pos > 0 && cigar.operations
      ? { reference, start: pos - 1, end: pos - 1 + cigar.referenceLength }
      : null,
    mate,
    tlen,
    sequence: seqRaw === '*' ? null : seqRaw,
    quality: qualRaw === '*' ? null : qualRaw,
    tags,
  };
  if (!record.flags.unmapped && (reference === null || pos === 0)) {
    issues.push({ ...at, message: '未置未比对位但缺少参考位置' });
  }
  if (cigar.operations && record.sequence !== null && cigar.readLength !== record.sequence.length) {
    issues.push({ ...at, message: `CIGAR 读段长度 ${cigar.readLength} 与 SEQ 长度 ${record.sequence.length} 不一致` });
  }
  return record;
}

// 配对关系只登记已采到的记录：同一 QNAME 且同一读组、首/次端互补的记录互为候选；
// RNEXT/PNEXT 指向明确时按位置收窄。来源未提供的配对端记为 unresolved，不虚构 missing-read。
function resolvePairing(records) {
  for (const record of records) {
    if (!record.flags.paired) {
      record.pairing = { status: 'unpaired', records: [] };
      continue;
    }
    if (record.qname === null) {
      record.pairing = { status: 'unresolved', records: [] };
      continue;
    }
    const complement = record.flags.firstInPair && !record.flags.secondInPair
      ? other => other.flags.secondInPair
      : record.flags.secondInPair && !record.flags.firstInPair
        ? other => other.flags.firstInPair
        : () => true;
    let candidates = records.filter(other => other !== record
      && other.qname === record.qname
      && other.readGroup === record.readGroup
      && complement(other));
    if (record.mate !== null && record.mate.pos > 0) {
      const pointed = candidates.filter(other => other.pos === record.mate.pos
        && (record.mate.reference === null || other.reference === record.mate.reference));
      if (pointed.length > 0) candidates = pointed;
    }
    record.pairing = candidates.length > 0
      ? { status: 'linked', records: candidates.map(item => item.id).sort() }
      : { status: 'unresolved', records: [] };
  }
}

export function parseSam(bytes, { source }) {
  const issues = [];
  const records = [];
  const header = { hd: null, references: [], readGroups: [], others: [] };
  let alignmentsStarted = false;

  for (const line of splitBufferLines(bytes)) {
    const at = { source, line: line.number, offset: line.offset };
    const text = line.text;
    if (text.startsWith('@')) {
      if (alignmentsStarted) issues.push({ ...at, message: '头部行出现在比对记录之后' });
      const parsed = parseHeaderLine(text);
      if (parsed.type === 'HD') {
        header.hd = { vn: parsed.tags.VN ?? null, so: parsed.tags.SO ?? null, fields: parsed.tags, raw: text };
      } else if (parsed.type === 'SQ') {
        const ln = Number(parsed.tags.LN);
        if (!parsed.tags.SN || !Number.isInteger(ln) || ln <= 0) issues.push({ ...at, message: '@SQ 声明缺少有效的 SN 或 LN' });
        header.references.push({ sn: parsed.tags.SN ?? null, ln: Number.isInteger(ln) ? ln : null, fields: parsed.tags, raw: text });
      } else if (parsed.type === 'RG') {
        if (!parsed.tags.ID) issues.push({ ...at, message: '@RG 声明缺少 ID' });
        header.readGroups.push({ id: parsed.tags.ID ?? null, sm: parsed.tags.SM ?? null, fields: parsed.tags, raw: text });
      } else {
        header.others.push(text);
      }
      continue;
    }
    if (text.trim() === '') {
      issues.push({ ...at, message: '存在空白行' });
      continue;
    }
    alignmentsStarted = true;
    const record = parseAlignment(line, source, issues);
    if (record) records.push(record);
  }

  const declaredReferences = new Set(header.references.map(item => item.sn).filter(Boolean));
  const declaredReadGroups = new Set(header.readGroups.map(item => item.id).filter(Boolean));
  for (const record of records) {
    const at = { source, line: record.source.line, offset: record.source.offset };
    if (record.reference !== null && !declaredReferences.has(record.reference)) {
      issues.push({ ...at, message: `参考序列 ${record.reference} 未在 @SQ 声明` });
    }
    if (record.mate !== null && record.mate.reference !== null && !declaredReferences.has(record.mate.reference)) {
      issues.push({ ...at, message: `配对参考序列 ${record.mate.reference} 未在 @SQ 声明` });
    }
    if (record.readGroup !== null && !declaredReadGroups.has(record.readGroup)) {
      issues.push({ ...at, message: `读组 ${record.readGroup} 未在 @RG 声明` });
    }
  }

  resolvePairing(records);

  const relationships = { linked: 0, unresolved: 0, unpaired: 0 };
  const alignments = { primary: 0, secondary: 0, supplementary: 0, unmapped: 0 };
  for (const record of records) {
    relationships[record.pairing.status] += 1;
    if (record.flags.supplementary) alignments.supplementary += 1;
    else if (record.flags.secondary) alignments.secondary += 1;
    else alignments.primary += 1;
    if (record.flags.unmapped) alignments.unmapped += 1;
  }

  const complete = issues.length === 0 && relationships.unresolved === 0;
  const coverage = {
    structured: true,
    downloadedBytes: bytes.length,
    declarations: {
      hd: header.hd ? { vn: header.hd.vn, so: header.hd.so } : null,
      references: header.references.map(({ sn, ln }) => ({ sn, ln })),
      readGroups: header.readGroups.map(({ id, sm }) => ({ id, sm })),
    },
    records: records.length,
    alignments,
    relationships,
    complete,
  };
  const state = records.length === 0 && issues.length > 0 ? 'rejected' : complete ? 'complete' : 'partial';
  const evidence = {
    entry: source,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    relationshipBasis: {
      identity: '记录身份 = 来源文件 + 行字节偏移，不按 QNAME 唯一化',
      pairing: '配对关系依据 FLAG 首/次端位、RNEXT/PNEXT 指向及 QNAME 与读组一致；来源未提供的配对端记为 unresolved',
    },
  };
  return { state, records, issues, coverage, evidence };
}
