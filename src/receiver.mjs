import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { parseSam } from './sam.mjs';

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'raw') {
    const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
    const blob = await store.blob(source.bytes);
    const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
      source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
      records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
    return { receipt };
  }
  if (input.mode === 'structured') {
    const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
    const blob = await store.blob(source.bytes);
    const parsed = parseSam(source.bytes, { source: descriptor.entry });
    const receipt = await store.save({ state: parsed.state, mode: 'structured', product: descriptor.product,
      source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
      records: parsed.records, issues: parsed.issues, coverage: parsed.coverage,
      evidence: { ...parsed.evidence, etag: source.etag } });
    return { receipt };
  }
  return { httpStatus: 501, error: '接收方式未开放' };
}
