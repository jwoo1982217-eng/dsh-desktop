import {deflateRawSync} from 'node:zlib';
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;};
/** Small bounded ZIP, built from generated diagnostic facts only; no filesystem traversal. */
export function createZip(files){
 if(!Array.isArray(files)||!files.length||files.length>32)throw Error('Invalid diagnostic archive');
 const names=new Set(),local=[],central=[];let offset=0,total=0;
 for(const file of files){
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(file.name)||names.has(file.name))throw Error('Invalid diagnostic archive entry');names.add(file.name);
  const bytes=Buffer.from(file.bytes),name=Buffer.from(file.name),packed=deflateRawSync(bytes),crc=crc32(bytes);
  total+=bytes.length;if(total>2*1024*1024)throw Error('Diagnostic archive exceeds its limit');
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
  local.push(header,name,packed);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt16LE(0x21,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
  central.push(record,name);offset+=header.length+name.length+packed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
