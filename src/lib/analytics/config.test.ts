import { describe, expect, it } from 'vitest';
import { INGEST_DEFAULTS, IngestConfigError, parseIngestConfig } from './config';

describe('parseIngestConfig', () => {
  it('defaults: on in the server, 1000 per batch, 3 days of minutes, 90 of hours, 200 tail rows', () => {
    expect(parseIngestConfig({})).toEqual(INGEST_DEFAULTS);
    expect(INGEST_DEFAULTS).toEqual({
      inServer: true,
      batchSize: 1000,
      minuteRetentionDays: 3,
      hourRetentionDays: 90,
      tailRows: 200,
    });
  });

  it('reads every variable', () => {
    expect(
      parseIngestConfig({
        G2_ANALYTICS_INGEST: 'OFF',
        G2_ANALYTICS_BATCH: '250',
        G2_ANALYTICS_MINUTE_RETENTION_DAYS: '7',
        G2_ANALYTICS_HOUR_RETENTION_DAYS: '400',
        G2_ANALYTICS_TAIL_ROWS: '0',
      }),
    ).toEqual({
      inServer: false,
      batchSize: 250,
      minuteRetentionDays: 7,
      hourRetentionDays: 400,
      tailRows: 0,
    });
    expect(parseIngestConfig({ G2_ANALYTICS_INGEST: 'on' }).inServer).toBe(true);
  });

  it('reports every bad variable at once', () => {
    let error: unknown;
    try {
      parseIngestConfig({
        G2_ANALYTICS_INGEST: 'sometimes',
        G2_ANALYTICS_BATCH: '0',
        G2_ANALYTICS_MINUTE_RETENTION_DAYS: '1.5',
        G2_ANALYTICS_HOUR_RETENTION_DAYS: '-3',
        G2_ANALYTICS_TAIL_ROWS: '5000',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IngestConfigError);
    expect((error as IngestConfigError).problems).toEqual([
      'G2_ANALYTICS_INGEST must be on or off',
      'G2_ANALYTICS_BATCH must be a whole number from 1 to 10000',
      'G2_ANALYTICS_MINUTE_RETENTION_DAYS must be a whole number from 1 to 90',
      'G2_ANALYTICS_HOUR_RETENTION_DAYS must be a whole number from 1 to 3650',
      'G2_ANALYTICS_TAIL_ROWS must be a whole number from 0 to 1000',
    ]);
  });
});
