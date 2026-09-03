// Generates a small synthetic music library with ffmpeg for local testing.
// Usage: node generate-library.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'library');

const artists = [
  {
    name: 'Sine Language',
    genre: 'Electronic',
    albums: [
      {
        name: 'Pure Tones', year: 2019, format: 'flac', baseFreq: 220,
        tracks: ['Fundamental', 'First Overtone', 'Perfect Fifth', 'Octave Up', 'Resolution'],
      },
      {
        name: 'Harmonic Series', year: 2021, format: 'flac', baseFreq: 330,
        tracks: ['Partial One', 'Partial Two', 'Partial Three', 'Inharmonicity'],
      },
    ],
  },
  {
    name: 'The Null Pointers',
    genre: 'Rock',
    albums: [
      {
        name: 'Segmentation Vault', year: 2020, format: 'mp3', baseFreq: 196,
        tracks: ['Dangling Reference', 'Use After Free', 'Core Dumped', 'Guard Page'],
      },
    ],
  },
  {
    name: 'Stoat Quartet',
    genre: 'Classical',
    albums: [
      {
        name: 'Woodland Suite', year: 2022, format: 'flac', baseFreq: 262,
        tracks: ['Riverbank Prelude', 'Burrow Dance', 'Winter Coat', 'Pine Canopy', 'Den at Dusk'],
      },
    ],
  },
];

let count = 0;
for (const artist of artists) {
  for (const album of artist.albums) {
    const dir = join(root, artist.name, album.name);
    mkdirSync(dir, { recursive: true });
    album.tracks.forEach((title, i) => {
      const n = i + 1;
      const ext = album.format;
      const file = join(dir, `${String(n).padStart(2, '0')} - ${title}.${ext}`);
      if (existsSync(file)) return;
      const freq = album.baseFreq * (1 + i * 0.25);
      const dur = 12 + (i % 3) * 3;
      const codecArgs = ext === 'mp3' ? ['-codec:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3'] : [];
      const args = [
        '-y', '-f', 'lavfi',
        '-i', `sine=frequency=${freq}:duration=${dur}`,
        '-af', `tremolo=f=${1 + i * 0.5}:d=0.6,volume=0.25`,
        '-metadata', `title=${title}`,
        '-metadata', `artist=${artist.name}`,
        '-metadata', `album_artist=${artist.name}`,
        '-metadata', `album=${album.name}`,
        '-metadata', `track=${n}/${album.tracks.length}`,
        '-metadata', `date=${album.year}`,
        '-metadata', `genre=${artist.genre}`,
        ...codecArgs,
        file,
      ];
      const res = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (res.status !== 0) {
        console.error(`ffmpeg failed for ${file}:\n${res.stderr}`);
        process.exit(1);
      }
      count++;
    });
  }
}
console.log(`Generated ${count} new tracks under ${root}`);
