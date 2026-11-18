import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { parseCigar, parseSam } from '../src/sam.mjs';

async function withIntake(scenario, check) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sam-test-'));
  const service = await createService({ dataDir, scenario });
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }),
    });
    assert.equal(response.status, 201);
    await check({ receipt: await response.json(), service, dataDir });
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('CIGAR 区分消耗参考与消耗读段的操作', () => {
  const cigar = parseCigar('5M2I3M1D2M');
  assert.equal(cigar.referenceLength, 11);
  assert.equal(cigar.readLength, 12);
  assert.deepEqual(cigar.operations.map(operation => operation.op), ['M', 'I', 'M', 'D', 'M']);
  assert.equal(cigar.operations[1].consumesReference, false);
  assert.equal(cigar.operations[1].consumesRead, true);
  assert.equal(cigar.operations[3].consumesReference, true);
  assert.equal(cigar.operations[3].consumesRead, false);
  const hybrid = parseCigar('2H4M1P3N2S');
  assert.equal(hybrid.referenceLength, 7);
  assert.equal(hybrid.readLength, 6);
  assert.equal(parseCigar('*').operations, null);
  assert.equal(parseCigar('5Q').invalid, true);
});

test('standard 场景：同一读段的主/补充比对全部保留且配对闭合', async () => {
  await withIntake('standard', async ({ receipt, service }) => {
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.records.length, 3);
    assert.equal(new Set(receipt.records.map(record => record.id)).size, 3);
    for (const record of receipt.records) {
      assert.equal(record.source.file, 'alignment.sam');
      assert.equal(typeof record.source.offset, 'number');
      assert.equal(record.readGroup, 'rg1');
      assert.equal(record.pairing.status, 'linked');
    }
    const supplementary = receipt.records.find(record => record.flags.value === 2147);
    assert.equal(supplementary.flags.supplementary, true);
    assert.equal(supplementary.flags.secondary, false);
    assert.equal(supplementary.flags.primary, false);
    const first = receipt.records.find(record => record.flags.value === 99);
    assert.equal(first.flags.firstInPair, true);
    assert.equal(first.pos, 101);
    assert.deepEqual(first.referenceSpan, { reference: 'chrA', start: 100, end: 111 });
    assert.equal(first.cigar.referenceLength, 11);
    assert.equal(first.cigar.readLength, 12);
    const second = receipt.records.find(record => record.flags.value === 147);
    assert.deepEqual(first.pairing.records, [second.id]);
    assert.deepEqual(second.pairing.records, [first.id]);
    assert.deepEqual(supplementary.pairing.records, [second.id]);
    assert.deepEqual(receipt.coverage.declarations.references, [{ sn: 'chrA', ln: 10000 }]);
    assert.deepEqual(receipt.coverage.declarations.readGroups, [{ id: 'rg1', sm: 'sample-a' }]);
    assert.equal(receipt.coverage.declarations.hd.so, 'coordinate');
    assert.equal(receipt.coverage.relationships.unresolved, 0);
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
  });
});

test('partial-mate 场景：来源未提供的配对端记为 unresolved 而非 missing-read', async () => {
  await withIntake('partial-mate', async ({ receipt }) => {
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.records.length, 2);
    for (const record of receipt.records) {
      assert.equal(record.pairing.status, 'unresolved');
      assert.deepEqual(record.pairing.records, []);
      assert.equal(record.mate.pos, 301);
    }
    assert.equal(receipt.coverage.relationships.unresolved, 2);
    assert.equal(receipt.coverage.complete, false);
  });
});

test('unmapped 场景：未比对读段、位置 0 与缺值 * 分别保留', async () => {
  await withIntake('unmapped', async ({ receipt }) => {
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.records.length, 4);
    const unmapped = receipt.records.find(record => record.qname === 'read2');
    assert.equal(unmapped.flags.unmapped, true);
    assert.equal(unmapped.reference, null);
    assert.equal(unmapped.pos, 0);
    assert.equal(unmapped.referenceSpan, null);
    assert.equal(unmapped.cigar.operations, null);
    assert.equal(unmapped.sequence, null);
    assert.equal(unmapped.quality, null);
    assert.equal(unmapped.mate, null);
    assert.equal(unmapped.pairing.status, 'unpaired');
    assert.equal(receipt.coverage.alignments.unmapped, 1);
  });
});

test('unknown-reference 场景：未声明的参考序列形成可定位问题但记录保留', async () => {
  await withIntake('unknown-reference', async ({ receipt }) => {
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.records.length, 3);
    const stray = receipt.records.find(record => record.reference === 'chrX');
    assert.ok(stray);
    assert.deepEqual(stray.referenceSpan, { reference: 'chrX', start: 800, end: 806 });
    const issue = receipt.issues.find(item => item.message.includes('chrX'));
    assert.ok(issue);
    assert.equal(issue.source, 'unknown-reference.sam');
    assert.equal(typeof issue.line, 'number');
    assert.equal(typeof issue.offset, 'number');
  });
});

test('结构化收件结果可被打开同一目录的新实例查询', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sam-reopen-'));
  const first = await createService({ dataDir });
  const response = await fetch(`${first.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }),
  });
  const receipt = await response.json();
  await first.close();
  const second = await createService({ dataDir });
  try {
    const saved = await (await fetch(`${second.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.coverage, receipt.coverage);
    assert.deepEqual(saved.evidence, receipt.evidence);
  } finally {
    await second.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('完全无法解释的来源形成 rejected 而不丢原文', () => {
  const parsed = parseSam(Buffer.from('not\ta\tsam\n'), { source: 'inline.sam' });
  assert.equal(parsed.state, 'rejected');
  assert.equal(parsed.records.length, 0);
  assert.ok(parsed.issues.length > 0);
});

test('同名读段不按 QNAME 去重，不同读组互不相连', () => {
  const text = '@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chrA\tLN:1000\n@RG\tID:a\n@RG\tID:b\n'
    + 'r1\t99\tchrA\t10\t60\t4M\t=\t100\t0\tACGT\tIIII\tRG:Z:a\n'
    + 'r1\t147\tchrA\t100\t60\t4M\t=\t10\t0\tACGT\tIIII\tRG:Z:b\n';
  const parsed = parseSam(Buffer.from(text), { source: 'inline.sam' });
  assert.equal(parsed.records.length, 2);
  assert.notEqual(parsed.records[0].id, parsed.records[1].id);
  assert.equal(parsed.records[0].pairing.status, 'unresolved');
  assert.equal(parsed.records[1].pairing.status, 'unresolved');
  assert.equal(parsed.state, 'partial');
});

test('optional 标签按声明类型解释', () => {
  const text = '@HD\tVN:1.6\n@SQ\tSN:chrA\tLN:1000\n'
    + 'r1\t0\tchrA\t10\t60\t4M\t*\t0\t0\tACGT\tIIII\tNM:i:2\tAS:f:3.5\tXX:A:q\tXH:H:0AFF\tXB:B:i,1,-2,3\n';
  const parsed = parseSam(Buffer.from(text), { source: 'inline.sam' });
  assert.equal(parsed.issues.length, 0);
  const [record] = parsed.records;
  assert.deepEqual(record.tags.NM, { type: 'i', value: 2 });
  assert.deepEqual(record.tags.AS, { type: 'f', value: 3.5 });
  assert.deepEqual(record.tags.XX, { type: 'A', value: 'q' });
  assert.deepEqual(record.tags.XH, { type: 'H', value: '0AFF' });
  assert.deepEqual(record.tags.XB, { type: 'B', subtype: 'i', values: [1, -2, 3] });
});

test('未支持的标签类型保留原文并明确报告', () => {
  const text = '@HD\tVN:1.6\n@SQ\tSN:chrA\tLN:1000\n'
    + 'r1\t0\tchrA\t10\t60\t4M\t*\t0\t0\tACGT\tIIII\tZZ:Y:abc\n';
  const parsed = parseSam(Buffer.from(text), { source: 'inline.sam' });
  assert.equal(parsed.records[0].tags.ZZ.raw, 'ZZ:Y:abc');
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.state, 'partial');
});
