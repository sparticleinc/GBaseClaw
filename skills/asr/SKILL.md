---
name: asr
description: "Speech-to-text using Qwen3-ASR. Transcribe audio files to text in 52 languages. Use when: (1) user uploads audio/voice file for transcription, (2) speech recognition request, (3) convert audio to text, (4) transcribe meeting recording."
metadata: { "openclaw": { "emoji": "🎙️" } }
---

# Speech-to-Text (Qwen3-ASR)

Transcribe audio files to text. Supports 52 languages and dialects including Chinese, English, Japanese, Korean, and more.

## How to Use

### Step 1: Upload audio and call ASR API

```bash
curl -s -X POST "http://172.18.0.1:8099/asr" \
  -F "file=@/path/to/audio.wav" \
  -F "language=Auto"
```

Response:

```json
{ "ok": true, "text": "transcribed text here", "language": "Chinese", "transcription_time": 2.1 }
```

### Step 2: Return the transcription to the user

```
🎙️ 语音识别完成（语言: LANGUAGE，耗时: X.Xs）

**识别结果：**
> TRANSCRIBED TEXT
```

## Supported Audio Formats

WAV, MP3, FLAC, OGG, M4A — most common audio formats.

## Supported Languages (52)

Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Russian, Italian, Arabic, Thai, Vietnamese, Indonesian, Turkish, Hindi, Cantonese, and 35 more languages and Chinese dialects.

## Combined with TTS

You can chain ASR → process → TTS:

1. User uploads audio → ASR transcribes to text
2. Process/translate the text
3. Use TTS skill to generate speech output

## Notes

- Max audio duration: depends on GPU memory (~5 minutes recommended)
- Speed: ~2-7 seconds per audio clip
- Language auto-detection when language=Auto
