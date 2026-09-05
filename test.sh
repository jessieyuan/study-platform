#!/bin/bash
set -e
cd "$(dirname "$0")"
NODE=/usr/local/bin/node
PASS=0; FAIL=0
ok() { echo "✅ $1"; PASS=$((PASS+1)); }
no() { echo "❌ $1"; FAIL=$((FAIL+1)); }
echo "========== 自动测试 =========="
$NODE -e "
const fs=require('fs'); const code=fs.readFileSync('index.html','utf8');
const scripts=code.match(/<script[^>]*>([\s\S]*?)<\/script>/gi)||[];
let mi=0,ml=0; scripts.forEach(function(s,i){const js=s.replace(/^<script[^>]*>/,'').replace(/<\/script>$/i,'');if(js.length>ml){ml=js.length;mi=i;}});
fs.writeFileSync('/tmp/check.js',scripts[mi].replace(/^<script[^>]*>/,'').replace(/<\/script>$/i,''));
" 2>/dev/null
if $NODE --check /tmp/check.js 2>/dev/null; then ok "前端JS语法"; else no "前端JS语法-页面会挂!"; fi
if $NODE --check server/server.js 2>/dev/null; then ok "后端JS语法"; else no "后端JS语法"; fi
HTTP=$(curl -s http://localhost:3000/ -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ]; then ok "页面加载200"; else no "页面加载$HTTP"; fi
TOKEN="3d4c1864-7443-40c4-9a4e-1cf54bff366e17b44257d0344b6c8783c0d06a926d71"
CAP=$(curl -s http://localhost:3000/api/captcha 2>/dev/null | $NODE -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.id?'ok':'fail')}catch(e){process.stdout.write('fail')}})" 2>/dev/null)
if [ "$CAP" = "ok" ]; then ok "验证码API"; else no "验证码API"; fi
UD=$(curl -s http://localhost:3000/api/data -H "Authorization: Bearer $TOKEN" 2>/dev/null | $NODE -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.user?'ok':'fail')}catch(e){process.stdout.write('fail')}})" 2>/dev/null)
if [ "$UD" = "ok" ]; then ok "用户数据API"; else no "用户数据API"; fi
ER=$(curl -s http://localhost:3000/api/records/exercise -H "Authorization: Bearer $TOKEN" 2>/dev/null | $NODE -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.records?'ok':'fail')}catch(e){process.stdout.write('fail')}})" 2>/dev/null)
if [ "$ER" = "ok" ]; then ok "做题记录API"; else no "做题记录API"; fi
FC=$($NODE -e "
const fs=require('fs'); const c=fs.readFileSync('index.html','utf8');
const fns=['checkDictation','saveExerciseRecord','showExerciseHistory','renderChinesePage','renderMathPage','renderEnglishPage','saveData','ensureDataFields','getSpellWordList','burstStars','geoAttachTap','renderBuildCubes'];
let a=true;fns.forEach(function(f){if(!new RegExp('function\\\\s+'+f+'\\\\s*\\\\(').test(c)){console.log('MISS:'+f);a=false}});
process.stdout.write(a?'ok':'fail');
" 2>/dev/null)
if [ "$FC" = "ok" ]; then ok "核心函数完整"; else no "核心函数缺失"; fi
HC=$(curl -s http://localhost:3000/ 2>/dev/null | $NODE -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ids=['auth-overlay','page-chinese','page-math','page-english','stars-container'];let ok=true;ids.forEach(function(id){if(d.indexOf(id)===-1)ok=false});process.stdout.write(ok?'ok':'fail')})" 2>/dev/null)
if [ "$HC" = "ok" ]; then ok "HTML结构完整"; else no "HTML结构缺失"; fi
echo ""
echo "========== 结果 =========="
echo "通过:$PASS 失败:$FAIL"
if [ $FAIL -gt 0 ]; then echo "⚠️ 有失败项!"; exit 1; else echo "🎉 全部通过!"; exit 0; fi
