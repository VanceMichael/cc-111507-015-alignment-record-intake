import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

async function structuredIntake(service, body = { mode: 'structured' }) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: await response.json() };
}

test('结构化收件：标准交付逐条保留主/次/补充比对且可查询可持久化', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-standard-'));
  const service = await createService({ dataDir });
  try {
    const { status, result } = await structuredIntake(service);
    assert.equal(status, 201);
    assert.equal(result.state, 'complete');
    assert.equal(result.records.length, 3);
    // 同一 QNAME 三条记录（主/补充/对端主）不得按读名去重
    assert.deepEqual([...new Set(result.records.map(record => record.qname))], ['read1']);
    assert.equal(new Set(result.records.map(record => record.recordId)).size, 3);
    assert.deepEqual(
      result.records.map(record => [record.isPrimary, record.isSecondary, record.isSupplementary]),
      [[true, false, false], [false, false, true], [true, false, false]],
    );
    // 身份至少含来源文件与行偏移，且不是数组下标
    for (const record of result.records) {
      assert.equal(record.source, 'alignment.sam');
      assert.equal(typeof record.line, 'number');
      assert.equal(typeof record.lineOffset, 'number');
      assert.match(record.recordId, /^alignment\.sam:L\d+$/);
    }
    // 配对关系在文件内闭合
    for (const record of result.records) {
      assert.equal(record.pairing.relationship.status, 'resolved');
      assert.ok(record.pairing.relationship.counterpart);
    }
    assert.equal(result.coverage.relationships.unresolved, 0);
    // 头部声明被保留
    const file = result.coverage.files[0];
    assert.equal(file.headers.sequenceDictionary[0].name, 'chrA');
    assert.equal(file.headers.sequenceDictionary[0].length, 10000);
    assert.equal(file.headers.readGroups[0].id, 'rg1');
    assert.equal(file.headers.hd.SO, 'coordinate');
    // 持久查询：保存后经 GET 取回相同记录与 coverage
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：CIGAR 消耗区分与 0-based 半开参考区间', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-cigar-'));
  const service = await createService({ dataDir });
  try {
    const { result } = await structuredIntake(service);
    const [first, supplementary, mate] = result.records;
    // 5M2I3M1D2M：参考 5+3+1+2=11，读段 5+2+3+2=12
    assert.equal(first.cigar.referenceConsumed, 11);
    assert.equal(first.cigar.queryConsumed, 12);
    assert.deepEqual(first.location.referenceSpan, { start: 100, end: 111 });
    // 6S6M：S 只消耗读段，参考仅 6，读段 12
    assert.equal(supplementary.cigar.referenceConsumed, 6);
    assert.equal(supplementary.cigar.queryConsumed, 12);
    assert.deepEqual(supplementary.location.referenceSpan, { start: 800, end: 806 });
    // 12M：各 12
    assert.equal(mate.cigar.referenceConsumed, 12);
    assert.equal(mate.cigar.queryConsumed, 12);
    const hardClip = supplementary.cigar.operations.find(() => false);
    assert.equal(hardClip, undefined);
    // H/P 不消耗二者由解析器单测覆盖；这里校验操作级解释
    assert.deepEqual(first.cigar.operations.map(op => [op.op, op.consumesReference, op.consumesQuery]),
      [['M', true, true], ['I', false, true], ['M', true, true], ['D', true, false], ['M', true, true]]);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：未比对读段保留位置 0 与缺值 * 的区别', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-unmapped-'));
  const service = await createService({ dataDir, scenario: 'unmapped' });
  try {
    const { result } = await structuredIntake(service);
    assert.equal(result.state, 'complete');
    assert.equal(result.coverage.totals.unmapped, 1);
    const unmapped = result.records.find(record => record.unmapped);
    assert.equal(unmapped.location.pos, 0);
    assert.equal(unmapped.location.rname, null);
    assert.equal(unmapped.location.referenceSpan, null);
    assert.equal(unmapped.cigar.missing, true);
    assert.equal(unmapped.sequence.missing, true);
    assert.equal(unmapped.sequence.seq, null);
    assert.equal(unmapped.quality, null);
    // FLAG 4 未配对：关系为 not-applicable，而不是 unresolved
    assert.equal(unmapped.pairing.relationship.status, 'not-applicable');
    assert.equal(result.coverage.relationships.notApplicable, 1);
    // 原坐标/原文符号仍可追溯
    assert.equal(unmapped.location.rnameRaw, '*');
    assert.equal(unmapped.cigar.raw, '*');
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：对端未由来源提供时为 unresolved 且状态 partial', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-partial-'));
  const service = await createService({ dataDir, scenario: 'partial-mate' });
  try {
    const { result } = await structuredIntake(service);
    assert.equal(result.state, 'partial');
    assert.equal(result.records.length, 2);
    for (const record of result.records) {
      assert.equal(record.pairing.relationship.status, 'unresolved');
      assert.equal(record.pairing.relationship.reason, 'mate-not-provided');
      assert.equal(record.pairing.relationship.counterpart, null);
    }
    assert.equal(result.coverage.relationships.unresolved, 2);
    assert.equal(result.coverage.gaps.length, 2);
    // 来源声明的 RNEXT/PNEXT 解释仍保留
    assert.equal(result.records[0].pairing.rnext.interpreted, 'chrA');
    assert.equal(result.records[0].pairing.pnext, 301);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：参考序列未声明形成可定位问题但不丢记录', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-unknown-ref-'));
  const service = await createService({ dataDir, scenario: 'unknown-reference' });
  try {
    const { result } = await structuredIntake(service);
    assert.equal(result.state, 'partial');
    assert.equal(result.records.length, 3);
    const issue = result.issues.find(item => item.code === 'reference-not-declared');
    assert.ok(issue);
    assert.equal(issue.source, 'unknown-reference.sam');
    assert.equal(issue.line, 5);
    const bad = result.records.find(record => record.location.rname === 'chrX');
    assert.equal(bad.location.referenceDeclared, false);
    // 位置解释忠实保留，未声明不改变原坐标
    assert.deepEqual(bad.location.referenceSpan, { start: 800, end: 806 });
    assert.equal(bad.location.pos, 801);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：配对端跨交付文件闭合，不依赖排序或同文件', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-split-'));
  const service = await createService({ dataDir, scenario: 'split-mates' });
  try {
    const { status, result } = await structuredIntake(service, {
      mode: 'structured',
      sources: ['split-r1.sam', 'split-r2.sam'],
    });
    assert.equal(status, 201);
    assert.equal(result.state, 'complete');
    assert.equal(result.records.length, 5);
    assert.deepEqual(result.coverage.sourcesFetched, ['split-r1.sam', 'split-r2.sam']);
    const r1 = result.records.filter(record => record.source === 'split-r1.sam');
    const r2 = result.records.filter(record => record.source === 'split-r2.sam');
    // 99 的对端在另一文件，指向主比对而非次级
    const first = r1.find(record => record.flag.firstInPair && !record.unmapped);
    assert.equal(first.pairing.relationship.status, 'resolved');
    assert.equal(first.pairing.relationship.counterpartSource, 'split-r2.sam');
    const counterpart = result.records.find(record => record.recordId === first.pairing.relationship.counterpart);
    assert.equal(counterpart.isPrimary, true);
    // 次级片段不替代主比对
    const secondary = r2.find(record => record.isSecondary);
    assert.equal(secondary.pairing.relationship.status, 'resolved');
    assert.equal(secondary.pairing.relationship.counterpart, first.recordId);
    // 一边按 FLAG 标注 mateUnmapped，另一边实际闭合到未比对记录，两种解释都保留
    const unmapped = r1.find(record => record.unmapped);
    const itsMate = r2.find(record => record.qname === 'read2' && record.flag.mateUnmapped);
    assert.equal(unmapped.pairing.relationship.counterpart, itsMate.recordId);
    assert.equal(itsMate.pairing.relationship.reason, 'mate-unmapped-by-flag');
    assert.equal(result.coverage.relationships.unresolved, 0);
    // 两个 blob 都按原文留存
    assert.equal(result.blobs.length, 2);
    assert.ok(result.evidence.every(item => /^[0-9a-f]{64}$/.test(item.sha256)));
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：完全无法解释时 rejected，原文仍留存', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-broken-'));
  const service = await createService({ dataDir, scenario: 'unparseable' });
  try {
    const { status, result } = await structuredIntake(service);
    assert.equal(status, 201);
    assert.equal(result.state, 'rejected');
    assert.equal(result.records.length, 0);
    assert.ok(result.issues.some(issue => issue.code === 'malformed-alignment-line' && issue.severity === 'fatal'));
    assert.equal(result.blobs.length, 1);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：来源清单外资源与重复请求返回 400', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-bad-request-'));
  const service = await createService({ dataDir });
  try {
    const outside = await structuredIntake(service, { mode: 'structured', sources: ['not-provided.sam'] });
    assert.equal(outside.status, 400);
    const duplicate = await structuredIntake(service, { mode: 'structured', sources: ['alignment.sam', 'alignment.sam'] });
    assert.equal(duplicate.status, 400);
    const empty = await structuredIntake(service, { mode: 'structured', sources: [] });
    assert.equal(empty.status, 400);
    const wrongType = await structuredIntake(service, { mode: 'structured', sources: 'alignment.sam' });
    assert.equal(wrongType.status, 400);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：新实例打开同一 DATA_DIR 仍可查询既有结构化结果', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-reopen-'));
  const service = await createService({ dataDir });
  let receiptId;
  try {
    const { result } = await structuredIntake(service);
    receiptId = result.id;
  } finally {
    await service.close();
  }
  const reopened = await createService({ dataDir });
  try {
    const saved = await (await fetch(`${reopened.baseUrl}/v1/receipts/${receiptId}`)).json();
    assert.equal(saved.mode, 'structured');
    assert.equal(saved.records.length, 3);
    assert.equal(saved.state, 'complete');
  } finally {
    await reopened.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
