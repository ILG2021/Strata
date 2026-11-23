import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativeSettings,publicNativeEnv,restoreNativeEnv} from '../server/native-settings.mjs';
import {validateChatImages} from '../server/chat-images.mjs';
test('native settings reject invalid ranges and unmanaged network arguments',()=>{
 assert.deepEqual(validateNativeSettings({parallel:2,layer_split:'16,32',reasoning_budget_tokens:null,sampling:{temperature:.7}}),{parallel:2,layer_split:'16,32',reasoning_budget_tokens:null,sampling:{temperature:.7}});
 for(const value of [{parallel:0},{parallel:1.2},{layer_split:'32,16'},{layer_split:'48'},{exe:'/tmp/program'},{args:['--host','0.0.0.0']},{env:{HOME:'/tmp'}},{sampling:{top_p:2}},{anthropic_thinking:'always'}])assert.throws(()=>validateNativeSettings(value));
});
test('environment masks preserve credentials and unrelated existing configuration',()=>{
 const previous={PATH:'/native/bin',STRATA_API_KEY:'private',STRATA_PREFILL:'2'};
 assert.deepEqual(publicNativeEnv(previous),{STRATA_API_KEY:'••••••••',STRATA_PREFILL:'2'});
 assert.deepEqual(restoreNativeEnv({STRATA_API_KEY:'••••••••',STRATA_PREFILL:'3'},previous),{...previous,STRATA_PREFILL:'3'});
 assert.throws(()=>restoreNativeEnv({STRATA_TOKEN:'••••••••'}));
});
test('chat accepts bounded attached images and rejects remote or oversized image payloads',()=>{
 const photo={name:'photo.png',url:'data:image/png;base64,aGVsbG8='};assert.deepEqual(validateChatImages([photo]),[photo]);
 assert.throws(()=>validateChatImages([{url:'https://private.test/image.png'}]));assert.throws(()=>validateChatImages(Array(5).fill(photo)));assert.throws(()=>validateChatImages([{url:'data:image/png;base64,'+Buffer.alloc(6*1024*1024+1).toString('base64')}]));
});
