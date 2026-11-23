'use strict';
// Minimal ZIP writer with DEFLATE, using Node built-ins only.
const zlib=require('node:zlib');
const table=Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=n&1?(n>>>1)^0xedb88320:n>>>1;return n>>>0;});
function crc32(b){let n=0xffffffff;for(const v of b)n=table[(n^v)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function makeZip(files){
  const locals=[],centrals=[];let offset=0,count=0;
  for(const [path,value] of Object.entries(files)){
    if(!/^[a-zA-Z0-9_.\/-]+$/.test(path)||path.startsWith('/')||path.includes('..'))throw Error('Unsafe ZIP path');
    const name=Buffer.from(path,'utf8'),raw=Buffer.isBuffer(value)?value:Buffer.from(String(value),'utf8');
    const encoded=zlib.deflateRawSync(raw),crc=crc32(raw);
    if(name.length>65535||raw.length>50*1024*1024)throw Error('ZIP file too large');
    const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);
    head.writeUInt16LE(0x0800,6);head.writeUInt16LE(8,8);head.writeUInt32LE(crc,14);
    head.writeUInt32LE(encoded.length,18);head.writeUInt32LE(raw.length,22);head.writeUInt16LE(name.length,26);
    locals.push(head,name,encoded);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(8,10);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(encoded.length,20);central.writeUInt32LE(raw.length,24);
    central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    centrals.push(central,name);offset+=head.length+name.length+encoded.length;count++;
  }
  if(count>65535)throw Error('ZIP too many files');
  const cent=Buffer.concat(centrals);const tail=Buffer.alloc(22);tail.writeUInt32LE(0x06054b50,0);
  tail.writeUInt16LE(count,8);tail.writeUInt16LE(count,10);
  tail.writeUInt32LE(cent.length,12);tail.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cent,tail]);
}
module.exports={makeZip};
