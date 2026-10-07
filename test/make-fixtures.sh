#!/usr/bin/env bash
# Generates speech fixtures with ffmpeg's flite voice (needs an ffmpeg built with libflite).
set -euo pipefail
cd "$(dirname "$0")" && mkdir -p fixtures-gen && cd fixtures-gen
python3 - <<'PY'
p = ["Welcome back to the show. Today we are talking about how small teams can ship great products without burning out.",
"The first idea is simple. Write down what you are building before you build it. A short plan saves a long week.",
"Second, test the risky part first. If the hardest piece does not work, nothing else matters.",
"Third, keep your feedback loops tight. Ship something small every day, and watch how people actually use it.",
"Our guest today has built three companies, and each one started with a single spreadsheet and a lot of curiosity.",
"She told us that the best decisions came from talking to customers every single week, not from long meetings.",
"When things went wrong, the team wrote a short note about what happened and what they would change next time.",
"That habit turned mistakes into lessons, and lessons into a playbook that new people could read on day one.",
"Let us talk about hiring. Look for people who finish things. Talent matters, but follow through matters more.",
"Finally, protect your energy. Take real breaks, and remember that a rested team makes better choices."]
t = "  ".join(p * 2)
open("speech.txt", "w").write(t + "  " + t[:900])
PY
ffmpeg -v error -y -f lavfi -i "flite=textfile=speech.txt:voice=slt" -ar 44100 -ac 2 speech.wav
ffmpeg -v error -y -i speech.wav -c:a libmp3lame -b:a 128k speech.mp3
ffmpeg -v error -y -i speech.wav -c:a aac -b:a 128k speech.m4a
for i in $(seq 13); do echo "file 'speech.wav'"; done > list.txt
ffmpeg -v error -y -f concat -safe 0 -i list.txt -c:a libmp3lame -b:a 96k long.mp3
ffmpeg -v error -y -f lavfi -i "gradients=s=1600x1000:c0=0xff7a18:c1=0x2a0845:x0=0:y0=0:x1=1600:y1=1000" -frames:v 1 bg.png
ffmpeg -v error -y -f lavfi -i "color=c=0x334155:s=600x600,drawtext=text='JB':fontsize=260:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" -frames:v 1 logo.png
echo "fixtures ready in $(pwd)"
