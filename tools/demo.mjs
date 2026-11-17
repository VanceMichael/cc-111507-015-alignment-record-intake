import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
const dataDir = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const service = await createService({ dataDir, scenario: 'split-mates' });
try {
  const source = await (await fetch(`${service.baseUrl}/v1/source`)).json();
  console.log('来源资料', JSON.stringify(source, null, 2));
  const raw = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'raw' }) });
  console.log('原始收件', JSON.stringify(await raw.json(), null, 2));
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'structured', sources: ['split-r1.sam', 'split-r2.sam'] }),
  });
  const receipt = await response.json();
  console.log('结构化收件状态', receipt.state);
  console.log('结构化记录关系', JSON.stringify(receipt.records.map(record => ({
    recordId: record.recordId,
    qname: record.qname,
    role: record.flag.firstInPair ? 'first' : (record.flag.secondInPair ? 'last' : 'unmarked'),
    primary: record.isPrimary,
    unmapped: record.unmapped,
    relationship: record.pairing.relationship,
  })), null, 2));
  console.log('覆盖范围', JSON.stringify(receipt.coverage.relationships, null, 2));
  console.log('收件目录', JSON.stringify(await (await fetch(`${service.baseUrl}/v1/receipts`)).json().then(items => items.map(item => ({ id: item.id, mode: item.mode, state: item.state }))), null, 2));
} finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
