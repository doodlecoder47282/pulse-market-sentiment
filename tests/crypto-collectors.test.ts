import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { parseMintEvidence, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../shared/cryptoSecurity";
import { selectMintBatch, unwrapMintBatch, readBlueskySample, parsePumpCoin,
  ProviderBackoff, createGradeObserver, parseGeckoGradePool } from "../server/cryptoCollectors";
import { ensureCryptoGradeSchema, gradeCryptoBatch, OUTCOME_WINDOW_MS } from "../server/cryptoReliability";

const mint = "3jcc99pP2ND2Rmv2gZYDBb2JiWRuB4d7H11Rhtenpump";
function account() {
  return { context: { slot: 100 }, value: { owner: TOKEN_2022_PROGRAM, executable: false, space: 414,
    data: { program: "spl-token-2022", parsed: { type: "mint", info: {
      isInitialized: true, decimals: 6, supply: "1000000", mintAuthority: null, freezeAuthority: null,
      extensions: [
        { extension: "metadataPointer", state: { authority: null, metadataAddress: mint } },
        { extension: "tokenMetadata", state: { mint, name: "Fixture", symbol: "FIX", uri: "https://example.test/fixture",
          updateAuthority: null, additionalMetadata: [] } },
      ],
    } } } } };
}
test("Token-2022 immutable self-metadata subset is checked without claiming token safety", () => {
  const r = parseMintEvidence(account(), mint);
  assert.equal(r.state, "CHECKED"); assert.equal(r.mintAuthorityActive, false);
  assert.equal(r.freezeAuthorityActive, false); assert.match(r.reason, /remain unverified/);
  assert.equal(parseMintEvidence(account()).state, "UNSUPPORTED");
});
test("Token-2022 transfer/unknown/mutable/identity hazards fail closed", () => {
  for (const extension of ["transferFeeConfig", "transferHook", "permanentDelegate", "pausable", "nonTransferable", "unknownNewExtension"]) {
    const a: any = account(); a.value.data.parsed.info.extensions.push({ extension, state: {} });
    assert.equal(parseMintEvidence(a, mint).state, "UNSUPPORTED", extension);
  }
  for (const field of ["authority", "metadataAddress"]) {
    const a: any = account(); a.value.data.parsed.info.extensions[0].state[field] = "other";
    assert.equal(parseMintEvidence(a, mint).state, "UNSUPPORTED");
  }
  for (const field of ["updateAuthority", "mint"]) {
    const a: any = account(); a.value.data.parsed.info.extensions[1].state[field] = "other";
    assert.equal(parseMintEvidence(a, mint).state, "UNSUPPORTED");
  }
});
test("missing slot, unparsed extensions, duplicate extensions and fake empty extended account are rejected", () => {
  const a: any = account(); delete a.context.slot;
  assert.equal(parseMintEvidence(a, mint).state, "UNKNOWN");
  const b: any = account(); delete b.value.data.parsed.info.extensions;
  assert.equal(parseMintEvidence(b, mint).state, "UNSUPPORTED");
  const c: any = account(); c.value.data.parsed.info.extensions = [];
  assert.equal(parseMintEvidence(c, mint).state, "UNSUPPORTED");
  c.value.space = 82;
  assert.equal(parseMintEvidence(c, mint).state, "CHECKED");
  const d: any = account(); d.value.data.parsed.info.extensions.push(d.value.data.parsed.info.extensions[0]);
  assert.equal(parseMintEvidence(d, mint).state, "UNSUPPORTED");
});
test("original SPL active authorities are not flattened to false", () => {
  const a: any = account(); a.value.owner = SPL_TOKEN_PROGRAM;
  delete a.value.data.parsed.info.extensions;
  a.value.data.parsed.info.mintAuthority = mint;
  assert.equal(parseMintEvidence(a, mint).mintAuthorityActive, true);
  a.value.data.parsed.info.freezeAuthority = false;
  assert.equal(parseMintEvidence(a, mint).state, "UNKNOWN");
});
test("mint batch deduplicates, reserves capacity for old work, and validates ordered response", () => {
  const rows = Array.from({length: 16}, (_, i) => ({tokenAddress: `mint${i}`, securityAttemptAt: i,
    score: i > 8 ? 50 : 1, hardKill: false}));
  const selected = selectMintBatch([...rows, rows[9]]);
  assert.equal(selected.length, 8); assert.equal(new Set(selected.map(c=>c.tokenAddress)).size, 8);
  assert.ok(selected.some(c => c.tokenAddress === "mint0"));
  assert.equal(unwrapMintBatch({context:{slot: 1},value:[null]}, ["m"])[0].mint, "m");
  assert.throws(()=>unwrapMintBatch({context:{slot:1},value:[]}, ["m"]), /invalid/);
});
const now = Date.parse("2026-10-01T08:00:00Z");
const post = (n: number, text = "$TEST research") => ({uri: `at://post/${n}`, author: {did:`did:plc:${n}`},
  record:{text, createdAt:new Date(now-1000).toISOString()}});
test("Bluesky requests a bounded hour, filters cashtag collisions, and treats a true zero as usable", async () => {
  let url = "";
  const r = await readBlueskySample("TEST", mint, now, async u => {url=u;return {posts:[post(1),post(2,"$TESTING"),post(3,"TEST without cashtag")]};});
  assert.equal(new URL(url).searchParams.get("limit"), "100");
  assert.ok(new URL(url).searchParams.has("since"));
  assert.equal(r.mentions1h, 1); assert.equal(r.capped, false);
  const empty = await readBlueskySample("TEST", mint, now, async()=>({posts:[]}));
  assert.equal(empty.mentions1h, 0); assert.equal(empty.timestampsComplete, true);
});
test("Bluesky paginates at most twice and deduplicates posts; exhausted budgets stay partial", async () => {
  let calls=0;
  const r = await readBlueskySample("TEST",mint,now,async u=>{
    calls++;
    if(calls===1)return {posts:Array.from({length:100},(_,i)=>post(i)),cursor:"next"};
    assert.equal(new URL(u).searchParams.get("cursor"),"next");
    return {posts:[post(0),post(101)]};
  });
  assert.equal(calls,2); assert.equal(r.mentions1h,101); assert.equal(r.capped,false);
  calls=0;
  const capped=await readBlueskySample("TEST",mint,now,async()=>({posts:Array.from({length:100},(_,i)=>post(++calls*100+i)),cursor:"more"}));
  assert.equal(capped.capped,true);
});
test("short/non-ASCII symbols use exact mint text; bad timestamps cannot become complete coverage", async () => {
  let q="";
  const r=await readBlueskySample("币",mint,now,async u=>{q=new URL(u).searchParams.get("q")!;return {posts:[post(1,mint),{...post(2),record:{text:mint,createdAt:"bad"}}]};});
  assert.equal(q,mint);assert.equal(r.mentions1h,1);assert.equal(r.timestampsComplete,false);
  await assert.rejects(readBlueskySample("TEST",mint,now,async()=>({error:"denied"})),/Invalid/);
});
test("denied public access backs off for 30 minutes and valid pump zero is distinct from missing", () => {
  const backoff = new ProviderBackoff();
  const r=backoff.failure(new Error("403 denied"), now);
  assert.equal(r.state,"blocked");assert.equal(r.retryAt,now+1800000);assert.equal(backoff.available(now+1000),false);
  assert.match(backoff.snapshot(now+1000)!.reason,/no transport or identity bypass/);
  backoff.success();assert.equal(backoff.available(now),true);
  assert.equal(parsePumpCoin({mint,reply_count:0},mint).replies,0);
  for(const count of [null,undefined,-1,1.5,true]) assert.throws(()=>parsePumpCoin({mint,reply_count:count},mint));
  assert.throws(()=>parsePumpCoin({mint:"other",reply_count:0},mint),/mismatch/);
});
const row = {chain:"solana",pair_address:"pool",token_address:mint};
const gecko = () => ({data:{id:"solana_pool",attributes:{address:"pool",market_cap_usd:"120000",reserve_in_usd:"9000"},
  relationships:{base_token:{data:{id:`solana_${mint}`}}}}});
test("grading exact-pool fallback validates pool AND mint and never promotes FDV", async () => {
  const calls:string[]=[];
  const observe=createGradeObserver(async u=>{calls.push(u);return u.includes("dexscreener")?{pairs:[]}:gecko()},()=>now);
  const r=await observe(row);
  assert.equal(r.mcap,120000);assert.match(r.source!,/GeckoTerminal/);
  await observe(row);assert.equal(calls.length,2);
  const wrong=gecko();wrong.data.relationships.base_token.data.id="solana_other";
  assert.throws(()=>parseGeckoGradePool(wrong,row,now),/identity/);
  const noCap:any=gecko();noCap.data.attributes.market_cap_usd=null;noCap.data.attributes.fdv_usd=1000000;
  assert.equal(parseGeckoGradePool(noCap,row,now).mcap,null);
});
test("grading fallback budget and denial backoff are bounded; missing pools never become zero", async () => {
  let fallback=0;
  const observe=createGradeObserver(async u=>{if(u.includes("geckoterminal")){fallback++;throw Error("404 missing")}return {pairs:null};},()=>now);
  for(let i=0;i<7;i++) await assert.rejects(observe({...row,pair_address:`p${i}`}),/unavailable/);
  assert.equal(fallback,4);
  fallback=0;
  const gate=new ProviderBackoff();
  const denied=createGradeObserver(async u=>{if(u.includes("geckoterminal")){fallback++;throw Error("429 limited")}return {pairs:[]};},()=>now,gate);
  await assert.rejects(denied(row));await assert.rejects(denied({...row,pair_address:"p2"}));
  assert.equal(fallback,1);
});
function dbFixture() {
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE crypto_signals(id TEXT PRIMARY KEY,detected_at INTEGER,chain TEXT,pair_address TEXT,
    mcap_at_signal REAL,liquidity_at_signal REAL,peak_mcap REAL,peak_at INTEGER,last_mcap REAL,last_liquidity REAL,
    outcome TEXT DEFAULT 'OPEN',graded_at INTEGER)`);
  ensureCryptoGradeSchema(db);
  return db;
}
function insert(db:Database.Database,id:string,at:number) {
  db.prepare(`INSERT INTO crypto_signals(id,detected_at,chain,pair_address,mcap_at_signal,liquidity_at_signal)
    VALUES (?,?,'solana','p',100000,10000)`).run(id,at);
}
test("grading partials are counted, source is persisted, duplicates do not inflate samples", async () => {
  const db=dbFixture();insert(db,"p",now-1000);
  const observe=async()=>({mcap:120000,liq:null,observedAt:now,source:"fixture exact pool"});
  const r=await gradeCryptoBatch(db,observe,()=>now);assert.equal(r.partial,1);
  const again=await gradeCryptoBatch(db,observe,()=>now+1);assert.equal(again.duplicate,1);
  const saved:any=db.prepare("SELECT * FROM crypto_signals").get();
  assert.equal(saved.observed_samples,1);assert.equal(saved.last_observed_at,null);
  assert.equal(saved.last_observation_source,"fixture exact pool");db.close();
});
test("grading backoff does not starve expiry and unknown windows are excluded from wins/losses", async () => {
  const db=dbFixture();insert(db,"p",now-1000);
  await gradeCryptoBatch(db,async()=>{throw Error("missing")},()=>now);
  const held=await gradeCryptoBatch(db,async()=>{throw Error("must not call")},()=>now+1);
  assert.equal(held.selected,0);assert.equal(held.deferred,1);
  const ended=await gradeCryptoBatch(db,async()=>{throw Error("must not fetch late price")},()=>now+OUTCOME_WINDOW_MS);
  assert.equal(ended.unobservable,1);db.close();
});
test("a fresh closing sample cannot erase a long historical collection gap", async () => {
  const db=dbFixture();const start=now-OUTCOME_WINDOW_MS;insert(db,"p",start);
  db.prepare(`UPDATE crypto_signals SET first_observed_at=?,last_observed_at=?,max_observation_gap_ms=?,
    observed_samples=10,peak_mcap=110000`).run(start+1000,now-1000,3600000);
  const r=await gradeCryptoBatch(db,async()=>{throw Error("no late read")},()=>now+1);
  assert.equal(r.unobservable,1);assert.equal((db.prepare("SELECT outcome FROM crypto_signals").get() as any).outcome,"UNOBSERVABLE");
  db.close();
});
