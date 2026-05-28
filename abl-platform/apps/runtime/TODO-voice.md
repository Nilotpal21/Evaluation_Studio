# Voice Streaming - Remaining Work

## Current Implementation

- Direct browser-to-server WebSocket voice streaming (no Twilio for web)
- Deepgram STT with linear16 PCM @ 16kHz
- ElevenLabs TTS with mp3_22050_32 streaming
- Basic barge-in support (user can interrupt agent)
- Connection pre-warming (LLM + ElevenLabs)

## TODO

### Latency Improvements

- [ ] Investigate end-to-end latency (target: < 500ms from speech end to TTS start)
- [ ] Profile each stage: STT transcription, LLM processing, TTS synthesis
- [ ] Consider sentence-level streaming (stream TTS as agent generates response)
- [ ] Evaluate faster LLM models or response caching for common queries
- [ ] Optimize audio buffer sizes for lower latency

### Barge-in Refinements

- [ ] Tune silence detection threshold (currently 1200ms)
- [ ] Add audio energy detection to distinguish speech from background noise
- [ ] Implement proper state machine for voice states (listening → processing → speaking)
- [ ] Handle edge case: user speaks while TTS is generating (cancel in-flight TTS)

### Speech Timeout

- [ ] Make silence threshold configurable per project
- [ ] Add explicit "end of utterance" detection using Deepgram's endpointing
- [ ] Consider VAD (Voice Activity Detection) for more accurate speech boundaries
- [ ] Handle long pauses mid-sentence gracefully

### Twilio Integration

- [ ] Complete Twilio media streams handler (`twilio-media-handler.ts`)
- [ ] Test with actual Twilio phone calls
- [ ] Handle mulaw 8kHz audio format for Twilio
- [ ] Implement call control (hold, transfer, disconnect)
- [ ] Add DTMF tone detection

### Audio Quality

- [ ] Add echo cancellation
- [ ] Implement noise suppression
- [ ] Test with various microphone qualities
- [ ] Handle audio device switching mid-session

### Error Handling

- [ ] Graceful recovery from Deepgram disconnections
- [ ] Retry logic for ElevenLabs API failures
- [ ] Timeout handling for unresponsive LLM
- [ ] User feedback for connection issues

### Testing

- [ ] Unit tests for voice pipeline
- [ ] Integration tests for STT → LLM → TTS flow
- [ ] Load testing for concurrent voice sessions
- [ ] Browser compatibility testing (Chrome, Firefox, Safari)

### Documentation

- [ ] Document voice architecture
- [ ] Add sequence diagrams for voice flow
- [ ] Document configuration options
- [ ] Add troubleshooting guide
