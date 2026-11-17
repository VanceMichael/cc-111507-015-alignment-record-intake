// 结构化 SAM 收件：忠实接收来源比对记录，按来源记录逐条保存，不按 QNAME 去重。
// 配对关系闭合只基于本次已采到的记录；来源未提供的对端记为 unresolved，
// 不补记录、不重新比对、不判断变异。

import { createHash } from 'node:crypto';
import { parseSam } from './sam-parse.mjs';
import { receiveBytes } from './http-client.mjs';

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pairRole(flag) {
  if (flag.firstInPair && !flag.secondInPair) return 'first';
  if (flag.secondInPair && !flag.firstInPair) return 'last';
  return 'unmarked';
}

// 同名读组隔离：关系索引键含读组标识；未声明 RG 的记录归入空读组命名空间。
function relationKey(record) {
  return `${record.qname}\u0000${record.readGroup?.id ?? ''}`;
}

function chooseCounterpart(candidates, role, recordIndex) {
  const want = role === 'first' ? 'last' : 'first';
  // 主比对的模板对端只能是另一条主比对；次级/补充片段不参与主比对配对，
  // 它们自己的对端则回到主比对上解析。无首末位的记录只能与同样无首末位的主比对闭合。
  let pool = candidates.filter(item => item.isPrimary);
  if (role === 'unmarked') {
    pool = pool.filter(item => pairRole(item.flag) === 'unmarked');
  } else {
    pool = pool.filter(item => pairRole(item.flag) === want);
  }
  if (pool.length === 0) return { counterpart: null, reason: 'mate-not-provided' };
  if (pool.length === 1) return { counterpart: pool[0], reason: null };
  // 并列时按来源记录顺序取最早一条，其余歧义显式保留为未闭合，而不是猜测。
  const ordered = pool.slice().sort((a, b) => recordIndex.get(a) - recordIndex.get(b));
  if (recordIndex.get(ordered[1]) === recordIndex.get(ordered[0])) {
    return { counterpart: ordered[0], reason: null };
  }
  return { counterpart: null, reason: 'mate-ambiguous' };
}

export async function runStructuredIntake({ sources, descriptor, sourceBase, store }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { httpStatus: 400, error: 'sources 必须是非空来源资源名数组' };
  }
  const seen = new Set();
  for (const name of sources) {
    if (typeof name !== 'string' || name.length === 0 || !descriptor.resources.includes(name)) {
      return { httpStatus: 400, error: '请求的来源资源不在来源清单内' };
    }
    if (seen.has(name)) {
      return { httpStatus: 400, error: '来源资源在同一次收件中重复请求' };
    }
    seen.add(name);
  }

  const blobs = [];
  const evidence = [];
  const files = [];
  const fetchErrors = [];
  for (const name of sources) {
    try {
      const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(name)}`);
      const blob = await store.blob(source.bytes);
      blobs.push(blob);
      evidence.push({
        source: name,
        sha256: digestOf(source.bytes),
        etag: source.etag,
        bytes: source.bytes.length,
        basis: '来源字节经本机来源网关逐字节领取，摘要按收件原文计算',
      });
      files.push({ name: name, bytes: source.bytes, etag: source.etag });
    } catch (error) {
      fetchErrors.push({ code: 'source-unavailable', severity: 'fatal', source: name, line: null, message: `来源资源领取失败：${error.message}` });
      evidence.push({ source: name, sha256: null, etag: null, bytes: 0, basis: '来源资源领取失败，未取得字节' });
    }
  }

  const parsedFiles = files.map(file => parseSam(file.bytes, file.name));
  const issues = [...fetchErrors];
  const records = [];
  const recordIndex = new Map();
  const relationIndex = new Map();
  for (const parsed of parsedFiles) {
    issues.push(...parsed.issues);
    for (const record of parsed.records) {
      recordIndex.set(record, records.length);
      records.push(record);
      const key = relationKey(record);
      if (!relationIndex.has(key)) relationIndex.set(key, []);
      relationIndex.get(key).push(record);
    }
  }

  // 关系闭合：不依赖文件排序，允许对端在另一个交付文件中。
  let resolvedPairs = 0;
  const unresolvedLinks = [];
  for (const record of records) {
    if (!record.flag.paired) {
      record.pairing.relationship = {
        status: 'not-applicable', counterpart: null, counterpartSource: null, reason: 'segment-not-paired',
      };
      continue;
    }
    if (record.flag.mateUnmapped) {
      record.pairing.relationship = {
        status: 'resolved', counterpart: null, counterpartSource: null, reason: 'mate-unmapped-by-flag',
      };
      resolvedPairs += 1;
      continue;
    }
    const siblings = (relationIndex.get(relationKey(record)) || []).filter(item => item !== record);
    const { counterpart, reason: unresolvedReason } = chooseCounterpart(siblings, pairRole(record.flag), recordIndex);
    if (counterpart) {
      record.pairing.relationship = {
        status: 'resolved',
        counterpart: counterpart.recordId,
        counterpartSource: counterpart.source,
        reason: siblings.length > 1 ? 'resolved-with-alternative-segments-present' : 'resolved',
      };
      resolvedPairs += 1;
    } else {
      // 没有符合角色的主比对候选（对端未交付，或只有次级/补充片段）属于来源尚未提供；
      // 存在多个并列候选才是来源内部歧义。两种情况都不替合作方猜测。
      record.pairing.relationship = {
        status: 'unresolved', counterpart: null, counterpartSource: null, reason: unresolvedReason,
      };
      unresolvedLinks.push({
        record: record.recordId, source: record.source, qname: record.qname,
        readGroup: record.readGroup?.id ?? null, reason: unresolvedReason,
      });
    }
  }

  const fatalCount = issues.filter(issue => issue.severity === 'fatal').length;
  let state;
  if (records.length === 0 || fatalCount > 0) {
    state = 'rejected';
  } else if (issues.length > 0 || unresolvedLinks.length > 0) {
    state = 'partial';
  } else {
    state = 'complete';
  }

  const coverage = {
    structured: true,
    format: 'SAM 1.6 文本',
    files: parsedFiles.map(parsed => ({
      source: parsed.source,
      headers: {
        hd: parsed.headers.hd?.fields ?? null,
        sequenceDictionary: parsed.headers.sq.map(sq => ({ name: sq.name, length: sq.length, line: sq.line })),
        readGroups: parsed.headers.rg.map(rg => ({ id: rg.id, fields: rg.fields, line: rg.line })),
        otherHeaderRecords: parsed.headers.other,
      },
      referenceCount: parsed.referenceNames.length,
      readGroupCount: parsed.readGroupIds.length,
      recordCount: parsed.records.length,
      primaryCount: parsed.records.filter(record => record.isPrimary).length,
      secondaryCount: parsed.records.filter(record => record.isSecondary).length,
      supplementaryCount: parsed.records.filter(record => record.isSupplementary).length,
      unmappedCount: parsed.records.filter(record => record.unmapped).length,
    })),
    totals: {
      records: records.length,
      primary: records.filter(record => record.isPrimary).length,
      secondary: records.filter(record => record.isSecondary).length,
      supplementary: records.filter(record => record.isSupplementary).length,
      unmapped: records.filter(record => record.unmapped).length,
    },
    relationships: {
      resolved: resolvedPairs,
      unresolved: unresolvedLinks.length,
      notApplicable: records.filter(record => record.pairing.relationship.status === 'not-applicable').length,
      unresolvedLinks,
      scope: '关系状态仅基于本次已采到的来源记录；unresolved 表示来源尚未提供可闭合的对端，不是读段缺失判定',
    },
    sourcesRequested: sources,
    sourcesFetched: files.map(file => file.name),
    completeness: state,
    gaps: unresolvedLinks.map(link => `来源尚未提供 ${link.qname}（读组 ${link.readGroup ?? '∅'}）的可闭合对端：${link.reason}`),
  };

  const receipt = await store.save({
    state,
    mode: 'structured',
    product: descriptor.product,
    source: sources.join(','),
    sourceVersion: files.map(file => file.etag).filter(Boolean).join(',') || null,
    blobs,
    records,
    issues,
    coverage,
    evidence,
  });
  return { receipt, httpStatus: 201 };
}
