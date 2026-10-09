import {createReadStream, type ReadStream} from 'node:fs';
import {createInterface, type Interface} from 'node:readline';
import type {ProfileObservation} from './flame-plot';

export interface ObservationSelection { package: string; feature: string; version: string; }

/** Read the complete report, including valid JSON with arbitrary whitespace. */
export function readProfileObservations(source: string, selected: readonly ObservationSelection[]): Promise<ProfileObservation[]> {
  return readProfileObservationStream(createReadStream(source, {encoding:'utf8'}), selected);
}

/** Own and close the real file stream on success, parsing failure or I/O failure. */
export async function readProfileObservationStream(stream: ReadStream, selected: readonly ObservationSelection[]): Promise<ProfileObservation[]> {
  const closed = new Promise<void>(resolve => {if (stream.closed) resolve(); else stream.once('close', resolve);});
  let lines: Interface | undefined, readError: Error | undefined;
  const onError = (error: Error): void => {readError ??= error; lines?.close();};
  stream.on('error', onError);
  try {
    const keys = new Set(selected.map(run => JSON.stringify([run.package, run.feature, run.version])));
    const result: ProfileObservation[] = [];
    lines = createInterface({input:stream, crlfDelay:Infinity});
    lines.on('error', onError);
    for await (const line of lines) {
      let record: unknown;
      try {record = JSON.parse(line);} catch {continue; /* The raw report retains malformed diagnostic lines. */}
      if (!record || typeof record !== 'object' || !('record_type' in record) || record.record_type !== 'observation') continue;
      const observation = record as unknown as ProfileObservation;
      const attributes = observation.attributes;
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) continue;
      if (keys.has(JSON.stringify([attributes.package, attributes.feature, observation.target_id])) ||
          keys.has(JSON.stringify([attributes.package, attributes.feature, attributes.version]))) result.push(observation);
    }
    if (readError) throw readError;
    return result;
  } finally {
    lines?.close();
    stream.destroy();
    await closed;
    lines?.off('error', onError);
    stream.off('error', onError);
  }
}
