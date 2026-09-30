import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { finiteNonnegative, ensureCryptoGradeSchema, gradeCryptoBatch, OUTCOME_WINDOW_MS } from "../server/cryptoReliability";
import { cryptoAuditStats } from "../server/cryptoAuditStats";

function fixture() {
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE crypto_signals(id TEXT PRIMARY KEY,detected_at INTEGER,chain TEXT,
    pair_address TEXT,mcap_at_signal REAL,liquidity_at_signal REAL,peak_mcap REAL,peak_at INTEGER,
    last_mcap REAL,last_liquidity REAL,outcome TEXT DEFAULT 'OPEN',graded_at INTEGER)`);
  ensureCryptoGradeSchema(db); ensureCryptoGradeSchema(db);
  return db;
}
const insert=(db:any,id:string,at:number)=>db.prepare(`INSERT INTO crypto_signals
  (id,detected_at,chain,pair_address,mcap_at_signal,liquidity_at_signal) VALUES (?,?,'solana',?,100000,10000)`).run(id,at,id);

test("numeric parsing preserves observed zero and rejects missing/nonfinite values",()=>{
  for(const value of [null,undefined,"",NaN,Infinity,-1,true]) assert.equal(finiteNonnegative(value),null);
  assert.equal(finiteNonnegative(0),0); assert.equal(finiteNonnegative("0"),0);
});
test("fair queue advances failures, bounds concurrent requests, and excludes unknowns from calibration",async()=>{
  const db=fixture(), now=Date.now(); let active=0,max=0;
  for(let i=0;i<75;i++)insert(db,String(i).padStart(3,"0"),now-1000);
  const fail=async()=>{active++; max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;throw Error("offline")};
  const first=await gradeCryptoBatch(db,fail,()=>now);
  assert.equal(first.selected,60); assert.equal(first.unavailable,60); assert.ok(max<=4);
  await gradeCryptoBatch(db,async()=>({mcap:110000,liq:10000,observedAt:now+1}),()=>now+1);
  assert.equal((db.prepare("SELECT count(*) n FROM crypto_signals WHERE last_checked_at IS NULL").get() as any).n,0);
  assert.equal((db.prepare("SELECT grade_attempts FROM crypto_signals WHERE id='074'").get() as any).grade_attempts,1);
  db.close();
});
test("expired coverage gaps close as UNOBSERVABLE without fetching a late price",async()=>{
  const db=fixture(),now=Date.now();insert(db,"expired",now-OUTCOME_WINDOW_MS-1);
  const result=await gradeCryptoBatch(db,async()=>{throw Error("must not fetch")},()=>now);
  assert.equal(result.unobservable,1);
  assert.equal(cryptoAuditStats(db).unobservable,1);assert.equal(cryptoAuditStats(db).graded,0);
  db.close();
});
test("zero liquidity can grade rug with missing cap; peak timestamp preserved; wrong-age observations fail",async()=>{
  const db=fixture(),now=Date.now();
  for(const id of ["zero","peak","stale"])insert(db,id,now-3600_000);
  db.prepare("UPDATE crypto_signals SET peak_mcap=300000,peak_at=? WHERE id='peak'").run(now-1000);
  const result=await gradeCryptoBatch(db,async r=>r.id==="zero"?{mcap:null,liq:0,observedAt:now}:
    {mcap:200000,liq:10000,observedAt:r.id==="stale"?now-3600_000:now},()=>now);
  assert.equal(result.observed,2);assert.equal(result.unavailable,1);
  assert.equal((db.prepare("SELECT outcome FROM crypto_signals WHERE id='zero'").get() as any).outcome,"RUGGED");
  assert.equal((db.prepare("SELECT peak_at FROM crypto_signals WHERE id='peak'").get() as any).peak_at,now-1000);
  db.close();
});
test("covered final window resolves sampled doubled/dead outcomes",async()=>{
  const db=fixture(),now=Date.now(),detected=now-OUTCOME_WINDOW_MS-1000;
  for(const id of ["double","dead"]) {
    insert(db,id,detected);
    db.prepare("UPDATE crypto_signals SET last_observed_at=?,observed_samples=3,peak_mcap=? WHERE id=?")
      .run(now-60000,id==="double"?250000:110000,id);
  }
  await gradeCryptoBatch(db,async()=>{throw Error("not needed")},()=>now);
  assert.equal((db.prepare("SELECT outcome FROM crypto_signals WHERE id='double'").get() as any).outcome,"DOUBLED");
  assert.equal((db.prepare("SELECT outcome FROM crypto_signals WHERE id='dead'").get() as any).outcome,"DEAD");
  db.close();
});
test("engine lock prevents overlap; discovery validates failures and recovers immediately",async()=>{
  const contents=readFileSync("server/cryptoEngine.ts","utf8")+
    "\nexport {runEngine,scannerTick,hb,tracked,scoreCandidate};";
  const output=await build({stdin:{contents,resolveDir:process.cwd()+"/server",loader:"ts"},bundle:true,
    platform:"node",format:"esm",write:false,plugins:[{name:"db-fixture",setup(b){
      b.onResolve({filter:/^\.\/storage$/},args=>({path:args.path,namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},()=>({loader:"js",contents:"export const sqlite={exec(){},prepare(){return {all(){return []},run(){},get(){return {}}}}};"}));
    }}]});
  const engine=await import("data:text/javascript;base64,"+Buffer.from(output.outputFiles[0].text).toString("base64"));
  let release:any;const task=new Promise<void>(r=>release=r);
  const first=engine.runEngine("fixture",1000,()=>task);
  await engine.runEngine("fixture",1000,()=>{throw Error("overlap")});
  assert.equal(engine.hb("fixture",1000).skippedOverlaps,1);release();await first;
  const old=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({invalid:true}),{status:200});
    await engine.runEngine("scanner",60000,engine.scannerTick);
    assert.equal(engine.getCryptoHealth().engines.find((h:any)=>h.name==="scanner").status,"error");
    globalThis.fetch=async()=>new Response(JSON.stringify({data:[]}),{status:200});
    await engine.runEngine("scanner",60000,engine.scannerTick);
    assert.equal(engine.getCryptoHealth().engines.find((h:any)=>h.name==="scanner").status,"ok");
    globalThis.fetch=async input=>String(input).includes("new_pools")
      ?new Response("blocked",{status:429}):new Response(JSON.stringify({data:[]}),{status:200});
    await engine.runEngine("scanner",60000,engine.scannerTick);
    assert.equal(engine.getCryptoHealth().engines.find((h:any)=>h.name==="scanner").status,"degraded");
    engine.tracked.set("old",{lastRefreshAt:Date.now()-600000,verdict:"ENTER",risk:{},score:90});
    assert.equal(engine.getCryptoFeed().candidates[0].verdict,"PASS");
  } finally {globalThis.fetch=old;}
});
