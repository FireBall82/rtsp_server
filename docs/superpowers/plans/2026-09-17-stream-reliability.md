# Camera quality and stream recovery

Direct fixes authorized by the user's request. Retain go2rtc as the runtime backend and video-only consent. Implement inline.

1. Prefer reliable ICE TCP for the publishing connection (configurable auto/UDP mode for TURN/browser compatibility). Validate that the answer includes TCP candidates and leave codec/security attributes intact. RTSP output already requires TCP in pinned go2rtc.
2. Increase the encoder ceiling to 12 Mbps and request a 6 Mbps starting bitrate through supported Chromium codec hints without imposing a minimum. Prioritize image detail. Show measured encoded resolution/fps/bitrate, not just capture size.
3. Preserve the camera on temporary disconnection, rebuild WHIP peers with bounded retry/backoff on sustained disconnection or failure, and detect outbound frame stalls through stats. Stop cancels retries and late sessions; don't use unsupported WHIP PATCH/ICE restart.
4. Add a digital-renderer watchdog that follows new media timestamps if video-frame callbacks stop arriving. Stop cleans up both scheduling mechanisms; don't redraw duplicate frames.
5. Add regression tests for disconnect/reconnect/cancellation, stats and watchdog. Verify browser sender switching and prolonged moving video. Add a synthetic Go/Pion H.264 WHIP-to-RTSP test with real decoded frame progress to cover the previously untested media bridge; no physical camera access.
6. Update operating instructions and evidence. Report remaining physical-device validation limits.
