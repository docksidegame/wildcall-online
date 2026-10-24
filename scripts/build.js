// Builds public/index.html from client/wildcall.src.html (same source as the offline game).
import fs from 'fs';import path from 'path';import {fileURLToPath} from 'url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src=fs.readFileSync(path.join(root,'client/wildcall.src.html'),'utf8');
const ids=fs.readdirSync(path.join(root,'public/art')).filter(f=>f.endsWith('.webp')).map(f=>f.slice(0,-5)).sort();
let s=src.replace('/*IMGLIST*/[]',JSON.stringify(ids));
const cut=s.indexOf('</style>')+'</style>'.length;
const head=s.slice(0,cut),body=s.slice(cut);
const out=`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n<script>window.WC_ONLINE=true</script>\n</head>\n<body>${body}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(root,'public/index.html'),out);
console.log('built public/index.html',(out.length/1024).toFixed(0)+' KB,',ids.length,'art files');
