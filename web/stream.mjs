export const VIDEO_FPS = 30;
export const VIDEO_BITRATE = 12_000_000;

// Chromium recognizes these optional codec hints; other encoders may ignore them.
// No minimum bitrate is forced, so congestion control can still adapt.
export function qualitySdp(sdp) {
  const h264 = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) H264\/90000\r?$/gmi)].map(match => match[1]));
  return sdp.replace(/^a=fmtp:(\d+) ([^\r\n]*)/gm, (line, id, parameters) => {
    if (!h264.has(id)) return line;
    const retained = parameters.split(';').map(value => value.trim())
      .filter(value => !/^x-google-(start|max|min)-bitrate=/i.test(value));
    return `a=fmtp:${id} ${retained.join(';')};x-google-start-bitrate=6000;x-google-max-bitrate=12000`;
  });
}

export function transportSdp(sdp, transport) {
  if (transport === 'auto') return sdp;
  if (transport !== 'tcp') throw new Error('Invalid camera connection mode.');
  if (!/^a=candidate:\S+\s+\d+\s+tcp\s/im.test(sdp)) {
    throw new Error('go2rtc did not advertise a TCP media connection. Enable TCP port 8555 or set mediaTransport to auto in config.json.');
  }
  return sdp.split(/\r?\n/).filter(line => !/^a=candidate:/i.test(line) ||
    /^a=candidate:\S+\s+\d+\s+tcp\s/i.test(line)).join('\r\n');
}

export function videoStats(report, previous) {
  const outbound = [...report.values()].find(stat => stat.type === 'outbound-rtp' &&
    (stat.kind || stat.mediaType) === 'video' && !stat.isRemote && stat.framesEncoded !== undefined);
  if (!outbound) return null;
  const elapsed = previous?.id === outbound.id ? (outbound.timestamp - previous.timestamp) / 1000 : 0;
  const bitrate = elapsed > 0 ? Math.max(0, ((outbound.bytesSent || 0) - previous.bytesSent) * 8 / elapsed) : null;
  const fps = elapsed > 0 ? Math.max(0, (outbound.framesEncoded - previous.framesEncoded) / elapsed) : outbound.framesPerSecond;
  const codec = report.get(outbound.codecId);
  const transport = report.get(outbound.transportId);
  const pair = report.get(transport?.selectedCandidatePairId) || [...report.values()].find(stat =>
    stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated);
  const candidate = report.get(pair?.remoteCandidateId);
  return { id: outbound.id, timestamp: outbound.timestamp, bytesSent: outbound.bytesSent || 0,
    framesEncoded: outbound.framesEncoded, width: outbound.frameWidth, height: outbound.frameHeight,
    fps, bitrate, codec: codec?.mimeType, protocol: candidate?.protocol,
    limitation: outbound.qualityLimitationReason || 'none',
    remote: [...report.values()].find(stat => stat.type === 'remote-inbound-rtp' && stat.localId === outbound.id) };
}
