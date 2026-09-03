'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sampleRate = 44100;
const durationSeconds = 3.1;
const sampleCount = Math.round(sampleRate * durationSeconds);
const dataBytes = sampleCount * 2;
const wav = Buffer.alloc(44 + dataBytes);

wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataBytes, 40);

let phase = 0;
for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const sirenFrequency = 820 + 330 * Math.sin(2 * Math.PI * 1.45 * time);
  phase += 2 * Math.PI * sirenFrequency / sampleRate;
  const fundamental = Math.sin(phase);
  const harmonic = 0.28 * Math.sin(phase * 2.01) + 0.14 * Math.sin(phase * 3.03);
  const pulsePosition = (time % 0.38) / 0.38;
  const pulseGate = pulsePosition < 0.74 ? 1 : 0.18;
  const edgeFade = Math.min(1, time / 0.012, (durationSeconds - time) / 0.018);
  const sample = Math.max(-1, Math.min(1, (fundamental + harmonic) * 0.68 * pulseGate * edgeFade));
  wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
}

const outputDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'alarm.wav');
fs.writeFileSync(outputPath, wav);
console.log(`Generated ${outputPath} (${wav.length} bytes)`);
