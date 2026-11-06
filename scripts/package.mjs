import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {deflateRawSync} from 'node:zlib';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const files = ['manifest.json', 'bootstrap.js', 'glyph-metrics.js'];
const table = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ table[(crc ^ value) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const locals = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file), data = await readFile('addon/' + file);
  const packed = deflateRawSync(data, {level: 9}), crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(0x5021, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  locals.push(header, name, packed);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10);
  directory.writeUInt16LE(0x5021, 14); directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
  central.push(directory, name); offset += header.length + name.length + packed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
await mkdir('dist', {recursive: true});
await writeFile('dist/ADHD-Reader-Zotero.xpi', Buffer.concat([...locals, directory, end]));
console.log('Packaged dist/ADHD-Reader-Zotero.xpi');
