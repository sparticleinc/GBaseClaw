---
name: tts
description: "Text-to-speech using Qwen3-TTS. Convert any text to natural-sounding audio in Chinese, English, Japanese, Korean, and more. Use when: (1) user asks to read text aloud, (2) generate speech/audio from text, (3) TTS or voice synthesis requests."
metadata: { "openclaw": { "emoji": "🔊" } }
---

# Text-to-Speech (Qwen3-TTS)

Convert text to natural-sounding speech audio. Supports 10 languages with multiple voices.

## How to Use

Generate audio by calling the TTS API, then return an HTML audio player.

### Step 1: Call the API

```bash
curl -s -X POST "http://172.18.0.1:8099/tts" \
  -H "Content-Type: application/json" \
  -d '{"text": "YOUR TEXT HERE", "language": "Chinese", "speaker": "Vivian"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('url','ERROR: '+str(d)))"
```

### Step 2: Return audio player to user

After getting the audio URL from the API response, output an HTML audio player:

```markdown
🔊 Audio generated (X.Xs, speaker: NAME)

<audio controls src="/tts/audio/FILENAME.wav">Your browser does not support audio.</audio>
```

The `/tts/audio/FILENAME.wav` path is served by nginx and accessible in the browser.

## Available Speakers

| Speaker  | Language | Description               |
| -------- | -------- | ------------------------- |
| Vivian   | Chinese  | Female, young, warm voice |
| uncle_fu | Chinese  | Male, middle-aged         |
| Ryan     | English  | Male, young, clear        |
| Serena   | English  | Female, young             |
| Aiden    | English  | Male, young               |
| Dylan    | English  | Male, young               |
| ono_anna | Japanese | Female, young             |
| Sohee    | Korean   | Female, young             |
| Eric     | German   | Male, young               |

## Language Options

`Chinese`, `English`, `Japanese`, `Korean`, `German`, `French`, `Russian`, `Portuguese`, `Spanish`, `Italian`, or `Auto` (auto-detect).

## Instruction Control (Optional)

Add emotion or style via the `instruct` field:

```bash
curl -s -X POST "http://172.18.0.1:8099/tts" \
  -H "Content-Type: application/json" \
  -d '{"text": "TEXT", "language": "Chinese", "speaker": "Vivian", "instruct": "用开心的语气说"}'
```

Example instructions:

- `"用特别开心的语气说"` — Happy tone (Chinese)
- `"Speak slowly and calmly"` — Calm pace (English)
- `"用严肃的语气"` — Serious tone (Chinese)

## Notes

- Max text length: 2000 characters
- Generation time: ~7-9 seconds for ~6 seconds of audio
- Audio format: WAV, 24kHz
- Audio files are auto-cleaned (last 100 kept)
