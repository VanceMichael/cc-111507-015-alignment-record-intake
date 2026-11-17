import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFlag, parseCigar, parseSam } from '../src/sam-parse.mjs';

test('decodeFlag 解释标准位并识别保留位', () => {
  // 2147 = 0x863 = 0x1 | 0x2 | 0x40 | 0x800
  const flag = decodeFlag(2147);
  assert.equal(flag.paired, true);
  assert.equal(flag.properPair, true);
  assert.equal(flag.mateUnmapped, false);
  assert.equal(flag.secondary, false);
  assert.equal(flag.supplementary, true);
  assert.equal(flag.firstInPair, true);
  assert.equal(flag.secondInPair, false);
  assert.equal(flag.qcFail, false);
  assert.equal(flag.queryUnmapped, false);
  assert.deepEqual(flag.unknownBits, []);
  assert.deepEqual(decodeFlag(0x1000).unknownBits, [0x1000]);
  assert.equal(decodeFlag(99).paired, true);
  assert.equal(decodeFlag(99).firstInPair, true);
  assert.equal(decodeFlag(99).mateReverse, true);
});

test('parseCigar 区分参考/读段消耗，H 与 P 均不消耗', () => {
  const cigar = parseCigar('2H5M1P2I1D3M2H');
  assert.equal(cigar.valid, true);
  assert.equal(cigar.referenceConsumed, 9);
  assert.equal(cigar.queryConsumed, 10);
  const hard = cigar.operations.find(op => op.op === 'H');
  const pad = cigar.operations.find(op => op.op === 'P');
  assert.equal(hard.consumesReference, false);
  assert.equal(hard.consumesQuery, false);
  assert.equal(pad.consumesReference, false);
  assert.equal(pad.consumesQuery, false);
  const missing = parseCigar('*');
  assert.equal(missing.missing, true);
  assert.equal(missing.referenceConsumed, null);
  assert.equal(parseCigar('5Q').valid, false);
  assert.equal(parseCigar('0M').valid, false);
});

test('parseSam 保留 A/i/f/Z/H/B 标签并定位非法标签', () => {
  const sam = [
    '@HD\tVN:1.6',
    '@SQ\tSN:chrA\tLN:100',
    '@RG\tID:rg1\tSM:s',
    `read1\t0\tchrA\t1\t30\t1M\t*\t0\t0\tA\tI\tXZ:Z:ok\tXI:i:-7\tXF:f:1.5\tXA:A:G\tXH:H:4142\tXB:B:i,1,-2,3\tXX:i:not-a-number`,
    '',
  ].join('\n');
  const parsed = parseSam(Buffer.from(sam), 'unit.sam');
  assert.equal(parsed.records.length, 1);
  const tags = Object.fromEntries(parsed.records[0].tags.map(tag => [tag.tag, tag]));
  assert.equal(tags.XI.value, -7);
  assert.equal(tags.XF.value, 1.5);
  assert.equal(tags.XA.value, 'G');
  assert.equal(tags.XH.value, '4142');
  assert.deepEqual(tags.XB.value, { elementType: 'i', values: [1, -2, 3] });
  assert.equal(tags.XZ.value, 'ok');
  assert.ok(parsed.issues.some(issue => issue.code === 'invalid-tag-value' && issue.field === 'XX' && issue.line === 4));
  assert.ok(parsed.records[0].tags.some(tag => tag.tag === 'XX' && tag.issue === 'invalid-tag-value'));
});

test('parseSam 同名不同读组隔离，范围外头部保留原文并标注不支持', () => {
  const sam = [
    '@HD\tVN:1.6',
    '@SQ\tSN:chrA\tLN:100',
    '@RG\tID:rg1\tSM:a',
    '@RG\tID:rg2\tSM:b',
    '@PG\tID:aligner\tVN:9',
    'read1\t99\tchrA\t1\t30\t1M\t=\t5\t0\tA\tI\tRG:Z:rg1',
    'read1\t99\tchrA\t2\t30\t1M\t=\t5\t0\tA\tI\tRG:Z:rg2',
    '',
  ].join('\n');
  const parsed = parseSam(Buffer.from(sam), 'unit.sam');
  assert.equal(parsed.records.length, 2);
  assert.notEqual(parsed.records[0].recordId, parsed.records[1].recordId);
  assert.notEqual(parsed.records[0].readGroup.id, parsed.records[1].readGroup.id);
  const other = parsed.headers.other.find(item => item.recordType === '@PG');
  assert.ok(other);
  assert.match(other.raw, /^@PG\t/);
  assert.ok(parsed.issues.some(issue => issue.code === 'unsupported-header'));
});

test('parseSam 行偏移按字节计，CRLF 不影响行号与解释', () => {
  const sam = '@HD\tVN:1.6\r\n@SQ\tSN:chrA\tLN:100\r\nread1\t4\t*\t0\t0\t*\t*\t0\t0\t*\t*\r\n';
  const parsed = parseSam(Buffer.from(sam), 'crlf.sam');
  assert.equal(parsed.records.length, 1);
  const record = parsed.records[0];
  assert.equal(record.line, 3);
  assert.equal(record.unmapped, true);
  assert.equal(record.lineOffset, sam.indexOf('read1'));
});
