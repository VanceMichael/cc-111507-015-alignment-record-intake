// SAM 1.6 文本解析：只做忠实解释，不重新比对、不判断变异。
// 支持范围见 docs/来源格式.md：HD/SQ/RG 头部、FLAG 位、1-based POS、
// CIGAR、RNEXT/PNEXT 与 A/i/f/Z/H/B 可选标签。

const FLAG_BITS = [
  [0x1, 'paired'],
  [0x2, 'properPair'],
  [0x4, 'queryUnmapped'],
  [0x8, 'mateUnmapped'],
  [0x10, 'reverse'],
  [0x20, 'mateReverse'],
  [0x40, 'firstInPair'],
  [0x80, 'secondInPair'],
  [0x100, 'secondary'],
  [0x200, 'qcFail'],
  [0x400, 'duplicate'],
  [0x800, 'supplementary'],
];

// M/D/N/=/X 消耗参考；M/I/S/=/X 消耗读段；H/P 两者都不消耗。
const REFERENCE_OPS = new Set(['M', 'D', 'N', '=', 'X']);
const QUERY_OPS = new Set(['M', 'I', 'S', '=', 'X']);

export function decodeFlag(raw) {
  const flags = { raw, unknownBits: [] };
  for (const [bit, name] of FLAG_BITS) flags[name] = ((raw & bit) === bit);
  let knownMask = 0;
  for (const [bit] of FLAG_BITS) knownMask |= bit;
  const residual = raw & (~knownMask);
  for (let bit = 1; bit <= 0x8000; bit *= 2) {
    if ((residual & bit) !== 0) flags.unknownBits.push(bit);
  }
  return flags;
}

export function parseCigar(raw) {
  if (raw === '*') {
    return { raw, missing: true, valid: true, operations: [], referenceConsumed: null, queryConsumed: null };
  }
  const operations = [];
  let referenceConsumed = 0;
  let queryConsumed = 0;
  let index = 0;
  while (index < raw.length) {
    const start = index;
    while (index < raw.length && raw.charCodeAt(index) >= 48 && raw.charCodeAt(index) <= 57) index += 1;
    if (index === start || index >= raw.length) {
      return { raw, missing: false, valid: false, operations: [], referenceConsumed: null, queryConsumed: null };
    }
    const length = Number(raw.slice(start, index));
    const op = raw[index];
    if (!'MIDNSHP=X'.includes(op) || length === 0) {
      return { raw, missing: false, valid: false, operations: [], referenceConsumed: null, queryConsumed: null };
    }
    const consumesReference = REFERENCE_OPS.has(op);
    const consumesQuery = QUERY_OPS.has(op);
    if (consumesReference) referenceConsumed += length;
    if (consumesQuery) queryConsumed += length;
    operations.push({ op, length, consumesReference, consumesQuery });
    index += 1;
  }
  if (operations.length === 0) {
    return { raw, missing: false, valid: false, operations: [], referenceConsumed: null, queryConsumed: null };
  }
  return { raw, missing: false, valid: true, operations, referenceConsumed, queryConsumed };
}

function parseInteger(text) {
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

function parseTag(field) {
  // SAM 标签名为两个字符：首字符字母，次字符字母或数字。
  const match = /^([A-Za-z][A-Za-z0-9]):([AifZHB]):([\s\S]*)$/.exec(field);
  if (!match) return { raw: field, unsupported: true, issue: 'malformed-tag' };
  const [, tag, type, tail] = match;
  if (type === 'A') {
    if (tail.length !== 1) return { tag, type, value: tail, unsupported: true, issue: 'invalid-tag-value' };
    return { tag, type, value: tail };
  }
  if (type === 'i') {
    if (!/^-?\d+$/.test(tail)) return { tag, type, value: tail, unsupported: true, issue: 'invalid-tag-value' };
    return { tag, type, value: Number(tail) };
  }
  if (type === 'f') {
    const value = Number(tail);
    if (!Number.isFinite(value)) return { tag, type, value: tail, unsupported: true, issue: 'invalid-tag-value' };
    return { tag, type, value };
  }
  if (type === 'Z') return { tag, type, value: tail };
  if (type === 'H') {
    if (tail !== '' && !/^([0-9A-Fa-f]{2})+$/.test(tail)) {
      return { tag, type, value: tail, unsupported: true, issue: 'invalid-tag-value' };
    }
    return { tag, type, value: tail };
  }
  // B 类型：c/C/s/S/i/I/f 元素类型加逗号分隔数值
  const separator = tail.indexOf(',');
  const elementType = separator === -1 ? tail : tail.slice(0, separator);
  if (!'cCsSiIf'.includes(elementType) || separator === -1) {
    return { tag, type, value: tail, unsupported: true, issue: 'invalid-tag-value' };
  }
  const values = [];
  for (const part of tail.slice(separator + 1).split(',')) {
    const value = elementType === 'f' ? Number(part) : parseInteger(part);
    if (value === null || (elementType === 'f' && !Number.isFinite(value))) {
      return { tag, type, value: tail, unsupported: true, issue: 'invalid-tag-value' };
    }
    values.push(value);
  }
  return { tag, type, value: { elementType, values } };
}

function splitHeaderFields(line) {
  const parts = line.split('\t');
  const fields = {};
  for (const part of parts.slice(1)) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    fields[part.slice(0, at)] = part.slice(at + 1);
  }
  return { recordType: parts[0], fields };
}

// 按物理行切分，保留 1-based 行号与字节偏移，CRLF 容忍处理。
function iterLines(bytes) {
  const lines = [];
  let lineNo = 0;
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0a) {
      lineNo += 1;
      let end = index;
      if (end > start && bytes[end - 1] === 0x0d) end -= 1;
      const text = bytes.toString('utf8', start, end);
      lines.push({ lineNo, lineOffset: start, text });
      start = index + 1;
    }
  }
  return lines;
}

export function parseSam(bytes, source) {
  const issues = [];
  const headers = { hd: null, sq: [], rg: [], other: [] };
  const records = [];
  const referenceNames = new Set();
  const readGroupIds = new Set();
  let text;
  try {
    text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    return {
      source, headers, records, issues: [{
        code: 'undecodable-bytes', severity: 'fatal', source, line: null,
        message: '来源字节不是合法 UTF-8 文本，无法按 SAM 解释',
      }],
      referenceNames: [...referenceNames], readGroupIds: [...readGroupIds],
    };
  }
  for (const { lineNo, lineOffset, text: line } of iterLines(bytes)) {
    if (line === '') continue;
    if (line.startsWith('@')) {
      const { recordType, fields } = splitHeaderFields(line);
      if (recordType === '@HD') {
        if (headers.hd) issues.push({ code: 'duplicate-header', severity: 'fatal', source, line: lineNo, field: 'HD', message: '@HD 声明重复' });
        headers.hd = { line: lineNo, fields };
      } else if (recordType === '@SQ') {
        if (!fields.SN) {
          issues.push({ code: 'malformed-header', severity: 'fatal', source, line: lineNo, field: 'SN', message: '@SQ 缺少 SN 参考序列名' });
          continue;
        }
        const length = parseInteger(fields.LN ?? '');
        if (length === null || length <= 0) {
          issues.push({ code: 'malformed-header', severity: 'fatal', source, line: lineNo, field: 'LN', message: '@SQ 缺少合法 LN 长度' });
          continue;
        }
        if (referenceNames.has(fields.SN)) {
          issues.push({ code: 'duplicate-reference', source, line: lineNo, field: 'SN', message: `@SQ 参考序列 ${fields.SN} 重复声明` });
        }
        referenceNames.add(fields.SN);
        headers.sq.push({ line: lineNo, name: fields.SN, length, fields });
      } else if (recordType === '@RG') {
        if (!fields.ID) {
          issues.push({ code: 'malformed-header', severity: 'fatal', source, line: lineNo, field: 'ID', message: '@RG 缺少 ID 读组标识' });
          continue;
        }
        if (readGroupIds.has(fields.ID)) {
          issues.push({ code: 'duplicate-read-group', source, line: lineNo, field: 'ID', message: `@RG 读组 ${fields.ID} 重复声明` });
        }
        readGroupIds.add(fields.ID);
        headers.rg.push({ line: lineNo, id: fields.ID, fields });
      } else {
        // 文档范围外的头部记录：保留原文并明确不支持，不假装解析。
        headers.other.push({ line: lineNo, recordType, raw: line });
        issues.push({ code: 'unsupported-header', source, line: lineNo, field: recordType, message: `头部记录 ${recordType} 不在约定支持范围，原文已保留` });
      }
      continue;
    }
    const fields = line.split('\t');
    if (fields.length < 11) {
      issues.push({ code: 'malformed-alignment-line', severity: 'fatal', source, line: lineNo, message: `比对行字段数 ${fields.length} 少于 SAM 规定的 11 个必填字段` });
      continue;
    }
    const [qname, flagText, rnameRaw, posText, mapqText, cigarRaw, rnextRaw, pnextText, tlenText, seqRaw, qualRaw, ...tagFields] = fields;
    const flagRaw = parseInteger(flagText);
    if (flagRaw === null || flagRaw < 0 || flagRaw > 0xffff) {
      issues.push({ code: 'malformed-alignment-line', severity: 'fatal', source, line: lineNo, field: 'FLAG', message: `FLAG 无法解释：${flagText}` });
      continue;
    }
    const pos = parseInteger(posText);
    const mapq = parseInteger(mapqText);
    const pnext = parseInteger(pnextText);
    const tlen = parseInteger(tlenText);
    if (pos === null || pos < 0 || mapq === null || mapq < 0 || pnext === null || pnext < 0 || tlen === null) {
      issues.push({ code: 'malformed-alignment-line', severity: 'fatal', source, line: lineNo, field: 'POS/MAPQ/PNEXT/TLEN', message: '位置或质量字段不是合法整数' });
      continue;
    }
    const flag = decodeFlag(flagRaw);
    for (const bit of flag.unknownBits) {
      issues.push({ code: 'reserved-flag-bit', source, line: lineNo, field: 'FLAG', message: `FLAG 含保留位 ${bit}，已按原值保存` });
    }
    const cigar = parseCigar(cigarRaw);
    if (!cigar.valid) {
      issues.push({ code: 'invalid-cigar', source, line: lineNo, field: 'CIGAR', message: `CIGAR 无法解释：${cigarRaw}，原文已保留` });
    }
    const tags = tagFields.map((fieldText) => {
      const tag = parseTag(fieldText);
      if (tag.issue) {
        issues.push({ code: tag.issue, source, line: lineNo, field: tag.tag || fieldText, message: `可选标签无法解释：${fieldText}，原文已保留` });
      }
      return tag;
    });
    const rgTag = tags.find(tag => tag.tag === 'RG' && tag.type === 'Z');
    const readGroupId = rgTag ? rgTag.value : null;
    if (readGroupId !== null && !readGroupIds.has(readGroupId)) {
      issues.push({ code: 'read-group-not-declared', source, line: lineNo, field: 'RG', message: `RG 标签 ${readGroupId} 未在 @RG 头部声明` });
    }
    const rname = rnameRaw === '*' ? null : rnameRaw;
    if (rname !== null && !referenceNames.has(rname)) {
      issues.push({ code: 'reference-not-declared', source, line: lineNo, field: 'RNAME', message: `参考序列 ${rname} 未在 @SQ 头部声明` });
    }
    const rnextInterpreted = rnextRaw === '=' ? rname : (rnextRaw === '*' ? null : rnextRaw);
    // 0-based 半开区间；POS 为 0（未比对约定）或 CIGAR 缺值/非法时不给区间，但原坐标仍保留。
    let referenceSpan = null;
    if (rname !== null && pos > 0 && cigar.valid && !cigar.missing) {
      referenceSpan = { start: pos - 1, end: pos - 1 + cigar.referenceConsumed };
    }
    const record = {
      recordId: `${source}:L${lineNo}`,
      source,
      line: lineNo,
      lineOffset,
      qname,
      flag,
      isPrimary: !flag.secondary && !flag.supplementary,
      isSecondary: flag.secondary,
      isSupplementary: flag.supplementary,
      unmapped: flag.queryUnmapped,
      location: {
        rname,
        rnameRaw,
        pos,
        mapq,
        referenceSpan,
        referenceDeclared: rname === null ? null : referenceNames.has(rname),
      },
      cigar,
      sequence: { seq: seqRaw === '*' ? null : seqRaw, missing: seqRaw === '*', length: seqRaw === '*' ? null : seqRaw.length },
      quality: qualRaw === '*' ? null : qualRaw,
      readGroup: readGroupId === null ? null : {
        id: readGroupId,
        declared: readGroupIds.has(readGroupId),
        declaration: headers.rg.find(item => item.id === readGroupId)?.fields ?? null,
      },
      pairing: {
        paired: flag.paired,
        rnext: { raw: rnextRaw, interpreted: rnextInterpreted },
        pnext,
        tlen,
        relationship: {
          status: flag.paired ? 'unresolved' : 'not-applicable',
          counterpart: null,
          counterpartSource: null,
          reason: flag.paired ? 'mate-not-provided' : 'segment-not-paired',
        },
      },
      tags,
    };
    records.push(record);
  }
  return {
    source, headers, records, issues,
    referenceNames: [...referenceNames], readGroupIds: [...readGroupIds],
  };
}
