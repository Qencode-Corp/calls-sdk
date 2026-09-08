import { describe, it, expect } from 'vitest';
import { DeltaTracker, collectRecv, collectSend, pickSelectedPair, transportOf, estimateLatency, QualityTracker, absCaptureLatency } from '../src/stats';
import { report } from './helpers';

const pairReport = (local: Record<string, unknown>, rtt = 0.02) => [
  { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
  { id: 'P', type: 'candidate-pair', localCandidateId: 'L', currentRoundTripTime: rtt, nominated: true, state: 'succeeded' },
  { id: 'L', type: 'local-candidate', ...local },
  { id: 'C', type: 'codec', mimeType: 'video/H264' },
];

describe('transport', () => {
  it('classifies udp, tcp and relay pairs and reads rtt in ms', () => {
    const r = report(pairReport({ candidateType: 'srflx', protocol: 'udp' }, 0.0181));
    expect(transportOf(r, pickSelectedPair(r))).toEqual({ transport: 'udp', candidateType: 'srflx', rttMs: 18.1 });
    const relay = report(pairReport({ candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' }));
    expect(transportOf(relay, pickSelectedPair(relay)).transport).toBe('relay-tcp');
    const tcp = report(pairReport({ candidateType: 'host', protocol: 'tcp' }));
    expect(transportOf(tcp, pickSelectedPair(tcp)).transport).toBe('tcp');
  });
  it('falls back to the nominated succeeded pair when transport stats are missing', () => {
    const r = report([{ id: 'P', type: 'candidate-pair', localCandidateId: 'L', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05 }, { id: 'L', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }]);
    expect(transportOf(r, pickSelectedPair(r)).rttMs).toBe(50);
    expect(transportOf(r, null)).toEqual({ transport: null, candidateType: null, rttMs: null });
  });
});

describe('collectRecv', () => {
  const inbound = (t: number) => ({ id: 'I', type: 'inbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 58, frameWidth: 960, frameHeight: 540, jitter: 0.004,
    jitterBufferDelay: 2.0 * t, jitterBufferEmittedCount: 50 * t, totalDecodeTime: 0.05 * t, framesDecoded: 50 * t, totalProcessingDelay: 2.5 * t,
    packetsLost: 1 * t, packetsReceived: 99 * t, bytesReceived: 125_000 * t, freezeCount: 1 * t, totalFreezesDuration: 0.2 * t });
  it('returns static fields on the first poll and deltas from the second', () => {
    const tr = new DeltaTracker();
    const first = collectRecv(report([...pairReport({ candidateType: 'srflx', protocol: 'udp' }), inbound(1)]), tr, 1000);
    expect(first.fps).toBe(58); expect(first.codec).toBe('H264'); expect(first.width).toBe(960); expect(first.jitterMs).toBe(4);
    expect(first.jitterBufferMs).toBeNull(); expect(first.kbps).toBeNull();
    const second = collectRecv(report([...pairReport({ candidateType: 'srflx', protocol: 'udp' }), inbound(2)]), tr, 2000);
    expect(second.jitterBufferMs).toBe(40);      // 2.0 s / 50 frames
    expect(second.decodeMs).toBe(1);             // 0.05 s / 50 frames
    expect(second.processingMs).toBe(50);        // 2.5 s / 50 frames
    expect(first.absCaptureLatencyMs).toBeNull(); // filled by the call from the receiver's sync sources
    expect(second.lossPct).toBe(1);              // 1 / (1 + 99)
    expect(second.kbps).toBe(1000);              // 125 000 B * 8 / 1 s
    expect(second.freezes).toBe(1); expect(second.freezeMs).toBe(200);
    expect(second.transport).toBe('udp'); expect(second.rttMs).toBe(20);
  });
  it('handles a report without video inbound', () => {
    const r = collectRecv(report(pairReport({ candidateType: 'host', protocol: 'udp' })), new DeltaTracker(), 1);
    expect(r.fps).toBeNull(); expect(r.rttMs).toBe(20);
  });
});

describe('collectSend', () => {
  const outbound = (t: number) => ({ id: 'O', type: 'outbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 60, frameWidth: 960, frameHeight: 540, qualityLimitationReason: 'none', totalEncodeTime: 0.06 * t, framesEncoded: 60 * t, bytesSent: 150_000 * t, targetBitrate: 1_150_000 });
  it('computes encode time and bitrate and reads remote loss', () => {
    const tr = new DeltaTracker();
    collectSend(report([...pairReport({ candidateType: 'srflx', protocol: 'udp' }), outbound(1)]), tr, 1000);
    const s = collectSend(report([...pairReport({ candidateType: 'srflx', protocol: 'udp' }), outbound(2), { id: 'R', type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.02 }]), tr, 2000);
    expect(s.encodeMs).toBe(1); expect(s.kbps).toBe(1200); expect(s.lossPct).toBe(2); expect(s.qualityLimitation).toBe('none'); expect(s.codec).toBe('H264');
    expect(s.targetKbps).toBe(1150);
  });
});

describe('absCaptureLatency', () => {
  const NTP = 2_208_988_800_000;
  it('subtracts the sender capture time and the sample age, with an epoch or a time-origin timestamp', () => {
    const now = 1_800_000_000_000, perf = 5000;
    // captured 120 ms ago on the sender clock (offset already folded in), sample delivered 20 ms ago
    const capture = now + NTP - 120;
    expect(absCaptureLatency([{ timestamp: now - 20, captureTimestamp: capture - 7, senderCaptureTimeOffset: 7 }], now, perf)).toBe(100);
    expect(absCaptureLatency([{ timestamp: perf - 20, captureTimestamp: capture, senderCaptureTimeOffset: 0 }], now, perf)).toBe(100);
  });
  it('is null without the extension or without sources', () => {
    expect(absCaptureLatency([{ timestamp: 1 }], 2, 3)).toBeNull();
    expect(absCaptureLatency([], 2, 3)).toBeNull();
    expect(absCaptureLatency(undefined, 2, 3)).toBeNull();
  });
});

describe('estimateLatency', () => {
  it('adds the pieces and assumes symmetry until the peer reports', () => {
    expect(estimateLatency({ rttMs: 20, peerRttMs: null, jitterBufferMs: 40, decodeMs: 1, fps: 50 })).toBe(81); // 10 + 10 + 40 + 1 + 20
    expect(estimateLatency({ rttMs: 20, peerRttMs: 60, jitterBufferMs: 40, decodeMs: 1, fps: 50 })).toBe(101);
    expect(estimateLatency({ rttMs: 20, peerRttMs: 60, jitterBufferMs: 40, decodeMs: null, fps: null })).toBe(113); // frame defaults to 33
    expect(estimateLatency({ rttMs: null, peerRttMs: 60, jitterBufferMs: 40, decodeMs: 1, fps: 50 })).toBeNull();
    expect(estimateLatency({ rttMs: 20, peerRttMs: 60, jitterBufferMs: null, decodeMs: 1, fps: 50 })).toBeNull();
  });
});

describe('QualityTracker', () => {
  const good = { lossPct: 0, jitterBufferMs: 40, freezes: 0, rttMs: 30 };
  const poor = { lossPct: 5, jitterBufferMs: 40, freezes: 0, rttMs: 30 };
  const fair = { lossPct: 0, jitterBufferMs: 150, freezes: 0, rttMs: 30 };
  it('classifies', () => {
    expect(QualityTracker.classify(good)).toBe('good'); expect(QualityTracker.classify(poor)).toBe('poor'); expect(QualityTracker.classify(fair)).toBe('fair');
    expect(QualityTracker.classify({ ...good, freezes: 1 })).toBe('poor'); expect(QualityTracker.classify({ ...good, rttMs: 400 })).toBe('fair');
  });
  it('needs two consecutive polls to change level', () => {
    const q = new QualityTracker();
    expect(q.update(poor)).toBe('good');
    expect(q.update(good)).toBe('good');      // a single bad second did not flip it
    expect(q.update(poor)).toBe('good');
    expect(q.update(poor)).toBe('poor');
    expect(q.update(fair)).toBe('poor');
    expect(q.update(fair)).toBe('fair');
    expect(q.update(good)).toBe('fair');
    expect(q.update(good)).toBe('good');
  });
});
